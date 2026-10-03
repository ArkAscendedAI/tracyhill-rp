import { pipelineInputsForRun } from "../context/settledSourceGuard";
import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { getConfiguredDefaultModelId, openaiFastModeFor, workerEffortFor, workerThinkingModeFor } from "@tracyhill-rp/model-catalog";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import { ProviderConnectionRepository } from "../../../api/src/domain/subscriptions/providerConnectionRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { createId } from "../../../api/src/lib/ids";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";
import { V4_SYSPROMPT_UPDATE_PROMPT } from "./pipelinePrompts";
import { withRetry, withDeadline, WORKER_LLM_DEADLINE_MS } from "./retryHelper";
import { resolveWorkerModel } from "../context/workerModel";

const SYSPROMPT_REVIEW_SYSTEM = `You are the ADVERSARIAL REVIEWER for an automated system-prompt rewrite on a roleplay campaign. The rewrite will be applied WITHOUT human approval if you accept it. Default to rejection.

REJECT unless ALL of these hold:
1. VOICE + STRUCTURE preserved — same authorial voice, same organization; a rewrite that flattens the owner's style is a rejection.
2. NO load-bearing rule dropped or weakened without clear justification in the recent turns (formatting contracts, scene rules, content boundaries, character-handling rules are all load-bearing).
3. Every change is GROUNDED in the recent turns — no speculative additions, no rules for problems that never occurred.
4. No contradiction with the campaign's established canon as the prompt itself states it.
5. WORLD AUTHORITY preserved — never introduce guidance that contradicts the runtime world-authority norms or the PC-will boundary; never add rules that forbid the narrator from moving the world. Yielding the floor governs conversation, not reality.
Accept only a rewrite a careful owner would have made themselves.

Output ONLY JSON: {"ok": true} or {"ok": false, "reason": "one line"}.`;

/**
 * Is the model's response the no-change verdict? The prompt asks for EXACTLY
 * `NO_CHANGES_NEEDED`, but models append commentary ("NO_CHANGES_NEEDED\n\nThe
 * prompt remains accurate.") — the old whole-response anchor then treated that
 * as a rewrite candidate, tripped the <50%-length guard, and FAILED the run
 * (an error event, and an every-turn re-run). The sentinel on its own FIRST
 * non-empty line is the verdict; a real rewrite never starts with it.
 * Exported for tests.
 */
export function isNoChangesResponse(responseText: string): boolean {
  const firstLine = responseText.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return /^(NO_CHANGES_NEEDED|no changes needed\.?|no changes\.?)$/i.test(firstLine);
}

/**
 * Strip ONE code fence that encloses the whole response: the prompt
 * asks for "the COMPLETE revised system prompt as a full markdown document" and
 * a model that wraps it in ```markdown … ``` passed both guards, so the live
 * campaign prompt began with a fence line. Only a clean enclosing pair is
 * stripped — a body that itself contains ``` (a prompt with code blocks) is
 * left alone; `isFenced` then reports it so the run rejects instead of saving
 * a fenced prompt. Exported for tests.
 */
export function stripEnclosingFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  if (!match || match[1]!.includes("```")) return trimmed;
  return match[1]!.trim();
}

/** A candidate that still starts with a fence after the strip is not a
 *  system prompt; the run must reject it rather than save it. */
