import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { EmbeddingService, OpenAIEmbeddingProvider, GoogleEmbeddingProvider, type EmbeddingProvider } from "../../../api/src/domain/context/embeddingService";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { decodeVector, cosineSimilarity } from "../../../api/src/domain/context/vectorIo";
import { createId } from "../../../api/src/lib/ids";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";

const DEFAULT_EMBED_MODEL = "openai:text-embedding-3-large";
const SIMILARITY_THRESHOLD = 0.92;
const MAX_GROUPS_PER_RUN = 5;

const ANALYSIS_SYSTEM = `You are a lorebook maintenance system for a roleplay campaign. You will be given a group of lorebook entries that have been flagged as potential duplicates or near-duplicates based on semantic similarity.

Your job is to determine whether these entries should be merged and, if so, produce a single merged entry that preserves ALL unique information from every source entry.

Rules:
- MERGE if entries describe the same character, location, event, or concept and have substantial content overlap
- DO NOT MERGE entries that describe different aspects of the same topic but serve distinct retrieval purposes (e.g. a character's backstory vs. a specific event involving that character)
- The merged content must be a UNION of all information — never discard unique facts, details, or nuance from any source entry
- Preserve the most descriptive name and the most comprehensive set of trigger keys
- Preserve known_by from all sources (union of all character names)
- If any entry has known_by=null (global knowledge), the merged entry should also be null

Output ONLY a JSON object:
- If merging: {"action": "merge", "name": "...", "tag": "...", "content": "...", "keys": [...], "known_by": [...] or null, "keep_id": "id of entry to update", "remove_ids": ["ids to soft-delete"]}
- If not merging: {"action": "skip", "reason": "brief explanation"}`;

const VALIDATION_SYSTEM = `You are an adversarial reviewer for lorebook merge operations. You will receive:
1. The original entries (before merge)
2. A proposed merged entry

Your ONLY job is to find information present in the originals that is MISSING from the merged version. You are a safety net — if you find ANY lost information, the merge must be rejected.

Check for:
- Facts, dates, or details mentioned in originals but absent from the merge
- Character relationships or knowledge (known_by) that was narrowed instead of unioned
- Trigger keys from originals that were dropped
- Nuance or context that was oversimplified

Output ONLY a JSON object:
- If merge is safe: {"verdict": "approve"}
- If information is lost: {"verdict": "reject", "missing": ["list of specific missing facts or details"]}`;

interface MergeGroup {
  entries: { id: string; name: string; tag: string | null; content: string; keys: string; knownBy: string | null }[];
  similarity: number;
}

interface MergeProposal {
  action: "merge";
  name: string;
  tag: string;
  content: string;
  keys: string[];
  known_by: string[] | null;
  keep_id: string;
  remove_ids: string[];
}

export class LorebookConsolidationWorker {
  private readonly logger = createLogger("lorebook-consolidation-worker");
  private readonly lorebook;
  private readonly runs;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly embeddings;
  private readonly embedding;
  private readonly runtime;
  private readonly runtimeDefaults;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.lorebook = new LorebookRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.embeddings = new LorebookEmbeddingRepository(db);
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
      const earlyDetails = run.detailsJson ? JSON.parse(run.detailsJson) as { consolidationModel?: string; embeddingModel?: string } : {};
      const embedModelId = earlyDetails.embeddingModel || DEFAULT_EMBED_MODEL;
      // Bootstrap: if no embeddings exist, index all entries first
      const entries = this.lorebook.listEnabledForCampaign(run.userId, run.campaignId).filter(e => !e.isConstant);
      const existingEmbeddings = this.embeddings.listForUserAndModel(run.userId, embedModelId);
      const embeddedIds = new Set(existingEmbeddings.map(e => e.entryId));
      const unembedded = entries.filter(e => !embeddedIds.has(e.id));
      if (unembedded.length > 0) {
        this.logger.info({ total: entries.length, unembedded: unembedded.length }, "consolidation: bootstrapping missing embeddings");
        const indexed = await this.embedding.indexEntries(
          unembedded.map(e => ({ id: e.id, userId: run.userId, content: e.content })),
          embedModelId,
        );
        this.logger.info({ indexed }, "consolidation: bootstrap indexing complete");
        if (indexed === 0) {
          this.runs.markFailed(run.id, now, "no embedding provider available — cannot detect duplicates", null);
          return;
        }
      }

