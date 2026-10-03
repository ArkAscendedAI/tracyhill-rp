import { settledSourceForRun, assertSettledSource } from "./settledSourceGuard";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { SettledSourceChangedError } from "./settledSourceGuard";
import { canonSourceVersion } from "./canonSourceVersion";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";

import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { LorebookRevisionRepository } from "../../../api/src/domain/context/lorebookRevisionRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { LorebookEmbeddingRepository } from "../../../api/src/domain/context/lorebookEmbeddingRepository";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import { EmbeddingService, buildEmbeddingProviders } from "../../../api/src/domain/context/embeddingService";
import { resolveCampaignEmbedModel } from "../../../api/src/domain/context/embedModelResolver";
import { isProvisionalMarker, parseOffscreenMarker } from "../../../api/src/domain/world/offscreen";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { decodeVector, cosineSimilarity } from "../../../api/src/domain/context/vectorIo";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { withRetry, withDeadline, withTimeout, WORKER_LLM_DEADLINE_MS } from "../pipeline/retryHelper";
import { resolveWorkerModel } from "./workerModel";
import { isReservedCreateTag } from "../../../api/src/domain/context/lorebookTags";
import { normalizeKeyList } from "../../../api/src/domain/context/lorebookKeys";
import { isArchiveTrigger } from "../../../api/src/domain/context/archiveTriggers";
import { KeyCapNotes } from "./keyCapNotes";
import { normalizeKnownBy } from "../../../api/src/domain/context/lorebookKnownBy";
import { completeRun } from "./runCompletion";

const SIMILARITY_THRESHOLD = 0.92;
const MAX_GROUPS_PER_RUN = 5;
// Skip memory: a group the model legitimately declined
// to merge is remembered by signature (entry ids + source versions) in the
// completed run's details and excluded from later runs until a member changes
// — the top-five clusters used to be re-analyzed every run, so groups six and
// beyond were never examined. Bounded; the newest signatures win.
const MAX_REMEMBERED_SKIPS = 200;

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

export interface MergeGroup {
  entries: { id: string; name: string; tag: string | null; content: string; keys: string; knownBy: string | null; sourceVersion?: string }[];
  similarity: number;
}

export interface MergeProposal {
  action: "merge";
  name: string;
  tag: string;
  content: string;
  keys: string[];
  // Server-derived: null when any source is global, else the union
  // of the sources' scopes. The model's own value is kept only for the log.
  known_by: string[] | null;
  known_by_from_model?: string[] | null;
  keep_id: string;
  remove_ids: string[];
}

/** The analysis call's outcome, so a legitimate model "skip" is never
 *  confused with a parse miss. */
export type AnalysisOutcome = { kind: "merge"; proposal: MergeProposal } | { kind: "skip"; reason: string } | { kind: "parse-miss" };

/** Stable identity of a candidate group: its entry ids with their source
 *  versions, sorted — any member edit yields a new signature. Exported for tests. */
export function groupSignature(group: MergeGroup): string {
  return group.entries.map((e) => `${e.id}@${e.sourceVersion ?? ""}`).sort().join("|");
}

/** Classify the analysis model's text: a merge proposal,
 *  an explicit skip, or a parse miss. Exported for tests. */
