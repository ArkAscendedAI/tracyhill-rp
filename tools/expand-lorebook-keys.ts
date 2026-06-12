#!/usr/bin/env -S node --import tsx
import path from "node:path";

import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../apps/api/src/domain/context/lorebookRepository";
import { CustomEndpointRepository } from "../apps/api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../apps/api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../apps/api/src/domain/providerKeys/providerKeyRuntime";
import { resolveChatModelConfig } from "../apps/api/src/domain/providerKeys/chatModelConfig";
import { initEncryptionKey } from "../apps/api/src/lib/crypto";

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
}

const campaignId = arg("campaign");
const userId = arg("user", "admin");
const modelId = arg("model", "claude-haiku-4-5-20251001");
const dbPath = arg("db") || process.env.DB_FILE || path.resolve(process.cwd(), "data/v2/tracyhill-rp-v2.sqlite");
const limit = parseInt(arg("limit", "0") || "0", 10);
const concurrency = parseInt(arg("concurrency", "5") || "5", 10);
const dryRun = process.argv.includes("--dry-run");

if (!campaignId || !userId) {
  console.error("Usage: expand-lorebook-keys --campaign <id> --user <userId> [--model <id>] [--db <path>] [--limit N] [--concurrency N] [--dry-run]");
  process.exit(1);
}

const runtimeDefaults = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  claudeCodeBridgeUrl: process.env.CLAUDE_CODE_BRIDGE_URL ?? "",
  claudeCodeBridgeSecret: process.env.CLAUDE_CODE_BRIDGE_SECRET ?? "",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  googleApiKey: process.env.GOOGLE_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  xaiApiKey: process.env.XAI_API_KEY ?? "",
  zaiApiKey: process.env.ZAI_API_KEY ?? "",
};

console.log(`Expanding lorebook keys`);
console.log(`  DB:         ${dbPath}`);
console.log(`  Campaign:   ${campaignId}`);
console.log(`  User:       ${userId}`);
console.log(`  Model:      ${modelId}`);
console.log(`  Limit:      ${limit || "no limit"}`);
console.log(`  Concurrency:${concurrency}`);
console.log(`  Dry run:    ${dryRun}`);

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error("SESSION_SECRET env var required to decrypt provider keys");
  process.exit(1);
}
initEncryptionKey(sessionSecret);

migrateDatabase(dbPath);
const { db } = createDatabaseClient(dbPath);
const lorebook = new LorebookRepository(db);
const providerKeys = new ProviderKeyRepository(db);
const customEndpoints = new CustomEndpointRepository(db);

const runtime = createChatRuntimeForUser(providerKeys, customEndpoints, userId, runtimeDefaults);
if (!runtime) {
  console.error("No chat runtime available for user " + userId);
  process.exit(1);
}

const resolved = resolveChatModelConfig(customEndpoints, userId, modelId)?.id ?? modelId;
console.log(`  Resolved:   ${resolved}`);

const allEntries = lorebook.listEnabledForCampaign(userId, campaignId);
const toProcess = limit > 0 ? allEntries.slice(0, limit) : allEntries;
console.log(`\nFound ${allEntries.length} enabled entries, processing ${toProcess.length}\n`);

async function expandOne(entry: any, idx: number): Promise<{ added: number; total: number } | null> {
  let existingKeys: string[] = [];
  try { existingKeys = JSON.parse(entry.keys || "[]") as string[]; } catch {}
  if (existingKeys.length >= 20) {
    return { added: 0, total: existingKeys.length };
  }
  try {
    const prompt = `For the lorebook entry below, generate 5-10 additional keywords that someone might use to reference this content. Include: synonyms, alternate phrasings, related terms, common vocabulary variants. EXCLUDE any word already in the existing keys list. Keep keys short (1-3 words each). Output JSON only: {"keys": ["word1", "word2", ...]}.\n\n<entry_name>${entry.name}</entry_name>\n<existing_keys>${existingKeys.join(", ") || "(none)"}</existing_keys>\n<content_excerpt>${(entry.content || "").slice(0, 400)}</content_excerpt>`;
    let responseText = "";
    await runtime!.streamChat({
      modelId: resolved,
      systemPrompt: "You are a retrieval-keyword generator. Output JSON only, no prose.",
      messages: [{ role: "user", content: prompt, attachments: [] }],
      temperature: 0.3,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      requestId: `backfill-${entry.id}`,
    }, {
      onStart: () => {},
      onDelta: (delta) => { responseText += delta; },
      onThinkingDelta: () => {},
      onComplete: () => {},
    });
    const match = responseText.match(/\{[\s\S]*"keys"[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { keys: unknown };
    if (!Array.isArray(parsed.keys)) return null;
    const newKeys = parsed.keys
      .filter((k): k is string => typeof k === "string" && k.trim().length > 0 && k.trim().length < 60)
      .map(k => k.trim())
      .filter(k => !existingKeys.some(e => e.toLowerCase() === k.toLowerCase()));
    if (newKeys.length === 0) return { added: 0, total: existingKeys.length };
    const merged = [...existingKeys, ...newKeys].slice(0, 20);
    if (!dryRun) {
      lorebook.update(userId!, entry.id, { keys: JSON.stringify(merged), updatedAt: new Date().toISOString() } as any);
    }
    return { added: merged.length - existingKeys.length, total: merged.length };
  } catch (err) {
    console.error(`  [${idx}] ${entry.name}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

(async () => {
  let processed = 0;
  let totalAdded = 0;
  let totalErrors = 0;
  let totalSkipped = 0;
  const start = Date.now();

  for (let i = 0; i < toProcess.length; i += concurrency) {
    const batch = toProcess.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((e, j) => expandOne(e, i + j)));
    for (let j = 0; j < batch.length; j++) {
      const e = batch[j];
      const r = results[j];
      processed++;
      if (!r) { totalErrors++; continue; }
      if (r.added === 0) { totalSkipped++; continue; }
      totalAdded += r.added;
      console.log(`  [${processed}/${toProcess.length}] ${e.name}: +${r.added} (total ${r.total})`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone. Processed ${processed}, added ${totalAdded} keys total, ${totalSkipped} no-changes, ${totalErrors} errors in ${elapsed}s.`);
  if (dryRun) console.log("(DRY RUN — no DB writes)");
  process.exit(0);
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