export function isFenced(text: string): boolean {
  return /^```/.test(text.trim());
}

// The window the rewrite and its reviewer read: the
// turns played since the last completed audit, newest kept first when the span
// is over this many characters. The audit is triggered every
// `syspromptAuditCharThreshold` (default 100,000) characters of replies, so a
// typical span fits; before 2026-09-29 the worker read only the last 20
// messages while the prompt promised "the turns played since the last review".
export const SYSPROMPT_AUDIT_WINDOW_MAX_CHARS = 150_000;

export interface SyspromptAuditWindow<T> {
  rows: T[];
  /** Messages in the span since the last review left out by the cap. */
  dropped: number;
  chars: number;
  /** Where the span starts: after the previous completed audit of this session, or the session's first turn. */
  since: "last-review" | "session-start";
}

/** Rows after `coveredThroughSortOrder` (all rows when null), trimmed from the
 *  oldest end to `maxChars` of content; the newest message is always kept.
 *  Exported for tests. */
export function syspromptAuditWindow<T extends { sortOrder: number; content: string }>(rows: T[], coveredThroughSortOrder: number | null, maxChars = SYSPROMPT_AUDIT_WINDOW_MAX_CHARS): SyspromptAuditWindow<T> {
  const span = coveredThroughSortOrder == null ? rows : rows.filter((row) => row.sortOrder > coveredThroughSortOrder);
  const kept: T[] = [];
  let chars = 0;
  for (let index = span.length - 1; index >= 0; index -= 1) {
    const size = span[index]!.content.length;
    if (kept.length > 0 && chars + size > maxChars) break;
    kept.unshift(span[index]!);
    chars += size;
  }
  return { rows: kept, dropped: span.length - kept.length, chars, since: coveredThroughSortOrder == null ? "session-start" : "last-review" };
}

/** The sort order the previous completed audit read through in `sessionId`,
 *  or null when there is none in this session (a first audit, or the last one
 *  ran in another session). A run completed since 2026-09-29 carries it as
 *  `window.throughSortOrder`. An older completed run kept no marker
 *  (markCompleted replaced its details, settled source included), so its
 *  coverage is the newest reply of its session created before it was queued:
 *  the audit is queued when the next user turn settles that reply.
 *  Exported for tests. */
export function previousAuditCoverage(
  previous: { sessionId?: string | null; requestedAt?: string | null; detailsJson?: string | null } | null | undefined,
  sessionId: string,
  rows: Array<{ role: string; sortOrder: number; createdAt: string }>,
): number | null {
  if (!previous) return null;
  try {
    const details = previous.detailsJson ? JSON.parse(previous.detailsJson) as { window?: { sessionId?: unknown; throughSortOrder?: unknown } } : {};
    if (details.window) {
      return details.window.sessionId === sessionId && Number.isInteger(details.window.throughSortOrder) ? details.window.throughSortOrder as number : null;
    }
  } catch { /* unreadable details: fall back to the queue time */ }
  if (previous.sessionId !== sessionId || !previous.requestedAt) return null;
  let covered: number | null = null;
  for (const row of rows) {
    if (row.role === "assistant" && row.createdAt < previous.requestedAt && (covered == null || row.sortOrder > covered)) covered = row.sortOrder;
  }
  return covered;
}

export class SyspromptAuditWorker {
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
      if (!sessionId) { this.runs.markFailed(run.id, now, "no session for sysprompt audit", null); return; }

      const allMessages = inputs.readSession(sessionId).filter(m => m.role !== "cold-start");
      // The turns played since the last completed review of this campaign's
      // prompt, in this session, capped from the oldest end.
      const coveredThrough = previousAuditCoverage(this.runs.findLatestCompletedByKindAndCampaign("sysprompt_audit", run.campaignId), sessionId, allMessages);
      const window = syspromptAuditWindow(allMessages, coveredThrough);
      const windowNote = window.dropped > 0
        ? `[${window.dropped} earlier message(s) played since the last review are left out: the window keeps the newest ${SYSPROMPT_AUDIT_WINDOW_MAX_CHARS.toLocaleString("en-US")} characters.]\n\n`
        : "";
      const recentTurns = window.rows.map(m => `[${m.role}]: ${m.content.trim()}`).join("\n\n");
      const windowDetails = {
        sessionId, since: window.since, coveredThroughBefore: coveredThrough,
        fromSortOrder: window.rows[0]?.sortOrder ?? null, throughSortOrder: window.rows.at(-1)?.sortOrder ?? coveredThrough,
        messages: window.rows.length, chars: window.chars, dropped: window.dropped,
      };

      if (!recentTurns.trim()) {
        const doneAt = new Date().toISOString();
        this.runs.markCompleted(run.id, doneAt, coveredThrough == null ? "No messages to audit" : "No turns played since the last review", JSON.stringify({ window: windowDetails }));
        this.runs.updateRun(run.id, { approvedAt: doneAt });
        return;
      }

      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      // Model is session-scoped (Engine panel → context_overrides.syspromptAuditModel,
      // threaded via detailsJson), no longer the campaign-level pipeline model.
      const details = run.detailsJson ? JSON.parse(run.detailsJson) as { syspromptAuditModel?: string; workerEffort?: string; openaiFastMode?: boolean } : {};
      // An unresolvable syspromptAuditModel dial fails the run loudly.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "sysprompt_audit", "sysprompt audit", details.syspromptAuditModel, getConfiguredDefaultModelId() ?? "claude-opus-4-6-bridge");
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, details.workerEffort);
      const speed = openaiFastModeFor(modelId, details.openaiFastMode);

      const prompt = [
        V4_SYSPROMPT_UPDATE_PROMPT, "",
        "NON-NEGOTIABLE PLATFORM CONTRACT: Never introduce guidance that contradicts the world-authority norms or the PC-will boundary; never add rules that forbid the narrator from moving the world. The player's choices, words, thoughts, and feelings remain inviolate, while involuntary physical/sensory consequences and world events remain narratable.", "",
        "<current_system_prompt>", campaign.systemPrompt, "</current_system_prompt>", "",
        "<new_transcript_window>", `${windowNote}${recentTurns}`, "</new_transcript_window>",
      ].join("\n");

      // Capture the pre-LLM-call expected version/prompt so the version
      // bump can guard against a concurrent edit (TOCTOU). The LLM rewrite is
      // based on THIS prompt; if the campaign changed underneath us during the
      // long stream, the bump must abort rather than clobber the new edit.
      const expectedVersion = campaign.version;
      const expectedPrompt = campaign.systemPrompt;

      let responseText = "";
      let inputTokens = 0, outputTokens = 0;
      this.runs.heartbeat(run.id);
      // Workers' dial convention: the rewrite
      // call now sends the same dials as its own adversarial reviewer and every
      // sibling worker — thinking off with the explicit ladder effort, no cache
      // — instead of thinkingMode "adaptive" at effort "max" with no cacheTtl.
      await withDeadline(WORKER_LLM_DEADLINE_MS, "sysprompt-audit model call", (dl) => withRetry(() => runtime.streamChat({
        modelId,
        messages: [{ role: "user", content: prompt, attachments: [] }],
        temperature: 0,
        thinkingMode: workerThinkingModeFor(modelId, workerEffort),
        thinkingBudget: null,
        effort: workerEffort,
        cacheTtl: "off",
        speed,
        requestId: `sysprompt-audit-${run.id}`,
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

      // A single enclosing fence is stripped before every verdict.
      const unfenced = stripEnclosingFence(responseText);
      const noChanges = isNoChangesResponse(unfenced);
      const doneAt = new Date().toISOString();

      if (noChanges) {
        this.runs.markCompleted(run.id, doneAt, "System prompt audit — no changes needed", JSON.stringify({ noChanges: true, usage: { modelId, inputTokens, outputTokens }, window: windowDetails }));
        this.runs.updateRun(run.id, { approvedAt: doneAt });
        return;
      }

      // Safety guard (2026-06-07): never persist a degenerate response as the
      // system prompt. During the 4.8-bridge outage the model "response" was the
      // bridge's injected error string (e.g. "*[error: agent stream ended
      // without result event]*"), and the old code saved it verbatim — wiping
      // the Mara and Red Rising campaign prompts. Reject error-shaped output or
      // an implausibly short rewrite (< 50% of the current prompt); the run
      // fails and the live prompt is left untouched.
      const candidate = unfenced;
      const looksLikeError =
        /\*?\[error:/i.test(candidate) ||
        /agent stream ended without result event/i.test(candidate) ||
        /Claude Code (process exited|returned an error)/i.test(candidate);
      const tooShort = candidate.length < Math.floor(campaign.systemPrompt.length * 0.5);
      const fenced = isFenced(candidate);
      if (looksLikeError || tooShort || fenced) {
        const reason = looksLikeError
          ? "output looks like an error message"
          : fenced
            ? "output is wrapped in a code fence that could not be stripped cleanly — not a system prompt"
            : `output too short (${candidate.length} chars < 50% of current ${campaign.systemPrompt.length})`;
        this.runs.markFailed(run.id, doneAt, `sysprompt audit rejected — ${reason}`, null);
        return;
      }

      // Adversarial gate: this worker SELF-APPLIES its
      // rewrite, so a reviewer pass stands between the rewrite and the write.
      // Reject → run fails loudly, live prompt untouched. Unparseable reviewer
      // output = reject (fail-closed — this is a write gate, not a finding).
      const review = await this.adversarialReview(runtime, modelId, workerEffort, speed, run.id, campaign.systemPrompt, candidate, recentTurns, signal);
      if (!review.ok) {
        this.runs.markFailed(run.id, new Date().toISOString(), `sysprompt audit rejected by adversarial reviewer — ${review.reason}`, null);
        recordSystemEvent({
          userId: run.userId, source: "sysprompt_audit", severity: "info", campaignId: run.campaignId,
          message: `adversarial reviewer rejected the sysprompt rewrite: ${review.reason}`,
          details: { runId: run.id },
        });
        // Three consecutive reviewer rejections means the audit is
        // effectively disabled — surface it instead of failing quietly forever.
        const recent = this.runs.listForCampaign(run.userId, run.campaignId)
          .filter((r) => r.kind === "sysprompt_audit")
          .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
          .slice(0, 3);
        if (recent.length === 3 && recent.every((r) => r.status === "failed" && (r.error ?? "").includes("adversarial reviewer"))) {
          recordSystemEvent({
            userId: run.userId, source: "sysprompt_audit", severity: "error", campaignId: run.campaignId,
            message: "sysprompt audit is STUCK — 3 consecutive adversarial-reviewer rejections; the auto path is effectively disabled for this campaign",
            details: { runId: run.id },
          });
        }
        return;
      }

      // Atomic: archive the prior version AND bump the live campaign in one
      // transaction so we can't end up with a version row pointing at the
      // wrong prompt if the second write fails.
      // Guarded against concurrent edits: bumpVersionWithArchive only
      // writes when the campaign is still at expectedVersion. A racing manual
      // edit (or another audit) bumps the version, the guard sees changes===0,
      // and we fail the run instead of overwriting the newer prompt.
      const bumped = this.campaigns.transact(() => {
        assertSource();
        return this.campaigns.bumpVersionWithArchive(run.userId, run.campaignId, {
        archive: {
          id: createId(), campaignId: campaign.id, userId: run.userId,
          version: expectedVersion, systemPrompt: expectedPrompt,
          createdAt: doneAt, label: null,
        },
        nextSystemPrompt: candidate,
        nextVersion: expectedVersion + 1,
        updatedAt: doneAt,
        expectedVersion,
        expectedPrompt,
        });
      });
      if (!bumped) {
        this.runs.markFailed(run.id, doneAt, "sysprompt audit aborted — campaign edited concurrently", null);
        return;
      }

      this.runs.markCompleted(run.id, doneAt, `System prompt updated to v${expectedVersion + 1}`, JSON.stringify({ noChanges: false, usage: { modelId, inputTokens, outputTokens }, window: windowDetails }));
      this.runs.updateRun(run.id, { approvedAt: doneAt });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
        return;
      }
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "sysprompt audit failed", null);
    }
  }

  private async adversarialReview(runtime: ChatRuntime, modelId: string, workerEffort: ReturnType<typeof workerEffortFor>, speed: "fast" | undefined, runId: string, current: string, candidate: string, recentTurns: string, signal?: AbortSignal): Promise<{ ok: boolean; reason: string }> {
    const user = `<current_system_prompt>\n${current}\n</current_system_prompt>\n\n<proposed_rewrite>\n${candidate}\n</proposed_rewrite>\n\n<recent_turns>\n${recentTurns}\n</recent_turns>`;
    let text = "";
    this.runs.heartbeat(runId);
    await withDeadline(WORKER_LLM_DEADLINE_MS, "sysprompt adversarial review call", (dl) => withRetry(() => runtime.streamChat({
      modelId, systemPrompt: SYSPROMPT_REVIEW_SYSTEM,
      messages: [{ role: "user", content: user, attachments: [] }],
      temperature: 0, thinkingMode: workerThinkingModeFor(modelId, workerEffort), thinkingBudget: null, effort: workerEffort, cacheTtl: "off", speed,
      requestId: `sysprompt-audit-${runId}-review`, signal: dl,
    }, { onStart: () => {}, onDelta: (d) => { text += d; }, onThinkingDelta: () => {}, onComplete: () => {} }), () => { text = ""; }, signal), signal);
    const parsed = parseFirstJson<{ ok?: boolean; reason?: string }>(text, "{");
    if (typeof parsed?.ok !== "boolean") return { ok: false, reason: "reviewer output unparseable" };
    return { ok: parsed.ok, reason: parsed.reason ? String(parsed.reason) : parsed.ok ? "" : "rejected" };
  }
}
