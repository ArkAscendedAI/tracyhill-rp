import { pipelineInputsForRun } from "../context/settledSourceGuard";
import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";

import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { V4_REPETITION_DETECTION_PROMPT } from "./pipelinePrompts";
import { withRetry, withDeadline, WORKER_LLM_DEADLINE_MS } from "./retryHelper";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { resolveWorkerModel } from "../context/workerModel";

// The dormant/overflow archive is bounded: it is re-read on every
// run and nothing consumes entries older than the newest few dozen.
const MAX_ARCHIVED_RULES = 200;

export class RepetitionDetectionWorker {
  private readonly logger = createLogger("repetition-detection-worker");
  private readonly campaigns;
  private readonly messages;
  private readonly runs;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly connections;
  private readonly runtime;
  private readonly runtimeDefaults;

  constructor(dbFile: string, options?: { runtime?: ChatRuntime | null; runtimeDefaults?: ProviderRuntimeDefaults }) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.campaigns = new CampaignRepository(db);
    this.messages = new MessageRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.connections = new ProviderConnectionRepository(db);
    this.runtime = options?.runtime ?? null;
    this.runtimeDefaults = options?.runtimeDefaults ?? { anthropicApiKey: "", runnerUrl: "", runnerSecret: "", deepseekApiKey: "", fireworksApiKey: "", gmicloudApiKey: "", googleApiKey: "", moonshotApiKey: "", openaiApiKey: "", xaiApiKey: "", xiaomiApiKey: "", zaiApiKey: "", localEmbeddingUrl: "", localEmbeddingKey: "" };
  }

  async execute(run: { id: string; userId: string; campaignId: string; sessionId?: string | null; detailsJson?: string | null }, signal?: AbortSignal) {
    const now = new Date().toISOString();
    try {
      const inputs = pipelineInputsForRun(this.messages, run);
      const assertSource = () => inputs.assertCurrent();
      assertSource();
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, now, "campaign not found", null); return; }

      const sessionId = run.sessionId;
      if (!sessionId) { this.runs.markFailed(run.id, now, "no session for repetition detection", null); return; }

      const allMessages = inputs.readSession(sessionId).filter(m => m.role !== "cold-start");
      const recentTurns = allMessages.slice(-30).map(m => `[${m.role}]: ${m.content.trim()}`).join("\n\n");

      if (!recentTurns.trim()) {
        const doneAt = new Date().toISOString();
        this.runs.markCompleted(run.id, doneAt, "No messages to analyze", null);
        this.runs.updateRun(run.id, { approvedAt: doneAt });
        return;
      }

      const existingRules = this.getExistingRules(run.userId, run.campaignId);

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      // Model is session-scoped (Engine panel → context_overrides.repetitionModel,
      // threaded via detailsJson), no longer the campaign-level pipeline model.
      const details = run.detailsJson ? JSON.parse(run.detailsJson) as { repetitionModel?: string; workerEffort?: string; openaiFastMode?: boolean; maxAntiRepetitionRules?: number; antiRepArchiveAfter?: number } : {};
      // An unresolvable repetitionModel dial fails the run loudly.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "repetition_detection", "repetition detection", details.repetitionModel, getConfiguredDefaultModelId() ?? "claude-opus-4-6-bridge");
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, details.workerEffort);
      const speed = openaiFastModeFor(modelId, details.openaiFastMode);

      const prompt = [
        V4_REPETITION_DETECTION_PROMPT, "",
        "<transcript_window>", recentTurns, "</transcript_window>", "",
        "<existing_anti_repetition_rules>", existingRules || "None.", "</existing_anti_repetition_rules>",
      ].join("\n");

      let responseText = "";
      let inputTokens = 0, outputTokens = 0;
      this.runs.heartbeat(run.id);
      // Workers' dial convention: thinking off
      // with the explicit ladder effort, no cache — like every sibling worker.
      // This call used to send thinkingMode "adaptive" at effort "max" with no
      // cacheTtl (a 2026-05-06 shape that predates the convention), billing
      // thinking tokens on direct keys and running max-effort reasoning on the
      // bridges for a 50,000-char scan.
      await withDeadline(WORKER_LLM_DEADLINE_MS, "repetition-detection model call", (dl) => withRetry(() => runtime.streamChat({
        modelId,
        messages: [{ role: "user", content: prompt, attachments: [] }],
        temperature: 0,
        thinkingMode: workerThinkingModeFor(modelId, workerEffort),
        thinkingBudget: null,
        effort: workerEffort,
        cacheTtl: "off",
        speed,
        requestId: `repetition-detection-${run.id}`,
        signal: dl,
      }, {
        onStart: () => {},
        onDelta: (delta) => { responseText += delta; },
        onThinkingDelta: () => {},
        onComplete: (result) => {
          inputTokens = result.usage.inputTokens ?? 0;
          outputTokens = result.usage.outputTokens ?? 0;
        },
      }), () => { responseText = ""; }, signal), signal);

      // No-silent-failures: withRetry retries only transient API
      // errors — it does NOT retry an empty response. A stream that ends with
      // no text (a bridge that yields nothing, a refusal with no content) is a
      // failed run, not a quiet success that would settle the counter and
      // leave this window's rules un-derived. Sibling: recapWorker.
      if (!responseText.trim()) {
        this.runs.markFailed(run.id, new Date().toISOString(), `repetition detection model returned empty output (${modelId})`, null);
        return;
      }
      const rawRules = this.parseRules(responseText);
      let carriedForward = 0;
      let retiredCount = 0;
      // A non-empty response that still parses to zero rules is a parse failure.
      if (rawRules.length === 0) {
        recordSystemEvent({
          userId: run.userId, source: "repetition_detection", severity: "warn",
          campaignId: run.campaignId, sessionId: run.sessionId,
          message: "repetition detection produced 0 rules from a non-empty model response — likely a parse failure",
          details: { responseLen: responseText.length, head: responseText.slice(0, 200) },
        });
      }
      if (rawRules.length > 0) {
        // Both caps come from the resolved SESSION settings via detailsJson (0077).
        // They used to be read from campaign contextDefaults — a scope the Engine
        // panel never writes — so they silently fell back to these hardcoded
        // literals and changing either dial in the panel did nothing at all.
        const maxRules = (typeof details.maxAntiRepetitionRules === "number" && details.maxAntiRepetitionRules > 0) ? details.maxAntiRepetitionRules : 80;
        const archiveAfter = (typeof details.antiRepArchiveAfter === "number" && details.antiRepArchiveAfter > 0) ? details.antiRepArchiveAfter : 5;

        const previous = this.getPreviousRules(run.userId, run.campaignId);
        const previousArchive = this.getArchivedRules(run.userId, run.campaignId);
        // Carry-forward guard: the prompt's
        // "carry forward ALL existing rules" was unenforced — a well-formed
        // output that listed only the rules the model noticed silently deleted
        // the rest from the active set AND the archive. Every previous rule the
        // output does not account for is carried forward unchanged (frequency
        // 0, so dormancy still retires it over time); only an explicit
        // `status: "retired"` removes a rule, and that lands in the archive.
        const reconciled = reconcileRuleCarryForward(rawRules, previous);
        const deduped = deduplicateRules(reconciled.rules);
        const tracked = trackZeroStreak(deduped, previous);
        const { active, archived: newlyArchived } = archiveExpired(tracked, archiveAfter);
        const { kept, overflow } = enforceCap(active, maxRules);
        const fullArchive = mergeRuleArchive(previousArchive, [...newlyArchived, ...overflow, ...reconciled.retired], MAX_ARCHIVED_RULES);
        this.campaigns.transact(() => { assertSource(); this.applyRulesWithArchive(run.userId, run.campaignId, kept, fullArchive); });
        carriedForward = reconciled.carried.length;
        retiredCount = reconciled.retired.length;
        this.logger.info({ raw: rawRules.length, carried: reconciled.carried.length, retired: reconciled.retired.length, deduped: deduped.length, active: kept.length, archived: newlyArchived.length + overflow.length }, "post-processed anti-repetition rules");
        if (reconciled.carried.length > 0) {
          recordSystemEvent({
            userId: run.userId, source: "repetition_detection", severity: "info",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: `repetition detection omitted ${reconciled.carried.length} existing rule(s) from its output — carried forward unchanged (frequency 0); only an explicit "retired" status removes a rule`,
            details: { carried: reconciled.carried.length, topOmitted: reconciled.carried.slice(0, 5).map((r) => String(r.pattern ?? "").slice(0, 120)) },
          });
        }
        if (reconciled.retired.length > 0) {
          recordSystemEvent({
            userId: run.userId, source: "repetition_detection", severity: "info",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: `repetition detection retired ${reconciled.retired.length} rule(s) on the model's explicit say-so (kept in the archive)`,
            details: { retired: reconciled.retired.slice(0, 10).map((r) => ({ pattern: String(r.pattern ?? "").slice(0, 120), reason: String(r.retire_reason ?? "").slice(0, 200) })) },
          });
        }

        // NO-SILENT-FAILURES: dropping a rule that is STILL FIRING is data loss, not
        // housekeeping. The active list IS the model's working memory — it is handed
        // back verbatim as <existing_anti_repetition_rules> on the next run — so a
        // cap-evicted rule stops being visible to the model and never returns unless
        // it happens to be re-derived from scratch. And enforceCap ranks by frequency,
        // so the tail it drops is the LOW-frequency, most SPECIFIC rules: exactly the
        // ones doing the sharpest work.
        //
        // Not hypothetical. When 0077 made maxAntiRepetitionRules live, one campaign's
        // long-inert dial of 20 took effect and quietly shed live rules every run for
        // four days (233 total) before anyone noticed the prose getting worse.
        // Nothing logged it. Now it does.
        const evictedLive = overflow.filter((r) => (r.frequency ?? 0) > 0);
        if (evictedLive.length > 0) {
          recordSystemEvent({
            userId: run.userId, source: "repetition_detection", severity: "warn",
            campaignId: run.campaignId, sessionId: run.sessionId,
            message: `anti-repetition cap (${maxRules}) evicted ${evictedLive.length} rule(s) that were still firing — raise maxAntiRepetitionRules or these tics stop being policed`,
            details: {
              cap: maxRules, kept: kept.length, evictedLive: evictedLive.length,
              topEvicted: evictedLive.slice(0, 5).map((r) => ({ frequency: r.frequency, pattern: String(r.pattern ?? "").slice(0, 120) })),
            },
          });
        }
      }

      const doneAt = new Date().toISOString();
      this.runs.markCompleted(run.id, doneAt, `Processed ${rawRules.length} anti-repetition rules${carriedForward ? `, ${carriedForward} carried forward (omitted by the model)` : ""}${retiredCount ? `, ${retiredCount} retired` : ""}`, JSON.stringify({ rules: rawRules.length, carriedForward, retired: retiredCount, usage: { modelId, inputTokens, outputTokens } }));
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
        return;
      }
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "repetition detection failed", null);
    }
  }

  /** Anti-repetition rules are campaign-scoped STATE (this worker rewrites them
   *  every run), not a user setting — they live in `campaigns.anti_repetition_json`
   *  since 0077. Sitting inside the settings blob is exactly what made that blob
   *  look load-bearing while the real dials had already moved to the session. */
  private antiRepState(userId: string, campaignId: string): { antiRepetitionRules?: unknown; archivedAntiRepetitionRules?: unknown } {
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign?.antiRepetitionJson) return {};
    try { return JSON.parse(campaign.antiRepetitionJson) ?? {}; } catch { return {}; }
  }

  private getExistingRules(userId: string, campaignId: string): string | null {
    const rules = this.antiRepState(userId, campaignId).antiRepetitionRules;
    return rules ? JSON.stringify(rules) : null;
  }

  private getPreviousRules(userId: string, campaignId: string): any[] { // LLM-generated JSON
    const rules = this.antiRepState(userId, campaignId).antiRepetitionRules;
    return Array.isArray(rules) ? rules : [];
  }

  private getArchivedRules(userId: string, campaignId: string): any[] { // LLM-generated JSON
    const archived = this.antiRepState(userId, campaignId).archivedAntiRepetitionRules;
    return Array.isArray(archived) ? archived : [];
  }

  private parseRules(text: string): any[] { // LLM-generated JSON
    return parseRuleArray(text);
  }

  private applyRulesWithArchive(userId: string, campaignId: string, rules: any[], archived: any[]) { // LLM-generated JSON
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign) return;
    this.campaigns.updateCampaign(userId, campaignId, {
      antiRepetitionJson: JSON.stringify({ antiRepetitionRules: rules, archivedAntiRepetitionRules: archived }),
      updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * Fold newly archived rules into the existing archive: a rule the
 * model re-derives after archival used to be archived AGAIN as a duplicate on
 * every cycle, and nothing pruned the list, so `campaigns.anti_repetition_json`
 * grew without bound on long campaigns. Dedupes by normalized pattern (the
 * newer archival wins — it carries the fresher frequency/reason) and keeps the
 * newest `max` entries. Exported for tests.
 */
export function mergeRuleArchive(previous: any[], incoming: any[], max: number): any[] { // LLM-generated JSON
  const byPattern = new Map<string, any>(); // LLM-generated JSON
  for (const r of [...previous, ...incoming]) {
    if (!r || typeof r.pattern !== "string") continue;
    const norm = normalizePattern(r.pattern);
    byPattern.delete(norm); // re-insert so the newest sighting sits last
    byPattern.set(norm, r);
  }
  const merged = [...byPattern.values()];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Carry-forward reconciliation. Splits the model's output into
 * working rules and explicit retirements, then appends every PREVIOUS rule the
 * output did not account for — matched by normalized pattern (exact) or the
 * same >0.8 Jaccard word overlap `trackZeroStreak` uses — carried forward
 * unchanged except `frequency: 0` (the window did not report it, so dormancy
 * accounting proceeds as for a rule that did not fire). A retirement accounts
 * for its rule too (it is NOT carried) and lands in the archive with
 * `archived_reason: "retired"` and the model's `retire_reason`. Exported for tests.
 */
export function reconcileRuleCarryForward(raw: any[], previous: any[]): { rules: any[]; carried: any[]; retired: any[] } { // LLM-generated JSON
  const retiredRaw = raw.filter((r) => String(r?.status ?? "").toLowerCase() === "retired");
  const rules = raw.filter((r) => String(r?.status ?? "").toLowerCase() !== "retired");
  const accounted = raw.map((r) => { const norm = normalizePattern(String(r?.pattern ?? "")); return { norm, words: wordSet(norm) }; });
  const carried: any[] = []; // LLM-generated JSON
  for (const prev of previous) {
    if (!prev || typeof prev.pattern !== "string") continue;
    const norm = normalizePattern(prev.pattern);
    const words = wordSet(norm);
    const seen = accounted.some((a) => a.norm === norm || jaccardSimilarity(words, a.words) > 0.8);
    if (!seen) carried.push({ ...prev, frequency: 0 });
  }
  const now = new Date().toISOString();
  const retired = retiredRaw.map((r) => ({ ...r, status: "retired", archived_at: now, archived_reason: "retired" }));
  return { rules: [...rules, ...carried], carried, retired };
}

/** The rule array from the model's text via the shared extractor:
 *  the greedy first-`[`-to-last-`]` regex parsed to zero rules whenever a note
 *  containing `]` followed the array. Exported for tests. */
export function parseRuleArray(text: string): any[] { // LLM-generated JSON
  const parsed = parseFirstJson<unknown>(text, "[");
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((r: any) => r && typeof r.pattern === "string" && typeof r.replacement_guidance === "string");
}

/** Normalized identity of a rule pattern: Unicode letters and digits
 *  survive (the old `[^a-z0-9\s]` strip collapsed every non-Latin pattern to
 *  ""), and a pattern with no letters or digits at all — "—", "…" — keeps its
 *  own lowercased text so punctuation-only rules stay distinct instead of
 *  sharing the empty key. Exported for tests. */
export function normalizePattern(pattern: string): string {
  const stripped = pattern.split(/\s+[—–-]\s+e\.g\./)[0] ?? pattern;
  const lettered = stripped.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return lettered || stripped.toLowerCase().replace(/\s+/g, " ").trim();
}

function wordSet(text: string): Set<string> {
  return new Set(text.split(" ").filter(w => w.length >= 3));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  // An empty word set carries no evidence of similarity: two
  // punctuation-only patterns used to score 1 and dedupe into one.
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function rulePriority(r: any): number { // LLM-generated JSON
  const freq = r.frequency ?? 0;
  const typeScore = r.rule_type === "ban" ? 3 : r.rule_type === "limit" ? 2 : 1;
  const statusScore = r.status === "dormant" ? 0 : 1;
  return statusScore * 10000 + typeScore * 1000 + freq;
}

function deduplicateRules(rules: any[]): any[] { // LLM-generated JSON
  const normalized = rules.map(r => ({ rule: r, norm: normalizePattern(r.pattern), words: wordSet(normalizePattern(r.pattern)) }));
  const dropped = new Set<number>();
  for (let i = 0; i < normalized.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < normalized.length; j++) {
      if (dropped.has(j)) continue;
      if (jaccardSimilarity(normalized[i]!.words, normalized[j]!.words) > 0.55) {
        const keepI = rulePriority(normalized[i]!.rule) >= rulePriority(normalized[j]!.rule);
        dropped.add(keepI ? j : i);
        if (!keepI) break;
      }
    }
  }
  return normalized.filter((_, idx) => !dropped.has(idx)).map(n => n.rule);
}

function trackZeroStreak(rules: any[], previous: any[]): any[] { // LLM-generated JSON
  const prevMap = new Map<string, any>(); // LLM-generated JSON
  for (const r of previous) {
    const norm = normalizePattern(r.pattern);
    const words = wordSet(norm);
    prevMap.set(norm, { rule: r, words });
  }
  return rules.map(r => {
    const norm = normalizePattern(r.pattern);
    const words = wordSet(norm);
    let prev: any = prevMap.get(norm)?.rule; // LLM-generated JSON
    if (!prev) {
      for (const [, entry] of prevMap) {
        if (jaccardSimilarity(words, entry.words) > 0.8) { prev = entry.rule; break; }
      }
    }
    const freq = r.frequency ?? 0;
    const prevStreak = prev?.zero_streak ?? 0;
    return { ...r, zero_streak: freq === 0 ? prevStreak + 1 : 0 };
  });
}

// `archived_reason` separates the two very different ways a rule leaves the active
// set: "dormant" is the designed retirement (it stopped firing for `threshold`
// consecutive runs and has earned its exit), while "cap_overflow" is a live rule
// pushed out by the ceiling. Without the tag the archive conflates them and the
// second class is invisible — which is how a 75% cap cut hid for four days.
export function archiveExpired(rules: any[], threshold: number): { active: any[]; archived: any[] } { // LLM-generated JSON
  const active: any[] = []; // LLM-generated JSON
  const archived: any[] = []; // LLM-generated JSON
  for (const r of rules) {
    if ((r.zero_streak ?? 0) >= threshold) archived.push({ ...r, archived_at: new Date().toISOString(), archived_reason: "dormant" });
    else active.push(r);
  }
  return { active, archived };
}

export function enforceCap(rules: any[], max: number): { kept: any[]; overflow: any[] } { // LLM-generated JSON
  if (rules.length <= max) return { kept: rules, overflow: [] };
  const sorted = [...rules].sort((a, b) => rulePriority(b) - rulePriority(a));
  return { kept: sorted.slice(0, max), overflow: sorted.slice(max).map(r => ({ ...r, archived_at: new Date().toISOString(), archived_reason: "cap_overflow" })) };
}
