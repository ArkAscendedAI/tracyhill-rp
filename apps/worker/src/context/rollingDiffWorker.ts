import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { PipelineRunRepository, parsePipelineRunDetails } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { EmbeddingService, OpenAIEmbeddingProvider, GoogleEmbeddingProvider, type EmbeddingProvider } from "../../../api/src/domain/context/embeddingService";
import { createId } from "../../../api/src/lib/ids";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";

const DEFAULT_EMBED_MODEL = "openai:text-embedding-3-large";

const ROLLING_DIFF_SYSTEM = `You are maintaining the canonical lorebook for an ongoing roleplay campaign. The lorebook records every character, location, faction, event, and persistent fact. You will read the most recent turns and emit a list of CRUD operations on the lorebook so it stays current.

Each message is annotated with scene_state showing who was physically present. Use this to set known_by on entries that record private knowledge.

IMPORTANT — Duplicate Prevention:
Before issuing a CREATE, carefully check the <existing_entries> list. If an entry already covers the same topic, character detail, location, or event — UPDATE that entry instead of creating a new one. Duplicates waste context budget and degrade retrieval quality. Look for:
- Entries with the same or similar names
- Entries whose content already covers what you would write
- Entries that could be expanded to include the new information

Tag taxonomy (choose carefully — tag determines lifecycle):
- "characters" — persistent world-building: a person, named NPC, or player character. Never archived.
- "locations" — persistent world-building: places, buildings, regions. Never archived.
- "factions" — persistent world-building: groups, organizations, governments. Never archived.
- "capabilities" — STABLE ABILITIES, divine powers, magical skills, technical competencies that a character can repeatedly use (e.g. "Marcus can conjure food from nothing", "Willow can cast Somnium Lenis"). Never archived.
- "traits" — STABLE PERSONALITY/BEHAVIOR PATTERNS that recur across scenes (e.g. "Marcus is pathologically possessive", "Cordelia uses command voice when nervous"). Never archived.
- "relationships" — STABLE DYNAMICS between characters (e.g. "Buffy and Cordelia's emerging friendship", "Marcus-Willow mentor pattern"). Never archived.
- "rules" — meta-rules, relationship governance, protocols (e.g. "honesty at all costs", "no surprise public reveals"). Never archived.
- "lore" — world facts, history, mythology, terminology that exists in-universe. Never archived.
- "events" — a SPECIFIC MOMENT in time: a scene, conversation, decision, or one-time occurrence. CAN be archived once stale.
- "threads" — RESERVED for the automated thread tracker (pending quests/operations/plot threads). NEVER create, modify, or disable "threads" entries — they are owned by a separate worker.

CRITICAL: a capability or trait is what a character IS or CAN DO across all scenes. An event is what HAPPENED in one scene. The same fact can appear in BOTH: an event entry captures "Marcus conjured Cuban food on Sept 16"; a capability entry captures "Marcus can conjure food from nothing (divine ability)". The capability is queryable for any future scene; the event is a specific moment.

Operations:
- CREATE: a new entry (only when no existing entry covers this topic). Provide name, tag, content, keys (array of trigger words), and known_by.
  - known_by: JSON array of character names who witnessed or were told this information. Use null for global/world knowledge (locations, lore, rules, character descriptions, capabilities, traits). Use specific names for events, conversations, or discoveries that only certain characters witnessed.
- UPDATE: edit an existing entry. Provide entry_id, content, and optionally known_by (if knowledge has spread to new characters).
- DISABLE: soft-disable an entry that is no longer canonical (rare — the entry is preserved for archival, not permanently deleted). Provide entry_id.
- NOOP: no changes needed (the recent turns introduce nothing new).

Output ONLY a JSON array of operations. Example:
[
  {"op": "CREATE", "name": "Secret Meeting", "tag": "events", "content": "...", "keys": ["meeting"], "known_by": ["Willow", "Marcus"]},
  {"op": "CREATE", "name": "New Location", "tag": "locations", "content": "...", "keys": ["location name"], "known_by": null},
  {"op": "UPDATE", "entry_id": "...", "content": "...", "known_by": ["Willow", "Marcus", "Giles"]},
  {"op": "NOOP"}
]`;