export function classifyAnalysisResponse(text: string, group: MergeGroup): AnalysisOutcome {
  const parsed = parseFirstJson<Record<string, unknown>>(text, "{");
  if (!parsed) return { kind: "parse-miss" };
  if (parsed.action === "skip") return { kind: "skip", reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  const proposal = normalizeMergeProposal(parsed, group);
  return proposal ? { kind: "merge", proposal } : { kind: "parse-miss" };
}

/** The remembered skip signatures carried by the campaign's latest completed
 *  consolidation run (the memory lives in run details — no new column). */
function rememberedSkips(detailsJson: string | null | undefined): string[] {
  try {
    const parsed = detailsJson ? JSON.parse(detailsJson) as { skippedGroups?: unknown } : {};
    return Array.isArray(parsed.skippedGroups) ? parsed.skippedGroups.filter((s): s is string => typeof s === "string") : [];
  } catch { return []; }
}

export class LorebookConsolidationWorker {
  private readonly logger = createLogger("lorebook-consolidation-worker");
  private readonly lorebook;
  private readonly messages;
  private readonly runs;
  private readonly sessions;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly embeddings;
  private readonly embedding;
  private readonly runtime;
  private readonly runtimeDefaults;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.messages = new MessageRepository(db);
    this.lorebook = new LorebookRepository(db, new LorebookRevisionRepository(db));
    this.runs = new PipelineRunRepository(db);
    this.sessions = new SessionRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    this.embeddings = new LorebookEmbeddingRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", runnerUrl: "", runnerSecret: "", deepseekApiKey: "", fireworksApiKey: "", gmicloudApiKey: "", googleApiKey: "", moonshotApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" };
    const providers = buildEmbeddingProviders(this.runtimeDefaults);
    this.embedding = new EmbeddingService(new LorebookEmbeddingRepository(db), providers, this.providerKeys);
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    // Scoped revision context: restored after the run settles.
    return this.lorebook.withRevisionContext({ source: "consolidation", pipelineRunId: run.id }, () => this.executeInContext(run, signal));
  }

  private async executeInContext(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    const now = new Date().toISOString();
    // Merges commit one group at a time, so a cancel can land after some have;
    // the count is visible to the cancel path below.
    let merged = 0;
    try {
      const settledSource = settledSourceForRun(run);
      const assertSource = () => assertSettledSource(this.messages, run.userId, settledSource);
      assertSource();
      const earlyDetails = run.detailsJson ? JSON.parse(run.detailsJson) as { consolidationModel?: string; embeddingModel?: string; workerEffort?: string; openaiFastMode?: boolean } : {};
      // The queue stamps the SESSION dial; the fallback is the API's
      // newest-session rule (embedModelResolver), never a fossil.
      const embedModelId = earlyDetails.embeddingModel || resolveCampaignEmbedModel(this.sessions, run.userId, run.campaignId);
      // Skip memory from the previous completed run; carried forward
      // in every terminal write below so an early exit never forgets it.
      const remembered = rememberedSkips(this.runs.findLatestCompletedByKindAndCampaign("lorebook_consolidation", run.campaignId)?.detailsJson);
      // Bootstrap: if no embeddings exist, index all entries first
      const entries = this.lorebook.listEnabledForCampaign(run.userId, run.campaignId).filter(e => !e.isConstant);
      // Campaign-scoped pool: the user-wide list decoded every
      // campaign's vectors for one campaign's dedup pass.
      const existingEmbeddings = this.embeddings.listForCampaignAndModel(run.userId, run.campaignId, embedModelId);
      const embeddedIds = new Set(existingEmbeddings.map(e => e.entryId));
      const unembedded = entries.filter(e => !embeddedIds.has(e.id));
      if (unembedded.length > 0) {
        this.logger.info({ total: entries.length, unembedded: unembedded.length }, "consolidation: bootstrapping missing embeddings");
        const indexed = await withTimeout(this.embedding.indexEntries(
          unembedded.map(e => ({ id: e.id, userId: run.userId, content: e.content })),
          embedModelId,
        ), WORKER_LLM_DEADLINE_MS, "consolidation bootstrap embed");
        this.logger.info({ indexed }, "consolidation: bootstrap indexing complete");
        if (indexed === 0) {
          // #15 graceful degrade — a keyless campaign (no embedding provider, e.g.
          // keyword-only retrieval) has nothing to detect duplicates against. This
          // is EXPECTED, not a failure: skip cleanly with a signal instead of
          // markFailed (which would spam the events feed on every consolidation).
          recordSystemEvent({
            userId: run.userId, source: "lorebook_consolidation", severity: "info",
            campaignId: run.campaignId,
            message: "consolidation skipped — no embedding provider for this campaign (semantic dedup needs embeddings; add a provider key or a local endpoint).",
          });
          completeRun(this.runs, run.id, now, "Consolidation skipped (no embedding provider)", JSON.stringify({ groups: 0, merged: 0, skipped: "no_embeddings", skippedGroups: remembered }));
          return;
        }
      }

      // Pass 1 — Detection (local compute, zero LLM cost)
      const allGroups = await this.detectDuplicates(run.userId, run.campaignId, embedModelId);
      // Groups the model already declined, unchanged since: excluded BEFORE the
      // top-N slice so the next clusters get their turn.
      const rememberedSet = new Set(remembered);
      const groups = allGroups.filter((group) => !rememberedSet.has(groupSignature(group)));
      const excluded = allGroups.length - groups.length;
      if (groups.length === 0) {
        completeRun(this.runs, run.id, now, excluded > 0 ? `No new duplicate candidates (${excluded} remembered as declined, unchanged)` : "No duplicate candidates found", JSON.stringify({ groups: 0, merged: 0, remembered: excluded, skippedGroups: remembered }));
        return;
      }

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }

      // An unresolvable consolidationModel dial fails the run loudly.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "lorebook_consolidation", "lorebook consolidation", earlyDetails.consolidationModel, getConfiguredDefaultModelId() ?? "claude-haiku-4-5-bridge");
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, earlyDetails.workerEffort);
      const speed = openaiFastModeFor(modelId, earlyDetails.openaiFastMode);

      merged = 0;
      const keyCaps = new KeyCapNotes();
      let skipped = 0;
      let rejected = 0;
      let parseMisses = 0;
      let crashed = 0;
      const newlySkipped: string[] = [];

      for (const group of groups.slice(0, MAX_GROUPS_PER_RUN)) {
        try {
          this.runs.heartbeat(run.id);
          // Pass 2 — Analysis (LLM pass 1)
          const outcome = await this.analyzeGroup(runtime, modelId, workerEffort, speed, group, signal);
          if (outcome.kind === "parse-miss") { parseMisses++; continue; }
          if (outcome.kind === "skip") {
            // A legitimate "these are distinct" verdict: remembered, so the
            // next run examines the clusters behind it instead.
            skipped++;
            newlySkipped.push(groupSignature(group));
            continue;
          }
          const proposal = outcome.proposal;

          // Pass 3 — Validation (LLM pass 2, independent)
          const approved = await this.validateMerge(runtime, modelId, workerEffort, speed, group, proposal, signal);
          if (!approved) { rejected++; continue; }

          // Apply the merge; only re-embed + count when it actually applied.
          if (!this.applyMerge(run.userId, proposal, group, assertSource, keyCaps)) { skipped++; continue; }
          await withTimeout(this.embedding.indexEntries([{ id: proposal.keep_id, userId: run.userId, content: proposal.content }], embedModelId), WORKER_LLM_DEADLINE_MS, "post-merge re-embed")
            .catch((err) => {
              // The hung-embed (withTimeout) path is not covered by
              // indexEntries' own provider-error events.
              this.logger.warn({ runId: run.id, err }, "post-merge re-embed failed/timed out — vector stale until next backfill");
              recordSystemEvent({
                userId: run.userId, source: "lorebook_consolidation", severity: "warn",
                campaignId: run.campaignId, sessionId: run.sessionId,
                message: `post-merge re-embed failed or timed out for merged entry ${proposal.keep_id} — vector stale until backfill`,
                details: { runId: run.id, entryId: proposal.keep_id, error: err instanceof Error ? err.message : String(err) },
              });
            });
          merged++;
        } catch (groupErr) {
          if (groupErr instanceof SettledSourceChangedError) throw groupErr;
          // Abort must propagate out of the loop — never get swallowed as a
          // "skip this group" warning, or the run would mark completed despite
          // being canceled.
          if (signal?.aborted || (groupErr instanceof Error && groupErr.name === "AbortError")) throw groupErr;
          // A group that crashed is neither skipped nor rejected — it counts
          // toward the "no actionable proposal" heuristic below (with the parse
          // misses, never with the model's legitimate skips) and it surfaces
          // as an event (passive subsystem).
          crashed++;
          const message = groupErr instanceof Error ? groupErr.message : "group failed";
          this.logger.warn({ runId: run.id, error: message }, "consolidation group failed — skipping");
          recordSystemEvent({
            userId: run.userId, source: "lorebook_consolidation", severity: "warn",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: `consolidation group failed and was skipped: ${message}`,
            details: { runId: run.id, entryIds: group.entries.map((e) => e.id) },
          });
        }
      }

      // No-silent-failures: every processed group ending in a parse miss or a
      // crash (no merge, no rejection, no legitimate skip) points at a
      // systematic parse/format failure, not genuine "nothing to consolidate".
      // A model "skip" is a verdict, not a failure.
      const processed = Math.min(groups.length, MAX_GROUPS_PER_RUN);
      if (processed > 0 && parseMisses + crashed === processed) {
        recordSystemEvent({
          userId: run.userId, source: "lorebook_consolidation", severity: "warn",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: `consolidation processed ${processed} candidate groups but produced no actionable proposal — possible parse failure`,
          details: { groups: groups.length, processed, parseMisses, crashed },
        });
      }
      const skippedGroups = [...remembered, ...newlySkipped].slice(-MAX_REMEMBERED_SKIPS);
      const doneAt = new Date().toISOString();
      const completed = completeRun(this.runs, run.id, doneAt,
        `Consolidation: ${merged} merged, ${skipped} skipped, ${rejected} rejected${parseMisses + crashed > 0 ? `, ${parseMisses + crashed} unparseable/failed` : ""} (${groups.length} candidates${excluded > 0 ? `, ${excluded} remembered as declined` : ""})`,
        JSON.stringify({ groups: groups.length, processed, merged, skipped, rejected, parseMisses, crashed, remembered: excluded, skippedGroups, ...(keyCaps.list().length > 0 ? { keyCaps: keyCaps.list() } : {}), modelId }),
      );
      if (!completed && merged > 0) this.recordCanceledAfterMerges(run, merged);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        const canceled = this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
        if (merged > 0 && (canceled || this.runs.findById(run.userId, run.id)?.status === "canceled")) this.recordCanceledAfterMerges(run, merged);
        return;
      }
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "consolidation failed", null);
    }
  }

  /** A canceled run whose earlier groups already merged (each merge is its own
   *  transaction): the merges stand, the row stays canceled and unstamped. */
  private recordCanceledAfterMerges(run: { id: string; userId: string; campaignId: string; sessionId?: string | null }, merged: number): void {
    recordSystemEvent({
      userId: run.userId, source: "lorebook_consolidation", severity: "info",
      campaignId: run.campaignId, sessionId: run.sessionId ?? null,
      message: `lorebook consolidation was canceled after ${merged} merge${merged === 1 ? "" : "s"} had been applied; ${merged === 1 ? "it stands" : "they stand"} and the run stays canceled`,
      details: { runId: run.id, merged },
    });
  }

  private async detectDuplicates(userId: string, campaignId: string, embedModelId: string): Promise<MergeGroup[]> {
    const entries = this.lorebook.listEnabledForCampaign(userId, campaignId)
      // Never feed tracker-owned `threads` entries into the duplicate
      // detector — every other LLM-op applier excludes them; merging two facets
      // of one arc would disable a live thread mid-arc.
      // Living World: PROVISIONAL offscreen events are likewise excluded until
      // confirmed — merging unconfirmed hidden canon into established entries
      // would launder it past the review gate. The predicate is offscreen.ts's
      // (offscreen === true AND provisional === true, `isProvisionalMarker`),
      // the same one the archival worker and `listActiveOffscreen` use.
      // Archive triggers stay out too: a merge disables the rows it
      // absorbs, and a disabled trigger strands the cold rows it lists (43
      // disabled triggers held 157 unreachable cold rows on one campaign).
      .filter(e => !e.isConstant && e.tag !== "threads" && !isProvisionalMarker(parseOffscreenMarker(e.comment)) && !isArchiveTrigger(e));

    const allEmbeddings = this.embeddings.listForCampaignAndModel(userId, campaignId, embedModelId);
    const embeddingMap = new Map<string, Float32Array>();
    for (const emb of allEmbeddings) {
      embeddingMap.set(emb.entryId, decodeVector(emb.vector));
    }

    const entryMap = new Map(entries.map(e => [e.id, e]));
    const pairs: { a: string; b: string; sim: number }[] = [];

    const entryIds = entries.map(e => e.id).filter(id => embeddingMap.has(id));

    for (let i = 0; i < entryIds.length; i++) {
      // Yield between outer iterations: at Mara scale (2,629 entries x 3,072
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
        entries: clusterEntries.map(e => ({ id: e.id, name: e.name, tag: e.tag, content: e.content, keys: e.keys, knownBy: e.knownBy, sourceVersion: canonSourceVersion(e) })),
        similarity: cluster.maxSim,
      });
    }

    groups.sort((a, b) => b.similarity - a.similarity);
    return groups;
  }

  private async analyzeGroup(runtime: ChatRuntime, modelId: string, workerEffort: ReturnType<typeof workerEffortFor>, speed: "fast" | undefined, group: MergeGroup, signal?: AbortSignal): Promise<AnalysisOutcome> {
    const entriesText = group.entries.map(e =>
      `[${e.id}] ${e.name} (${e.tag ?? "untagged"})\nKeys: ${(() => { try { return JSON.parse(e.keys).join(", "); } catch { return "none"; } })()}\nKnown by: ${e.knownBy ?? "global"}\nContent: ${e.content}`
    ).join("\n\n---\n\n");

    const userPrompt = `Similarity score: ${group.similarity.toFixed(3)}\n\n<entries>\n${entriesText}\n</entries>`;

    let responseText = "";
    await withDeadline(WORKER_LLM_DEADLINE_MS, "consolidation-analysis model call", (dl) => withRetry(() => runtime.streamChat({
      modelId,
      systemPrompt: ANALYSIS_SYSTEM,
      messages: [{ role: "user", content: userPrompt, attachments: [] }],
      temperature: 0,
      thinkingMode: workerThinkingModeFor(modelId, workerEffort),
      thinkingBudget: null,
      effort: workerEffort,
      cacheTtl: "off",
      speed,
      requestId: `consolidation-analysis-${group.entries[0]?.id}`,
      signal: dl,
    }, {
      onStart: () => {},
      onDelta: (delta) => { responseText += delta; },
      onThinkingDelta: () => {},
      onComplete: () => {},
    }), () => { responseText = ""; }, signal), signal);

    const outcome = classifyAnalysisResponse(responseText, group);
    if (outcome.kind === "skip") this.logger.info({ group: group.entries.map(e => e.name), reason: outcome.reason }, "consolidation: LLM skipped group");
    if (outcome.kind === "merge" && JSON.stringify(outcome.proposal.known_by_from_model ?? null) !== JSON.stringify(outcome.proposal.known_by)) {
      // The union is a server guarantee; a differing model value is
      // informational only.
      this.logger.info({ keepId: outcome.proposal.keep_id, fromModel: outcome.proposal.known_by_from_model ?? null, applied: outcome.proposal.known_by }, "consolidation: known_by taken from the sources' union, not the model");
    }
    return outcome;
  }

  private async validateMerge(runtime: ChatRuntime, modelId: string, workerEffort: ReturnType<typeof workerEffortFor>, speed: "fast" | undefined, group: MergeGroup, proposal: MergeProposal, signal?: AbortSignal): Promise<boolean> {
    const originalsText = group.entries.map(e =>
      `[${e.id}] ${e.name}\nKeys: ${(() => { try { return JSON.parse(e.keys).join(", "); } catch { return "none"; } })()}\nKnown by: ${e.knownBy ?? "global"}\nContent: ${e.content}`
    ).join("\n\n---\n\n");

    const mergedText = `Name: ${proposal.name}\nTag: ${proposal.tag}\nKeys: ${proposal.keys.join(", ")}\nKnown by: ${proposal.known_by ? proposal.known_by.join(", ") : "global"}\nContent: ${proposal.content}`;

    const userPrompt = `<original_entries>\n${originalsText}\n</original_entries>\n\n<proposed_merge>\n${mergedText}\n</proposed_merge>`;

    let responseText = "";
    await withDeadline(WORKER_LLM_DEADLINE_MS, "consolidation validate call", (dl) => withRetry(() => runtime.streamChat({
      modelId,
      systemPrompt: VALIDATION_SYSTEM,
      messages: [{ role: "user", content: userPrompt, attachments: [] }],
      temperature: 0,
      thinkingMode: workerThinkingModeFor(modelId, workerEffort),
      thinkingBudget: null,
      effort: workerEffort,
      cacheTtl: "off",
      speed,
      requestId: `consolidation-validate-${proposal.keep_id}`,
      signal: dl,
    }, {
      onStart: () => {},
      onDelta: (delta) => { responseText += delta; },
      onThinkingDelta: () => {},
      onComplete: () => {},
    }), () => { responseText = ""; }, signal), signal);

    // The shared extractor: the greedy first-`{`-to-last-`}` regex
    // broke on any commentary after the JSON that contained a brace, rejecting
    // a valid approval as unparseable.
    const parsed = parseFirstJson<{ verdict?: unknown; missing?: unknown }>(responseText, "{");
    if (!parsed) return false;
    if (parsed.verdict === "reject") {
      this.logger.info({ keepId: proposal.keep_id, missing: parsed.missing }, "consolidation: validator rejected merge");
      return false;
    }
    return parsed.verdict === "approve";
  }

  // Returns true only when the merge was actually applied. The caller used
  // to re-embed proposal.keep_id and increment `merged` UNCONDITIONALLY after
  // this void call, so a guard-skip (e.g. a hallucinated keep_id that is a real
  // entry OUTSIDE the group) overwrote that real entry's vector with content it
  // doesn't contain. Gate the re-embed + counter on this boolean.
  private applyMerge(userId: string, proposal: MergeProposal, group: MergeGroup, assertSource?: () => void, keyCaps?: KeyCapNotes): boolean {
    const now = new Date().toISOString();

    // Guard hallucinated IDs: every id must come from THIS candidate group
    // (the LLM could otherwise overwrite/disable ANY entry of the user,
    // including the constant Thread Index), keep_id must not be in remove_ids
    // (instant self-disable), and constants/threads are never merge targets.
    const groupIds = new Set(group.entries.map((e) => e.id));
    if (!groupIds.has(proposal.keep_id)) {
      this.logger.warn({ keepId: proposal.keep_id }, "consolidation: keep_id not in candidate group — skipping merge");
      return false;
    }
    proposal.remove_ids = proposal.remove_ids.filter((id) => groupIds.has(id) && id !== proposal.keep_id);
    if (proposal.remove_ids.length === 0) {
      this.logger.warn({ keepId: proposal.keep_id }, "consolidation: no valid remove_ids after group filtering — skipping merge");
      return false;
    }
    const keepRow = this.lorebook.findById(userId, proposal.keep_id);
    if (!keepRow || keepRow.isConstant || keepRow.tag === "threads") {
      this.logger.warn({ keepId: proposal.keep_id }, "consolidation: keep target missing, constant, or thread-owned — skipping merge");
      return false;
    }

    // The model may not retag the merged entry out of its lifecycle:
    // a `characters` entry returned as `events` becomes archivable; `threads`
    // or `archived` would orphan it. Keep the target's own tag unless the
    // proposal names a tag one of the group's entries already carries.
    const tag = resolveMergeTag(keepRow.tag, proposal.tag, group);

    // Keep-update + remove-disables are ONE transaction: a kill
    // between them left merged content live beside still-enabled sources.
    // The "held" event is recorded AFTER the transaction: the worker process
    // records events on a different connection than the one holding this
    // (IMMEDIATE) write transaction, so an insert from inside would
    // wait out busy_timeout and be lost.
    // The merged list replaces the kept row's keys, held to the shared key
    // rule and LOREBOOK_MAX_KEYS; a binding cap is noted for the run
    // once the merge has landed.
    const mergedKeys = normalizeKeyList(proposal.keys);
    // The sources' union, bounded like an editor's list.
    const mergedScope = normalizeKnownBy(proposal.known_by).knownBy;
    let heldIds: string[] | null = null;
    const wrote = this.lorebook.transact(() => {
      assertSource?.();
      const changed = group.entries.filter((source) => {
        const live = this.lorebook.findById(userId, source.id);
        return !live || !source.sourceVersion || source.sourceVersion !== canonSourceVersion(live);
      });
      if (changed.length) {
        heldIds = changed.map((entry) => entry.id);
        return false;
      }
      const removedRows = proposal.remove_ids
        .map((removeId) => this.lorebook.findById(userId, removeId))
        .filter((row): row is NonNullable<typeof row> => !!row && !row.isConstant && row.tag !== "threads");
      // A confirmed offscreen marker on an absorbed row moves to the kept row
      // when that row has no comment of its own: the merged canon keeps
      // its provenance.
      const keepComment = carriedOffscreenComment(keepRow.comment, removedRows.map((row) => row.comment));
      // Update the kept entry with merged content
      this.lorebook.update(userId, proposal.keep_id, {
        name: proposal.name,
        tag,
        content: proposal.content,
        keys: JSON.stringify(mergedKeys.keys),
        knownBy: mergedScope ? JSON.stringify(mergedScope) : null,
        tokensEstimate: estimateTokens(proposal.content),
        ...(keepComment !== null ? { comment: keepComment } : {}),
        updatedAt: now,
      });

      // Soft-delete the removed entries (disable + record the merge in the
      // comment — the write-only merged_into_id column was dropped by 0083).
      // The row's own comment is kept under the stamp.
      for (const row of removedRows) {
        this.lorebook.update(userId, row.id, {
          isEnabled: 0,
          comment: mergedAwayComment(row.comment, proposal.keep_id, now),
          updatedAt: now,
        });
      }
    return true;
    });
    if (heldIds) {
      recordSystemEvent({ userId, source: "lorebook_consolidation", severity: "info", campaignId: keepRow.campaignId,
        message: "consolidation merge held because source entries changed during generation — newer canon preserved", details: { entryIds: heldIds } });
      return false;
    }
    if (!wrote) return false;
    keyCaps?.noteList(`${proposal.name} (${proposal.keep_id})`, mergedKeys);

    this.logger.info({
      keepId: proposal.keep_id,
      removedIds: proposal.remove_ids,
      name: proposal.name,
      tag,
    }, "consolidation: merge applied");
    return true;
  }
}

