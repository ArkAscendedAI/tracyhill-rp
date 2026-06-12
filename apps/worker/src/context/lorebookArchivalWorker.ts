import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { EmbeddingService, OpenAIEmbeddingProvider, GoogleEmbeddingProvider, type EmbeddingProvider } from "../../../api/src/domain/context/embeddingService";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { createId } from "../../../api/src/lib/ids";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";

const DEFAULT_EMBED_MODEL = "openai:text-embedding-3-large";
const MAX_ARCHIVAL_BATCH = 20;
const MIN_TURNS_INACTIVE = 500;
const MIN_AGE_MS = 72 * 60 * 60 * 1000; // entries must exist 72h before archival eligibility

const ARCHIVAL_SYSTEM = `You are a lorebook archivist for an ongoing roleplay campaign. You will receive a batch of lorebook entries that have been inactive for many turns and are candidates for archival.

Your job is to create a single COMPRESSED TRIGGER entry for each group of related entries. The trigger is a retrieval index — it must contain enough detail that keyword search, semantic search, and an LLM researcher can find it when relevant, but it is NOT meant to be used as narrative context directly.

For each entry or natural group of closely related entries, produce a compressed trigger with:
- name: A descriptive title (e.g. "Marcus's first day — saves Willow from vampire attack")
- tag: "archived"
- synopsis: A 1-3 sentence summary capturing WHO, WHAT, WHERE, WHEN and distinctive details. Include unique keywords and character names for retrieval.
- keys: Union of all trigger keywords from the source entries, plus any additional distinctive terms from the content
- known_by: Union of known_by from all source entries (null if any source is global)

Output ONLY a JSON array of archival operations:
[
  {
    "op": "ARCHIVE",
    "source_ids": ["id1", "id2"],
    "name": "Descriptive trigger title",
    "synopsis": "1-3 sentence retrieval-grade summary with distinctive details...",
    "keys": ["key1", "key2", "key3"],
    "known_by": ["Character1"] or null
  }
]

Rules:
- NEVER discard information that would make the cold entries unfindable
- Include character names, location names, and distinctive nouns in keys
- The synopsis should contain enough unique detail that semantic search can match it to relevant queries
- Group entries ONLY if they describe the same event or scene — don't over-group
- If an entry should NOT be archived (still seems important), use: {"op": "SKIP", "entry_id": "...", "reason": "..."}`;

interface ArchivalOp {
  op: "ARCHIVE" | "SKIP";
  source_ids?: string[];
  entry_id?: string;
  name?: string;
  synopsis?: string;
  keys?: string[];
  known_by?: string[] | null;
  reason?: string;
}