const STALENESS_ADDENDUM = `\n\nA <stale_review> section is included below. Each entry includes activation metadata:
- never_activated=true means this entry has NEVER been triggered by the context engine across all turns — the story has never revisited this topic
- last_activated_turn shows when it was last contextually relevant (compare to current_turn)

Guidelines for stale review:
- DISABLE one-time micro-events (tag=events) that have never activated and are unlikely to ever be relevant again (e.g. a throwaway joke, a single reaction, a minor conversational beat from hundreds of turns ago)
- DO NOT disable entries that are still being activated — they are working as intended regardless of age
- DO NOT disable entries tagged characters, locations, factions, lore, rules, capabilities, traits, relationships, or threads — these are persistent world-building (and, for threads, pending narrative obligations) and must remain queryable regardless of activation frequency. They may simply not have been thematically relevant yet.
- UPDATE entries that contain outdated facts but are still relevant
- When in doubt, NOOP — keeping an unused entry is better than disabling one that matters`;

interface DiffOp {
  op: "CREATE" | "UPDATE" | "DELETE" | "DISABLE" | "NOOP";
  entry_id?: string;
  name?: string;
  tag?: string;
  content?: string;
  keys?: string[];
  known_by?: string[] | null;
}

export class RollingDiffWorker {
  private readonly logger = createLogger("rolling-diff-worker");
  private readonly lorebook;
  private readonly campaigns;
  private readonly sessions;
  private readonly messages;
  private readonly runs;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly runtime;
  private readonly runtimeDefaults;
  private readonly embedding;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.lorebook = new LorebookRepository(db);
    this.campaigns = new CampaignRepository(db);
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
    this.runs = new PipelineRunRepository(db);
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
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, now, "campaign not found", null); return; }

      const sessionId = run.sessionId;
      if (!sessionId) { this.runs.markFailed(run.id, now, "no session for rolling diff", null); return; }

      const allMessages = this.messages.listForSession(run.userId, sessionId)
        .filter(m => m.role !== "cold-start");
      const recentTurns = allMessages.slice(-8).map(m => {
        let line = `[${m.role}]: ${m.content}`;
        if (m.role === "assistant" && (m as any).sceneData) {
          try {
            const scene = JSON.parse((m as any).sceneData);
            if (scene?.location) line = `[SCENE: ${scene.location} | PRESENT: ${(scene.present ?? []).join(", ")}]\n${line}`;
          } catch {}
        }
        return line;
      }).join("\n\n");

      const existingEntries = this.lorebook.listEnabledForCampaign(run.userId, run.campaignId);
      const existingSummary = existingEntries.map(e => {
        const snippet = e.content.length > 120 ? e.content.slice(0, 120) + "..." : e.content;
        return `- id=${e.id} | name=${e.name}${e.tag ? ` | tag=${e.tag}` : ""}\n  ${snippet}`;
      }).join("\n");

      const details = run.detailsJson ? JSON.parse(run.detailsJson) as { rollingModel?: string; staleSweep?: boolean; embeddingModel?: string } : {};
      const embedModelId = details.embeddingModel || DEFAULT_EMBED_MODEL;
      const isStaleSweep = details.staleSweep === true;

      let staleSection = "";
      let staleBatchIds: string[] = [];
      if (isStaleSweep) {
        const staleEntries = this.lorebook.listForCampaign(run.userId, run.campaignId, {
          isEnabled: true, isConstant: false, sort: "last_reviewed_at", order: "asc", limit: 500,
        }).filter(e => !e.compressedRefIds);
        const activationState = this.lorebook.getActivationState(sessionId);
        const activationMap = new Map(activationState.map(s => [s.entryId, s.lastActivatedTurn]));
        const turnNumber = Math.floor(allMessages.length / 2) + 1;

        const enriched = staleEntries.map(e => ({
          entry: e,
          lastTurn: activationMap.get(e.id) ?? null,
          neverActivated: !activationMap.has(e.id),
        }));
        enriched.sort((a, b) => {
          if (a.neverActivated !== b.neverActivated) return a.neverActivated ? -1 : 1;
          const tagOrder = (t: string | null) => t === "events" ? 0 : t === "lore" ? 1 : 2;
          if (a.neverActivated && b.neverActivated) return tagOrder(a.entry.tag) - tagOrder(b.entry.tag);
          return (a.lastTurn ?? 0) - (b.lastTurn ?? 0);
        });
        const batch = enriched.slice(0, 100);
        staleBatchIds = batch.map(b => b.entry.id);

        if (batch.length > 0) {
          const lines = batch.map(({ entry: e, lastTurn, neverActivated }) =>
            `- id=${e.id} | name=${e.name} | tag=${e.tag ?? "none"} | never_activated=${neverActivated} | last_activated_turn=${lastTurn ?? "never"}\n  content: ${e.content}`
          ).join("\n");
          staleSection = `\n\n<stale_review>\ncurrent_turn=${turnNumber}\n${lines}\n</stale_review>`;
        }
      }

      const userPrompt = `<existing_relevant_entries>\n${existingSummary || "(none)"}\n</existing_relevant_entries>\n\n<recent_turns>\n${recentTurns}\n</recent_turns>${staleSection}`;

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      const modelId = resolveChatModelConfig(this.customEndpoints, run.userId, details.rollingModel || "claude-haiku-4-5-bridge")?.id ?? "claude-haiku-4-5-bridge";

      let responseText = "";
      let diffInputTokens = 0, diffOutputTokens = 0;
      await runtime.streamChat({
        modelId,
        systemPrompt: isStaleSweep ? ROLLING_DIFF_SYSTEM + STALENESS_ADDENDUM : ROLLING_DIFF_SYSTEM,
        messages: [{ role: "user", content: userPrompt, attachments: [] }],
        temperature: 0,
        thinkingMode: "off",
        thinkingBudget: null,
        effort: null,
        cacheTtl: "off",
        requestId: `rolling-diff-${run.id}`,
      }, {
        onStart: () => {},
        onDelta: (delta) => { responseText += delta; },
        onThinkingDelta: () => {},
        onComplete: (result) => {
          diffInputTokens = result.usage.inputTokens ?? 0;
          diffOutputTokens = result.usage.outputTokens ?? 0;
        },
      });

      const ops = this.parseOps(responseText);
      await this.expandSynonymKeys(runtime, modelId, ops, run.userId);
      const { applied, toEmbed } = this.applyOps(run.userId, run.campaignId, ops);
      if (toEmbed.length) {
        await this.embedding.indexEntries(toEmbed, embedModelId)
          .catch((err) => this.logger.warn({ runId: run.id, count: toEmbed.length, err }, "rolling-diff re-embed failed — vectors stale until backfill"));
      }
      if (staleBatchIds.length > 0) this.lorebook.touchLastReviewedAt(run.userId, staleBatchIds);
      const doneAt = new Date().toISOString();
      this.runs.markCompleted(run.id, doneAt, `Applied ${applied} operations`, JSON.stringify({ ops: ops.length, applied, usage: { modelId, inputTokens: diffInputTokens, outputTokens: diffOutputTokens } }));
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "rolling diff failed", null);
    }
  }

  private async expandSynonymKeys(runtime: ChatRuntime, modelId: string, ops: DiffOp[], userId: string): Promise<void> {
    const targets: { op: DiffOp; name: string; content: string; existingKeys: string[] }[] = [];
    for (const op of ops) {
      if (op.op === "CREATE" && op.name && op.content) {
        targets.push({ op, name: op.name, content: op.content, existingKeys: op.keys ?? [] });
      } else if (op.op === "UPDATE" && op.entry_id && op.content) {
        const existing = this.lorebook.findById(userId, op.entry_id);
        if (!existing) continue;
        let existingKeys: string[] = [];
        try { existingKeys = JSON.parse(existing.keys || "[]") as string[]; } catch {}
        targets.push({ op, name: existing.name, content: op.content, existingKeys });
      }
    }
    if (targets.length === 0) return;

    await Promise.all(targets.map(async ({ op, name, content, existingKeys }) => {
      try {
        const prompt = `For the lorebook entry below, generate 5-10 additional keywords that someone might use to reference this content. Include: synonyms, alternate phrasings, related terms, common vocabulary variants. EXCLUDE any word already in the existing keys list. Keep keys short (1-3 words each). Output JSON only: {"keys": ["word1", "word2", ...]}.\n\n<entry_name>${name}</entry_name>\n<existing_keys>${existingKeys.join(", ") || "(none)"}</existing_keys>\n<content_excerpt>${content.slice(0, 400)}</content_excerpt>`;
        let responseText = "";
        await runtime.streamChat({
          modelId,
          systemPrompt: "You are a retrieval-keyword generator. Output JSON only, no prose.",
          messages: [{ role: "user", content: prompt, attachments: [] }],
          temperature: 0.3,
          thinkingMode: "off",
          thinkingBudget: null,
          effort: null,
          cacheTtl: "off",
          requestId: `synonym-keys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        }, {
          onStart: () => {},
          onDelta: (delta) => { responseText += delta; },
          onThinkingDelta: () => {},
          onComplete: () => {},
        });
        const match = responseText.match(/\{[\s\S]*"keys"[\s\S]*\}/);
        if (!match) return;
        const parsed = JSON.parse(match[0]) as { keys: unknown };
        if (!Array.isArray(parsed.keys)) return;
        const newKeys = parsed.keys
          .filter((k): k is string => typeof k === "string" && k.trim().length > 0 && k.trim().length < 60)
          .map(k => k.trim())
          .filter(k => !existingKeys.some(e => e.toLowerCase() === k.toLowerCase()));
        if (newKeys.length === 0) return;
        const merged = [...existingKeys, ...newKeys].slice(0, 20);
        op.keys = merged;
      } catch {
        // Graceful: leave keys unchanged if synonym call fails
      }
    }));
  }

  private parseOps(text: string): DiffOp[] {
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((op: any) => op && typeof op.op === "string");
    } catch { return []; }
  }

  private applyOps(userId: string, campaignId: string, ops: DiffOp[]): { applied: number; toEmbed: { id: string; userId: string; content: string }[] } {
    const now = new Date().toISOString();
    let applied = 0;
    const toEmbed: { id: string; userId: string; content: string }[] = [];

    for (const op of ops) {
      if (op.op === "NOOP") continue;

      if (op.op === "CREATE" && op.name && op.content) {
        const id = createId();
        this.lorebook.create({
          id,
          userId,
          campaignId,
          name: op.name,
          tag: op.tag ?? null,
          content: op.content,
          comment: null,
          keys: JSON.stringify(op.keys ?? []),
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
          tokensEstimate: estimateTokens(op.content),
          knownBy: op.known_by ? JSON.stringify(op.known_by) : null,
          matchOptionsJson: null,
          legacySource: null,
          createdAt: now,
          updatedAt: now,
        });
        toEmbed.push({ id, userId, content: op.content });
        applied++;
      }

      if (op.op === "UPDATE" && op.entry_id && op.content) {
        const existing = this.lorebook.findById(userId, op.entry_id);
        // Constants (the Thread Index) and tracker-owned threads entries are
        // never valid rolling-diff targets — the prompt forbids it but the
        // code must enforce it (LLM UPDATEs could desync/clobber them).
        if (existing && !existing.isConstant && existing.tag !== "threads") {
          const updates: Record<string, unknown> = {
            content: op.content,
            tokensEstimate: estimateTokens(op.content),
            updatedAt: now,
          };
          if (op.known_by !== undefined) updates.knownBy = op.known_by ? JSON.stringify(op.known_by) : null;
          if (Array.isArray(op.keys) && op.keys.length > 0) updates.keys = JSON.stringify(op.keys);
          this.lorebook.update(userId, op.entry_id, updates as any);
          toEmbed.push({ id: op.entry_id, userId, content: op.content });
          applied++;
        }
      }

      if ((op.op === "DELETE" || op.op === "DISABLE") && op.entry_id) {
        const target = this.lorebook.findById(userId, op.entry_id);
        if (target && !target.isConstant && target.tag !== "threads") {
          this.lorebook.update(userId, op.entry_id, { isEnabled: 0, updatedAt: now } as any);
          applied++;
        }
      }
    }
    return { applied, toEmbed };
  }
}
