#!/usr/bin/env -S node --import tsx
import { createHash } from "node:crypto";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import { createDatabaseClient, migrateDatabase, lorebookEntryEmbeddings } from "@tracyhill-rp/db";

import { LorebookRepository } from "../apps/api/src/domain/context/lorebookRepository";
import { LorebookEmbeddingRepository } from "../apps/api/src/domain/context/lorebookEmbeddingRepository";
import { CampaignRepository } from "../apps/api/src/domain/campaigns/campaignRepository";
import { ProviderKeyRepository } from "../apps/api/src/domain/providerKeys/providerKeyRepository";
import { EmbeddingService, OpenAIEmbeddingProvider, GoogleEmbeddingProvider, type EmbeddingProvider } from "../apps/api/src/domain/context/embeddingService";
import { initEncryptionKey } from "../apps/api/src/lib/crypto";

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
}

const campaignId = arg("campaign");
const userId = arg("user");
const modelArg = arg("model", "google:gemini-embedding-2")!;
const dbPath = arg("db") || process.env.DB_FILE || path.resolve(process.cwd(), "data/v2/tracyhill-rp-v2.sqlite");
const dryRun = process.argv.includes("--dry-run");

if (!campaignId || !userId) {
  console.error("Usage: reembed-stale-threads --campaign <id> --user <userId> [--model <id>] [--db <path>] [--dry-run]");
  process.exit(1);
}

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error("SESSION_SECRET env var required to decrypt provider keys");
  process.exit(1);
}
initEncryptionKey(sessionSecret);

migrateDatabase(dbPath);
const { db } = createDatabaseClient(dbPath);

const lorebook = new LorebookRepository(db);
const embeddings = new LorebookEmbeddingRepository(db);
const campaigns = new CampaignRepository(db);
const providerKeys = new ProviderKeyRepository(db);

// Indexing must use the campaign's authoritative embedding model so the vectors
// land under the same model key that per-turn retrieval queries against. Resolve
// from context_defaults_json; fall back to --model only if unset.
let model = modelArg;
const campaign = campaigns.findById(userId, campaignId);
if (campaign?.contextDefaultsJson) {
  try {
    const cd = JSON.parse(campaign.contextDefaultsJson) as { embeddingModel?: string };
    if (cd.embeddingModel) model = cd.embeddingModel;
  } catch { /* keep modelArg */ }
}

const providers = new Map<string, EmbeddingProvider>();
if (process.env.OPENAI_API_KEY) providers.set("openai", new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY));
if (process.env.GOOGLE_API_KEY) providers.set("google", new GoogleEmbeddingProvider(process.env.GOOGLE_API_KEY));
const embedding = new EmbeddingService(embeddings, providers, providerKeys);

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isStale(e: { id: string; content: string | null; updatedAt?: string }): boolean {
  const row = embeddings.findByEntryAndModel(e.id, model);
  if (!row) return true;
  if (hashContent(e.content || "") !== row.contentHash) return true;
  return Boolean(e.updatedAt && row.createdAt && e.updatedAt > row.createdAt);
}

console.log(`Re-embed stale lorebook vectors`);
console.log(`  DB:        ${dbPath}`);
console.log(`  Campaign:  ${campaignId}`);
console.log(`  User:      ${userId}`);
console.log(`  Model:     ${model}${model === modelArg ? "" : "  (from campaign context_defaults_json)"}`);
console.log(`  Dry run:   ${dryRun}`);

const entries = lorebook.listEnabledForCampaign(userId, campaignId) as Array<{
  id: string; userId: string; content: string | null; updatedAt?: string; tag?: string | null; name?: string | null; isConstant?: number | null;
}>;
console.log(`\nEnabled entries: ${entries.length}`);

const stale = entries.filter(isStale);
// Constant entries (e.g. the always-in-context Thread Index) are never semantically
// retrieved, and the thread-tracker worker rewrites the index content every run without
// re-embedding it — so a vector on a constant is always-stale dead weight. Re-embed the
// retrievable threads; drop the constant's stale vector (model-scoped) so the status
// settles to a stable 0-stale (the constant reads as intentionally not-indexed/missing).
const staleConstants = stale.filter(e => Boolean(e.isConstant));
const staleRetrievable = stale.filter(e => !e.isConstant);

const byTag: Record<string, number> = {};
for (const e of stale) byTag[e.tag || "(none)"] = (byTag[e.tag || "(none)"] || 0) + 1;
console.log(`Stale total: ${stale.length}  (re-embed ${staleRetrievable.length} retrievable, drop vector on ${staleConstants.length} constant)`);
console.log(`  By tag: ${JSON.stringify(byTag)}`);
for (const e of staleRetrievable) console.log(`   re-embed [${e.tag ?? "(none)"}] ${e.name ?? "(unnamed)"} (${e.id})`);
for (const e of staleConstants) console.log(`   drop-vec [${e.tag ?? "(none)"}] ${e.name ?? "(unnamed)"} (${e.id})  [constant]`);

if (dryRun) {
  console.log(`\n(DRY RUN — no embeddings written, no vectors dropped)`);
  process.exit(0);
}

if (stale.length === 0) {
  console.log(`\nNothing to do.`);
  process.exit(0);
}

const start = Date.now();
let indexed = 0;
if (staleRetrievable.length) {
  const toIndex = staleRetrievable.map(e => ({ id: e.id, userId: e.userId, content: e.content || "" }));
  indexed = await embedding.indexEntries(toIndex, model);
}
let dropped = 0;
for (const e of staleConstants) {
  const row = embeddings.findByEntryAndModel(e.id, model);
  if (!row) continue;
  db.delete(lorebookEntryEmbeddings)
    .where(and(eq(lorebookEntryEmbeddings.entryId, e.id), eq(lorebookEntryEmbeddings.model, model)))
    .run();
  dropped++;
}
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nRe-embedded ${indexed}/${staleRetrievable.length} retrievable, dropped ${dropped} constant vector(s) under ${model} in ${elapsed}s.`);

const remaining = staleRetrievable.filter(e => {
  const row = embeddings.findByEntryAndModel(e.id, model);
  return !row || hashContent(e.content || "") !== row.contentHash;
});
console.log(`Retrievable still stale (hash mismatch): ${remaining.length}`);
for (const e of remaining) console.log(`   ! [${e.tag ?? "(none)"}] ${e.name ?? "(unnamed)"} (${e.id})`);
process.exit(0);