/** The comment a merged-away row keeps. It used to be
 *  overwritten with `merged_into:<keep>:at:<ts>`, losing a confirmed offscreen
 *  marker or a graduated thread's `thread T<n>` tag (recoverable only from
 *  revisions). A JSON-object comment (the offscreen marker) gains `mergedInto`
 *  and `mergedAt` and stays parseable by `parseOffscreenMarker`; any other
 *  comment keeps its text under a `merged_into:` first line; an empty one is
 *  the bare stamp, as before. Exported for tests. */
export function mergedAwayComment(oldComment: string | null | undefined, keepId: string, at: string): string {
  const stamp = `merged_into:${keepId}:at:${at}`;
  if (!oldComment || !oldComment.trim()) return stamp;
  try {
    const parsed: unknown = JSON.parse(oldComment);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify({ ...(parsed as Record<string, unknown>), mergedInto: keepId, mergedAt: at });
  } catch { /* free text: kept below the stamp */ }
  return `${stamp}\n${oldComment}`;
}

/** The comment the kept row takes on: the first CONFIRMED offscreen
 *  marker among the absorbed rows, when the kept row has no comment of its
 *  own; null = leave the kept row's comment unchanged. Provisional markers
 *  never reach a merge (the duplicate pool excludes them). Exported for tests. */