export class LorebookArchivalWorker {
  private readonly logger = createLogger("lorebook-archival-worker");
  private readonly lorebook;
  private readonly runs;
  private readonly messages;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly embedding;
  private readonly runtime;
  private readonly runtimeDefaults;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.lorebook = new LorebookRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.messages = new MessageRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", claudeCodeBridgeUrl: "", claudeCodeBridgeSecret: "", deepseekApiKey: "", googleApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "" };
    const providers = new Map<string, EmbeddingProvider>();
    if (this.runtimeDefaults.openaiApiKey) providers.set("openai", new OpenAIEmbeddingProvider(this.runtimeDefaults.openaiApiKey));
    if (this.runtimeDefaults.googleApiKey) providers.set("google", new GoogleEmbeddingProvider(this.runtimeDefaults.googleApiKey));
    this.embedding = new EmbeddingService(new LorebookEmbeddingRepository(db), providers, this.providerKeys);
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }) {
    const now = new Date().toISOString();
    try {
      const details = run.detailsJson ? JSON.parse(run.detailsJson) as { archivalModel?: string; embeddingModel?: string } : {};
      const embedModelId = details.embeddingModel || DEFAULT_EMBED_MODEL;

      // Find entries that are enabled, non-constant, have never activated or haven't activated in MIN_TURNS_INACTIVE turns
      const allEntries = this.lorebook.listForCampaign(run.userId, run.campaignId, {
        isEnabled: true, isConstant: false, sort: "last_reviewed_at", order: "asc", limit: 500,
      });

      // Skip entries that are already compressed triggers
      const candidates = allEntries.filter(e => !e.compressedRefIds);

      const activationState = this.lorebook.getActivationState(run.sessionId ?? "");
      const activationMap = new Map(activationState.map(s => [s.entryId, s.lastActivatedTurn]));
      // currentTurn = approximate session turn count (~half of message rows,
      // matching the rollingDiffWorker convention). Previously this computed
      // lorebook.countForCampaign(), which returned the lorebook entry count,
      // not the session turn count — leading to staleness gates that fired
      // against the wrong reference and SHRANK as entries got archived.
      const sessionMessageCount = run.sessionId
        ? (() => { try { return this.messages.listForSession(run.userId, run.sessionId!).length; } catch { return 0; } })()
        : 0;
      const currentTurn = Math.max(Math.floor(sessionMessageCount / 2) + 1, 1);

      // Select entries that haven't been activated in a long time AND have existed long enough
      const stale = candidates.filter(e => {
        const ageMs = Date.now() - new Date(e.createdAt).getTime();
        if (ageMs < MIN_AGE_MS) return false;
        const lastTurn = activationMap.get(e.id);
        if (lastTurn == null) {
          // Never activated IN THIS SESSION — activation state is per-session,
          // so this is weak evidence. Require the entry itself to be untouched
          // for 7 days instead of treating it as instantly archival-eligible
          // (a fresh session used to make all older event entries candidates).
          const idleMs = Date.now() - new Date(e.updatedAt ?? e.createdAt).getTime();
          return idleMs >= 7 * 24 * 60 * 60 * 1000;
        }
        return (currentTurn - lastTurn) >= MIN_TURNS_INACTIVE;
      });

      // Persistent world-building tags — never archive. "threads" is included: a pending
      // thread that hasn't surfaced in many turns is still pending and must stay retrievable.
      // (The thread tracker re-tags genuinely concluded threads off "threads" itself.)
      const PROTECTED_TAGS = new Set(["characters", "locations", "factions", "lore", "rules", "capabilities", "traits", "relationships", "threads"]);
      const archivable = stale.filter(e => !PROTECTED_TAGS.has(e.tag ?? ""));

      if (archivable.length === 0) {
        this.runs.markCompleted(run.id, now, "No entries eligible for archival", JSON.stringify({ candidates: 0, archived: 0 }));
        this.runs.updateRun(run.id, { approvedAt: now });
        return;
      }

      const batch = archivable.slice(0, MAX_ARCHIVAL_BATCH);

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      const modelId = resolveChatModelConfig(this.customEndpoints, run.userId, details.archivalModel || "claude-haiku-4-5-bridge")?.id ?? "claude-haiku-4-5-bridge";

      const entriesText = batch.map(e => {
        const keys = (() => { try { return JSON.parse(e.keys); } catch { return []; } })();
        const lastTurn = activationMap.get(e.id);
        return `[${e.id}] ${e.name} (${e.tag ?? "untagged"})\nKeys: ${keys.join(", ") || "none"}\nKnown by: ${e.knownBy ?? "global"}\nLast activated: ${lastTurn != null ? `turn ${lastTurn} (${currentTurn - lastTurn} turns ago)` : "never"}\nContent: ${e.content}`;
      }).join("\n\n---\n\n");

      let responseText = "";
      await runtime.streamChat({
        modelId,
        systemPrompt: ARCHIVAL_SYSTEM,
        messages: [{ role: "user", content: `current_turn=${currentTurn}\n\n<entries_to_archive>\n${entriesText}\n</entries_to_archive>`, attachments: [] }],
        temperature: 0,
        thinkingMode: "off",
        thinkingBudget: null,
        effort: null,
        cacheTtl: "off",
        requestId: `archival-${run.id}`,
      }, {
        onStart: () => {},
        onDelta: (delta) => { responseText += delta; },
        onThinkingDelta: () => {},
        onComplete: () => {},
      });

      const ops = this.parseOps(responseText);
      const { archived, skipped } = this.applyOps(run.userId, run.campaignId, ops, batch);

      // Embed the new compressed triggers
      if (archived > 0) {
        // Fetch a generous window then filter to compressed triggers — the old
        // limit-before-filter could evict fresh triggers whenever a concurrent
        // edit bumped another entry's updated_at into the window.
        const compressedEntries = this.lorebook.listForCampaign(run.userId, run.campaignId, {
          isEnabled: true, sort: "updated_at", order: "desc", limit: Math.max(archived * 4, 32),
        }).filter(e => e.compressedRefIds).slice(0, archived);
        if (compressedEntries.length > 0) {
          await this.embedding.indexEntries(
            compressedEntries.map(e => ({ id: e.id, userId: run.userId, content: e.content })),
            embedModelId,
          ).catch((err) => this.logger.warn({ runId: run.id, err }, "post-archival trigger embed failed — vectors stale until backfill"));
        }
      }

      const doneAt = new Date().toISOString();
      this.runs.markCompleted(run.id, doneAt,
        `Archival: ${archived} compressed, ${skipped} skipped (${batch.length} candidates)`,
        JSON.stringify({ candidates: archivable.length, batched: batch.length, archived, skipped, modelId }),
      );
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "archival failed", null);
    }
  }

  private parseOps(text: string): ArchivalOp[] {
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((op: any) => op && typeof op.op === "string");
    } catch { return []; }
  }

  private applyOps(userId: string, campaignId: string, ops: ArchivalOp[], batch: any[]): { archived: number; skipped: number } {
    const now = new Date().toISOString();
    const batchIds = new Set(batch.map((e: any) => e.id));
    let archived = 0;
    let skipped = 0;

    for (const op of ops) {
      if (op.op === "SKIP") { skipped++; continue; }
      if (op.op !== "ARCHIVE" || !op.source_ids?.length || !op.name || !op.synopsis) continue;

      // Validate all source IDs are in our batch
      const validSources = op.source_ids.filter(id => batchIds.has(id));
      if (validSources.length === 0) continue;

      // Create the compressed trigger entry
      const triggerId = createId();
      const triggerContent = op.synopsis;
      const keyUnion = op.keys ?? [];

      this.lorebook.create({
        id: triggerId,
        userId,
        campaignId,
        name: op.name,
        tag: "archived",
        content: triggerContent,
        comment: `compressed trigger for ${validSources.length} cold entries`,
        keys: JSON.stringify(keyUnion),
        keysSecondary: "[]",
        selectiveLogic: "and_any",
        scanDepth: 4,
        position: "before_main",
        insertionOrder: 100,
        probability: 100,
        isConstant: 0,
        isEnabled: 1,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        excludeRecursion: 0,
        preventRecursion: 0,
        delayUntilRecursion: 0,
        tokensEstimate: estimateTokens(triggerContent),
        knownBy: op.known_by ? JSON.stringify(op.known_by) : null,
        matchOptionsJson: null,
        legacySource: null,
        compressedRefIds: JSON.stringify(validSources),
        createdAt: now,
        updatedAt: now,
      });

      // Disable the source entries (move to cold storage) — embeddings are preserved
      this.lorebook.bulkSetEnabled(userId, validSources, false);

      archived++;
    }

    return { archived, skipped };
  }
}