      // Pass 1 — Detection (local compute, zero LLM cost)
      const groups = await this.detectDuplicates(run.userId, run.campaignId, embedModelId);
      if (groups.length === 0) {
        this.runs.markCompleted(run.id, now, "No duplicate candidates found", JSON.stringify({ groups: 0, merged: 0 }));
        this.runs.updateRun(run.id, { approvedAt: now });
        return;
      }

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }

      const modelId = resolveChatModelConfig(this.customEndpoints, run.userId, earlyDetails.consolidationModel || "claude-haiku-4-5-bridge")?.id ?? "claude-haiku-4-5-bridge";

      let merged = 0;
      let skipped = 0;
      let rejected = 0;

      for (const group of groups.slice(0, MAX_GROUPS_PER_RUN)) {
        try {
          // Pass 2 — Analysis (LLM pass 1)
          const proposal = await this.analyzeGroup(runtime, modelId, group);
          if (!proposal) { skipped++; continue; }

          // Pass 3 — Validation (LLM pass 2, independent)
          const approved = await this.validateMerge(runtime, modelId, group, proposal);
          if (!approved) { rejected++; continue; }

          // Apply the merge
          this.applyMerge(run.userId, run.campaignId, proposal, group);
          await this.embedding.indexEntries([{ id: proposal.keep_id, userId: run.userId, content: proposal.content }], embedModelId)
            .catch((err) => this.logger.warn({ runId: run.id, err }, "post-merge re-embed failed — vector stale until next backfill"));
          merged++;
        } catch (groupErr) {
          this.logger.warn({ runId: run.id, error: groupErr instanceof Error ? groupErr.message : "group failed" }, "consolidation group failed — skipping");
        }
      }

      const doneAt = new Date().toISOString();
      this.runs.markCompleted(run.id, doneAt,
        `Consolidation: ${merged} merged, ${skipped} skipped, ${rejected} rejected (${groups.length} candidates found)`,
        JSON.stringify({ groups: groups.length, processed: Math.min(groups.length, MAX_GROUPS_PER_RUN), merged, skipped, rejected, modelId }),
      );
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "consolidation failed", null);
    }
  }

  private async detectDuplicates(userId: string, campaignId: string, embedModelId: string): Promise<MergeGroup[]> {
    const entries = this.lorebook.listEnabledForCampaign(userId, campaignId)
      .filter(e => !e.isConstant);

    const allEmbeddings = this.embeddings.listForUserAndModel(userId, embedModelId);
    const embeddingMap = new Map<string, Float32Array>();
    for (const emb of allEmbeddings) {
      embeddingMap.set(emb.entryId, decodeVector(emb.vector));
    }

    const entryMap = new Map(entries.map(e => [e.id, e]));
    const pairs: { a: string; b: string; sim: number }[] = [];

    const entryIds = entries.map(e => e.id).filter(id => embeddingMap.has(id));

    for (let i = 0; i < entryIds.length; i++) {
      // Yield between outer iterations: at Buffy scale (2,629 entries x 3,072
      // dims) the all-pairs loop is ~10^10 float ops — fully synchronous it
      // froze the entire single-process API (chat streams, heartbeats, HTTP)
      // for seconds every 10th rolling diff.
      if (i % 16 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const vecA = embeddingMap.get(entryIds[i]!)!;
      for (let j = i + 1; j < entryIds.length; j++) {
        const vecB = embeddingMap.get(entryIds[j]!)!;
        const sim = cosineSimilarity(vecA, vecB);
        if (sim >= SIMILARITY_THRESHOLD) {
          pairs.push({ a: entryIds[i]!, b: entryIds[j]!, sim });
        }
      }
    }

    // Cluster pairs into groups using union-find
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
      return parent.get(x)!;
    };
    const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

    for (const { a, b } of pairs) union(a, b);

    const clusters = new Map<string, { ids: Set<string>; maxSim: number }>();
    for (const { a, b, sim } of pairs) {
      const root = find(a);
      if (!clusters.has(root)) clusters.set(root, { ids: new Set(), maxSim: 0 });
      const cluster = clusters.get(root)!;
      cluster.ids.add(a);
      cluster.ids.add(b);
      cluster.maxSim = Math.max(cluster.maxSim, sim);
    }

    const groups: MergeGroup[] = [];
    for (const [, cluster] of clusters) {
      const clusterEntries = [...cluster.ids].map(id => entryMap.get(id)!).filter(Boolean);
      if (clusterEntries.length < 2) continue;
      groups.push({
        entries: clusterEntries.map(e => ({ id: e.id, name: e.name, tag: e.tag, content: e.content, keys: e.keys, knownBy: e.knownBy })),
        similarity: cluster.maxSim,
      });
    }

    groups.sort((a, b) => b.similarity - a.similarity);
    return groups;
  }

  private async analyzeGroup(runtime: ChatRuntime, modelId: string, group: MergeGroup): Promise<MergeProposal | null> {
    const entriesText = group.entries.map(e =>
      `[${e.id}] ${e.name} (${e.tag ?? "untagged"})\nKeys: ${(() => { try { return JSON.parse(e.keys).join(", "); } catch { return "none"; } })()}\nKnown by: ${e.knownBy ?? "global"}\nContent: ${e.content}`
    ).join("\n\n---\n\n");

    const userPrompt = `Similarity score: ${group.similarity.toFixed(3)}\n\n<entries>\n${entriesText}\n</entries>`;

    let responseText = "";
    await runtime.streamChat({
      modelId,
      systemPrompt: ANALYSIS_SYSTEM,
      messages: [{ role: "user", content: userPrompt, attachments: [] }],
      temperature: 0,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      requestId: `consolidation-analysis-${group.entries[0]?.id}`,
    }, {
      onStart: () => {},
      onDelta: (delta) => { responseText += delta; },
      onThinkingDelta: () => {},
      onComplete: () => {},
    });

    try {
      const match = responseText.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (parsed.action === "skip") {
        this.logger.info({ group: group.entries.map(e => e.name), reason: parsed.reason }, "consolidation: LLM skipped group");
        return null;
      }
      if (parsed.action !== "merge" || !parsed.keep_id || !parsed.remove_ids?.length || !parsed.content) return null;
      return parsed as MergeProposal;
    } catch { return null; }
  }

  private async validateMerge(runtime: ChatRuntime, modelId: string, group: MergeGroup, proposal: MergeProposal): Promise<boolean> {
    const originalsText = group.entries.map(e =>
      `[${e.id}] ${e.name}\nKeys: ${(() => { try { return JSON.parse(e.keys).join(", "); } catch { return "none"; } })()}\nKnown by: ${e.knownBy ?? "global"}\nContent: ${e.content}`
    ).join("\n\n---\n\n");

    const mergedText = `Name: ${proposal.name}\nTag: ${proposal.tag}\nKeys: ${proposal.keys.join(", ")}\nKnown by: ${proposal.known_by ? proposal.known_by.join(", ") : "global"}\nContent: ${proposal.content}`;

    const userPrompt = `<original_entries>\n${originalsText}\n</original_entries>\n\n<proposed_merge>\n${mergedText}\n</proposed_merge>`;

    let responseText = "";
    await runtime.streamChat({
      modelId,
      systemPrompt: VALIDATION_SYSTEM,
      messages: [{ role: "user", content: userPrompt, attachments: [] }],
      temperature: 0,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      requestId: `consolidation-validate-${proposal.keep_id}`,
    }, {
      onStart: () => {},
      onDelta: (delta) => { responseText += delta; },
      onThinkingDelta: () => {},
      onComplete: () => {},
    });

    try {
      const match = responseText.match(/\{[\s\S]*\}/);
      if (!match) return false;
      const parsed = JSON.parse(match[0]);
      if (parsed.verdict === "reject") {
        this.logger.info({ keepId: proposal.keep_id, missing: parsed.missing }, "consolidation: validator rejected merge");
        return false;
      }
      return parsed.verdict === "approve";
    } catch { return false; }
  }

  private applyMerge(userId: string, campaignId: string, proposal: MergeProposal, group: MergeGroup) {
    const now = new Date().toISOString();

    // Guard hallucinated IDs: every id must come from THIS candidate group
    // (the LLM could otherwise overwrite/disable ANY entry of the user,
    // including the constant Thread Index), keep_id must not be in remove_ids
    // (instant self-disable), and constants are never merge targets.
    const groupIds = new Set(group.entries.map((e) => e.id));
    if (!groupIds.has(proposal.keep_id)) {
      this.logger.warn({ keepId: proposal.keep_id }, "consolidation: keep_id not in candidate group — skipping merge");
      return;
    }
    proposal.remove_ids = proposal.remove_ids.filter((id) => groupIds.has(id) && id !== proposal.keep_id);
    if (proposal.remove_ids.length === 0) {
      this.logger.warn({ keepId: proposal.keep_id }, "consolidation: no valid remove_ids after group filtering — skipping merge");
      return;
    }
    const keepRow = this.lorebook.findById(userId, proposal.keep_id);
    if (!keepRow || keepRow.isConstant) {
      this.logger.warn({ keepId: proposal.keep_id }, "consolidation: keep target missing or constant — skipping merge");
      return;
    }

    // Update the kept entry with merged content
    this.lorebook.update(userId, proposal.keep_id, {
      name: proposal.name,
      tag: proposal.tag,
      content: proposal.content,
      keys: JSON.stringify(proposal.keys),
      knownBy: proposal.known_by ? JSON.stringify(proposal.known_by) : null,
      tokensEstimate: estimateTokens(proposal.content),
      updatedAt: now,
    });

    // Soft-delete the removed entries (disable + mark with merged_into_id)
    for (const removeId of proposal.remove_ids) {
      const row = this.lorebook.findById(userId, removeId);
      if (!row || row.isConstant) continue;
      this.lorebook.update(userId, removeId, {
        isEnabled: 0,
        mergedIntoId: proposal.keep_id,
        comment: `merged_into:${proposal.keep_id}:at:${now}`,
        updatedAt: now,
      });
    }

    this.logger.info({
      keepId: proposal.keep_id,
      removedIds: proposal.remove_ids,
      name: proposal.name,
    }, "consolidation: merge applied");
  }
}