export function carriedOffscreenComment(keepComment: string | null | undefined, absorbedComments: Array<string | null | undefined>): string | null {
  if (keepComment && keepComment.trim()) return null;
  for (const comment of absorbedComments) {
    const marker = parseOffscreenMarker(comment);
    if (marker && !isProvisionalMarker(marker)) return JSON.stringify(marker);
  }
  return null;
}

/** Shape-check a merge proposal. The analysis prompt asks for name/
 *  tag/keys/known_by but models omit arrays routinely; a proposal without
 *  `keys` used to crash the validator's `keys.join` inside the group catch and
 *  vanish. Missing name/tag fall back to the kept entry's; missing keys default
 *  to the union of the group's keys (the validator's "dropped keys" check then
 *  judges the model's own list only when it supplied one). Exported for tests. */
export function normalizeMergeProposal(parsed: Record<string, unknown>, group: MergeGroup): MergeProposal | null {
  if (parsed.action !== "merge") return null;
  const keepId = typeof parsed.keep_id === "string" ? parsed.keep_id.trim() : "";
  const removeIds = Array.isArray(parsed.remove_ids) ? parsed.remove_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
  const content = typeof parsed.content === "string" ? parsed.content : "";
  if (!keepId || removeIds.length === 0 || !content.trim()) return null;
  const keepEntry = group.entries.find((e) => e.id === keepId);
  const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : (keepEntry?.name ?? "");
  if (!name) return null;
  const tag = typeof parsed.tag === "string" && parsed.tag.trim() ? parsed.tag.trim() : (keepEntry?.tag ?? "");
  let keys: string[];
  if (Array.isArray(parsed.keys)) {
    keys = parsed.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim());
  } else {
    const seen = new Set<string>();
    keys = [];
    for (const e of group.entries) {
      let parsedKeys: unknown = [];
      try { parsedKeys = JSON.parse(e.keys || "[]"); } catch { parsedKeys = []; }
      if (!Array.isArray(parsedKeys)) continue;
      for (const k of parsedKeys) {
        if (typeof k !== "string" || !k.trim() || seen.has(k.trim().toLowerCase())) continue;
        seen.add(k.trim().toLowerCase());
        keys.push(k.trim());
      }
    }
  }
  const knownByFromModel = Array.isArray(parsed.known_by)
    ? parsed.known_by.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    : null;
  return { action: "merge", name, tag, content, keys, known_by: unionKnownBy(group), known_by_from_model: knownByFromModel, keep_id: keepId, remove_ids: removeIds };
}

/** The merged entry's scope, computed from the SOURCES: null when any
 *  source is global (an unparseable or non-array scope counts as global — the
 *  entry was delivered unscoped), else the case-insensitive union of the
 *  sources' knowers, first sighting's casing kept. The prompt asks the model
 *  for the same rule; this makes it a server guarantee, like the archival
 *  worker's key union. Exported for tests. */
export function unionKnownBy(group: MergeGroup): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of group.entries) {
    if (entry.knownBy == null) return null;
    let names: unknown;
    try { names = JSON.parse(entry.knownBy); } catch { return null; }
    if (!Array.isArray(names)) return null;
    for (const name of names) {
      if (typeof name !== "string" || !name.trim()) continue;
      const key = name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name.trim());
    }
  }
  return out;
}

/** The tag the merged entry keeps: the kept row's own tag, unless the
 *  proposal names a tag that one of the group's entries already carries, and
 *  never a reserved lifecycle tag (`threads` is tracker-owned, `archived` the
 *  compressed-trigger tier). Reserved means the shared definition since
 *  2026-09-29: any case, so "Archived" no longer passes. Exported for
 *  tests. */
export function resolveMergeTag(keepTag: string | null, proposedTag: string | null | undefined, group: MergeGroup): string | null {
  const proposed = typeof proposedTag === "string" ? proposedTag.trim() : "";
  if (!proposed || isReservedCreateTag(proposed)) return keepTag;
  const groupTags = new Set(group.entries.map((e) => e.tag).filter((t): t is string => typeof t === "string" && t.length > 0));
  return groupTags.has(proposed) ? proposed : keepTag;
}
