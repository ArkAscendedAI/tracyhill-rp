import { randomUUID } from "node:crypto";

import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { getDefaultChatModelId } from "@tracyhill-rp/model-catalog";

import { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import {
  createDefaultPipelineRunDetails,
  parsePipelineRunDetails,
  PipelineRunRepository,
  type StoredPipelineRunDetails,
} from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { ArtifactRepository } from "../../../api/src/domain/pipeline/artifactRepository";
import { pipelineStreamBus, type PipelineStreamStep } from "../../../api/src/domain/pipeline/pipelineStreamBus";
import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { RollingDiffWorker } from "../context/rollingDiffWorker";
import { LorebookConsolidationWorker } from "../context/lorebookConsolidationWorker";
import { LorebookArchivalWorker } from "../context/lorebookArchivalWorker";
import { ThreadTrackerWorker } from "../context/threadTrackerWorker";
import { RepetitionDetectionWorker } from "./repetitionDetectionWorker";
import { SyspromptAuditWorker } from "./syspromptAuditWorker";
import { DEEP_REFRESH_LOREBOOK_PROMPT } from "../context/deepRefreshPrompts";
import { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { MessageRepository } from "../../../api/src/domain/chat/messageRepository";
import { deserializeSceneData, serializeSceneForContext } from "../../../api/src/domain/chat/sceneParser";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";
import {
  V4_ANALYSIS_PROMPT,
  V4_SYSPROMPT_UPDATE_PROMPT,
  V4_REPETITION_DETECTION_PROMPT,
} from "./pipelinePrompts";

export type PipelineWorkerOptions = {
  runtime?: ChatRuntime | null;
  runtimeDefaults?: ProviderRuntimeDefaults;
};

export class PipelineWorker {
  private readonly logger = createLogger("tracyhill-rp-v2-worker");
  private readonly campaigns;
  private readonly sessions;
  private readonly messages;
  private readonly runs;
  private readonly artifacts;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly runtime: ChatRuntime | null | undefined;
  private readonly runtimeDefaults;
  private readonly rollingDiffWorker;
  private readonly lorebookConsolidationWorker;
  private readonly lorebookArchivalWorker;
  private readonly threadTrackerWorker;
  private readonly repetitionDetectionWorker;
  private readonly syspromptAuditWorker;
  private readonly lorebook;
  private readonly activeRuns = new Map<string, AbortController>();
  private drainCount = 0;
  private ticking = false;
  private currentStreamCtx: { runId: string; step: PipelineStreamStep } | null = null;

  constructor(dbFile: string, options?: PipelineWorkerOptions) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.campaigns = new CampaignRepository(db);
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
    this.runs = new PipelineRunRepository(db);
    this.artifacts = new ArtifactRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
    this.rollingDiffWorker = new RollingDiffWorker(dbFile, options);
    this.lorebookConsolidationWorker = new LorebookConsolidationWorker(dbFile, options);
    this.lorebookArchivalWorker = new LorebookArchivalWorker(dbFile, options);
    this.threadTrackerWorker = new ThreadTrackerWorker(dbFile, options);
    this.repetitionDetectionWorker = new RepetitionDetectionWorker(dbFile, options);
    this.syspromptAuditWorker = new SyspromptAuditWorker(dbFile, options);
    this.lorebook = new LorebookRepository(db);
    this.runtime = options?.runtime;
    this.runtimeDefaults = options?.runtimeDefaults ?? {
      anthropicApiKey: "",
      claudeCodeBridgeUrl: "",
      claudeCodeBridgeSecret: "",
      deepseekApiKey: "",
      googleApiKey: "",
      openaiApiKey: "",
      xaiApiKey: "",
      xiaomiApiKey: "",
      zaiApiKey: "",
    };
  }

  kick() {
    if (this.ticking) return;
    this.ticking = true;
    queueMicrotask(async () => {
      try {
        await this.drain();
      } catch (err) {
        // Last-resort guard: an unhandled rejection here under INLINE_WORKERS=1
        // would crash the API process. Log and survive; the next kick() will retry.
        this.logger.error({ err }, "pipeline drain failed");
      } finally {
        this.ticking = false;
      }
    });
  }

  async drain() {
    while (await this.runNext()) {
      this.drainCount++;
      if (this.drainCount % 10 === 0) {
        try { this.sweepStaleLocks(); } catch {}
      }
    }
  }

  private sweepStaleLocks() {
    const cutoffMs = 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - cutoffMs).toISOString();
    const stale = this.runs.findStaleRunningJobs(cutoff);
    for (const run of stale) {
      this.logger.warn({ runId: run.id, kind: run.kind, startedAt: run.startedAt }, "stale lock timeout");
      this.runs.markFailed(run.id, new Date().toISOString(), "stale lock timeout (60 min)", null);
    }
  }

  cancelRun(runId: string) {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async runNext() {
    const next = this.runs.findNextQueuedRespectingCampaignLock();
    if (!next) return false;
    const startedAt = new Date().toISOString();
    if (!this.runs.markRunning(next.id, startedAt)) return true;

    if (next.kind === "rolling_diff") {
      await this.rollingDiffWorker.execute({ id: next.id, userId: next.userId, campaignId: next.campaignId, sessionId: next.sessionId, detailsJson: next.detailsJson });
      try { if (next.sessionId) this.sessions.resetPipelineCounter(next.sessionId, "rolling_diff"); } catch {}
      return true;
    }

    if (next.kind === "repetition_detection") {
      await this.repetitionDetectionWorker.execute({ id: next.id, userId: next.userId, campaignId: next.campaignId, sessionId: next.sessionId });
      try { if (next.sessionId) this.sessions.resetPipelineCounter(next.sessionId, "repetition_detection"); } catch {}
      return true;
    }

    if (next.kind === "sysprompt_audit") {
      await this.syspromptAuditWorker.execute({ id: next.id, userId: next.userId, campaignId: next.campaignId, sessionId: next.sessionId });
      try { if (next.sessionId) this.sessions.resetPipelineCounter(next.sessionId, "sysprompt_audit"); } catch {}
      return true;
    }

    if (next.kind === "lorebook_consolidation") {
      await this.lorebookConsolidationWorker.execute({ id: next.id, userId: next.userId, campaignId: next.campaignId, sessionId: next.sessionId, detailsJson: next.detailsJson });
      return true;
    }

    if (next.kind === "lorebook_archival") {
      await this.lorebookArchivalWorker.execute({ id: next.id, userId: next.userId, campaignId: next.campaignId, sessionId: next.sessionId, detailsJson: next.detailsJson });
      return true;
    }

    if (next.kind === "thread_tracker") {
      await this.threadTrackerWorker.execute({ id: next.id, userId: next.userId, campaignId: next.campaignId, sessionId: next.sessionId, detailsJson: next.detailsJson });
      return true;
    }

    let details = parsePipelineRunDetails(next.detailsJson);
    const abortController = new AbortController();
    this.activeRuns.set(next.id, abortController);
    const stopWatching = this.watchForCancellation(next.userId, next.id, abortController);
    try {
      const campaign = this.campaigns.findById(next.userId, next.campaignId);
      if (!campaign) {
        details.steps.analysis = { status: "failed", result: null, error: "campaign missing at execution time" };
        this.runs.markFailed(next.id, new Date().toISOString(), "campaign missing at execution time", JSON.stringify(details));
        return true;
      }

      const runtime = this.runtime !== undefined ? this.runtime : createChatRuntimeForUser(this.providerKeys, this.customEndpoints, next.userId, this.runtimeDefaults);
      const creativeModelId = resolveChatModelConfig(this.customEndpoints, next.userId, details.models?.creativeModelId ?? campaign.pipelineModelId)?.id ?? getDefaultChatModelId();

      // Resolve retry context
      const retrySource = details.review.retriedFromRunId ? this.runs.findById(next.userId, details.review.retriedFromRunId) : null;
      const retrySourceDetails = retrySource ? parsePipelineRunDetails(retrySource.detailsJson) : null;
      const retryMode = details.review.retriedFromStep;
      const savedModels = details.models;
      const savedWatermarkBefore = details.review.watermarkBefore;
      const savedWatermarkAfter = details.review.watermarkAfter;
      details = createDefaultPipelineRunDetails();
      details.models = savedModels;
      details.review.retriedFromRunId = retrySource?.id ?? null;
      details.review.retriedFromStep = retryMode;
      details.review.watermarkBefore = savedWatermarkBefore;
      details.review.watermarkAfter = savedWatermarkAfter;

      if (retryMode === "fromLorebookRefresh" || retryMode === "fromSysprompt") {
        const analysisReport = retrySourceDetails?.review.analysisReport?.trim();
        if (analysisReport) {
          details.steps.analysis = { status: "completed", result: analysisReport, error: null };
          details.review.analysisReport = analysisReport;
        }
      }
      if (retryMode === "fromSysprompt") {
        const lorebookOps = retrySourceDetails?.review.lorebookOperations;
        if (lorebookOps) {
          details.steps.lorebookRefresh = { status: "completed", result: lorebookOps, error: null };
          details.review.lorebookOperations = lorebookOps;
        }
      }

      // Build incremental transcript: only messages after the watermark
      // For retries, use the source run's watermark range so we re-process the same transcript
      const overrideWatermark = retryMode ? savedWatermarkBefore : undefined;
      const { transcript, watermarkBefore, watermarkAfter } = this.buildIncrementalTranscript(next.userId, next.campaignId, next.sessionId, overrideWatermark);
      details.review.watermarkBefore = savedWatermarkBefore ?? watermarkBefore;
      details.review.watermarkAfter = savedWatermarkAfter ?? watermarkAfter;
      this.persist(next.id, details);

      if (!transcript.trim()) {
        this.runs.markCompleted(next.id, new Date().toISOString(), "No new messages to audit.", JSON.stringify(details));
        return true;
      }

      const lorebookEntries = this.lorebook.listEnabledForCampaign(next.userId, next.campaignId);
      const lorebookSummary = this.buildLorebookSummary(lorebookEntries);

      // ═══════════════════════════════════════════════
      // Pass 1 — Incremental Analysis (creative model)
      // ═══════════════════════════════════════════════
      if (details.steps.analysis?.status !== "completed") {
        details.steps.analysis = { status: "running", result: null, error: null };
        this.persist(next.id, details);
        const analysisPrompt = [
          V4_ANALYSIS_PROMPT, "",
          "<lorebook_entries>", lorebookSummary, "</lorebook_entries>", "",
          "<system_prompt>", campaign.systemPrompt, "</system_prompt>", "",
          "<new_transcript_window>", transcript, "</new_transcript_window>",
        ].join("\n");
        const analysisReport = await this.withStreamCtx(next.id, "analysis", () =>
          this.runModelPrompt(runtime, creativeModelId, analysisPrompt, () => "Analysis not available (no runtime).", abortController.signal),
        );
        details.steps.analysis = { status: "completed", result: analysisReport, error: null };
        details.review.analysisReport = analysisReport;
        this.persist(next.id, details);
      }

      const analysisReport = details.review.analysisReport ?? "";

      // ═══════════════════════════════════════════════
      // Pass 2 — Lorebook Audit & Refresh (creative model)
      // ═══════════════════════════════════════════════
      if (details.steps.lorebookRefresh?.status !== "completed") {
        details.steps.lorebookRefresh = { status: "running", result: null, error: null };
        this.persist(next.id, details);
        const lorebookPrompt = [
          DEEP_REFRESH_LOREBOOK_PROMPT, "",
          "<analysis_report>", analysisReport, "</analysis_report>", "",
          "<existing_lorebook_entries>", lorebookSummary, "</existing_lorebook_entries>", "",
          "<new_transcript_window>", transcript, "</new_transcript_window>",
        ].join("\n");
        const lorebookResult = await this.withStreamCtx(next.id, "lorebookRefresh", () =>
          this.runModelPrompt(runtime, creativeModelId, lorebookPrompt, () => '[{"op":"NOOP"}]', abortController.signal),
        );
        details.steps.lorebookRefresh = { status: "completed", result: lorebookResult, error: null };
        details.review.lorebookOperations = lorebookResult;
        this.persist(next.id, details);
      }

      // ═══════════════════════════════════════════════
      // Pass 3 — System Prompt Audit (creative model)
      // ═══════════════════════════════════════════════
      if (details.steps.syspromptUpdate?.status !== "completed") {
        try {
          details.steps.syspromptUpdate = { status: "running", result: null, error: null };
          this.persist(next.id, details);
          const syspromptPrompt = [
            V4_SYSPROMPT_UPDATE_PROMPT, "",
            "<current_system_prompt>", campaign.systemPrompt, "</current_system_prompt>", "",
            "<lorebook_operations>", details.review.lorebookOperations ?? "No lorebook changes.", "</lorebook_operations>", "",
            "<new_transcript_window>", transcript, "</new_transcript_window>", "",
            "<analysis_report>", analysisReport, "</analysis_report>",
          ].join("\n");
          const syspromptResult = await this.withStreamCtx(next.id, "syspromptUpdate", () =>
            this.runModelPrompt(runtime, creativeModelId, syspromptPrompt, () => "NO_CHANGES_NEEDED", abortController.signal),
          );
          const noChanges = this.systemPromptNoChanges(syspromptResult);
          details.steps.syspromptUpdate = { status: "completed", result: syspromptResult, error: null };
          details.review.syspromptNoChanges = noChanges;
          // 06-07 guard (same class as syspromptAuditWorker): never let an
          // error-shaped or implausibly short rewrite become the approvable
          // draft — approveCampaignRun writes it into the live campaign.
          const candidate = (syspromptResult ?? "").trim();
          const draftLooksLikeError =
            /\*?\[error:/i.test(candidate) ||
            /agent stream ended without result event/i.test(candidate) ||
            /Claude Code (process exited|returned an error)/i.test(candidate);
          const draftTooShort = candidate.length < Math.floor((campaign.systemPrompt ?? "").length * 0.5);
          if (!noChanges && (draftLooksLikeError || draftTooShort)) {
            details.steps.syspromptUpdate = {
              status: "failed",
              result: null,
              error: draftLooksLikeError
                ? "sysprompt rewrite rejected — output looks like an error message"
                : `sysprompt rewrite rejected — output too short (${candidate.length} chars < 50% of current ${(campaign.systemPrompt ?? "").length})`,
            };
            details.review.systemPromptDraft = campaign.systemPrompt;
            details.review.syspromptNoChanges = true;
          } else {
            details.review.systemPromptDraft = noChanges ? campaign.systemPrompt : syspromptResult;
          }
          this.persist(next.id, details);
        } catch (stepErr) {
          if (abortController.signal.aborted || (stepErr instanceof Error && stepErr.name === "AbortError")) throw stepErr;
          details.steps.syspromptUpdate = { status: "failed", result: null, error: humanizeError(stepErr) };
          details.review.systemPromptDraft = campaign.systemPrompt;
          this.persist(next.id, details);
        }
      }

      // ═══════════════════════════════════════════════
      // Pass 4 — Repetition Detection (creative model)
      // ═══════════════════════════════════════════════
      if (details.steps.repetitionDetection?.status !== "completed") {
        try {
          details.steps.repetitionDetection = { status: "running", result: null, error: null };
          this.persist(next.id, details);
          const existingRules = this.getExistingAntiRepetitionRules(next.userId, next.campaignId);
          const repetitionPrompt = [
            V4_REPETITION_DETECTION_PROMPT, "",
            "<transcript_window>", transcript, "</transcript_window>", "",
            "<existing_anti_repetition_rules>", existingRules || "None.", "</existing_anti_repetition_rules>",
          ].join("\n");
          const repetitionResult = await this.withStreamCtx(next.id, "repetitionDetection", () =>
            this.runModelPrompt(runtime, creativeModelId, repetitionPrompt, () => "[]", abortController.signal),
          );
          details.steps.repetitionDetection = { status: "completed", result: repetitionResult, error: null };
          details.review.antiRepetitionRules = repetitionResult;
          this.persist(next.id, details);
        } catch (stepErr) {
          if (abortController.signal.aborted || (stepErr instanceof Error && stepErr.name === "AbortError")) throw stepErr;
          details.steps.repetitionDetection = { status: "failed", result: null, error: humanizeError(stepErr) };
          this.persist(next.id, details);
        }
      }

      // ═══════════════════════════════════════════════
      // Complete
      // ═══════════════════════════════════════════════
      const failedSteps = Object.entries(details.steps)
        .filter(([, step]) => step?.status === "failed")
        .map(([name]) => name);
      const completedAt = new Date().toISOString();
      const creativeLabel = resolveChatModelConfig(this.customEndpoints, next.userId, creativeModelId)?.label ?? creativeModelId;
      const summaryParts: string[] = [];
      if (retryMode) summaryParts.push(`Retried from ${retryMode}`);
      else summaryParts.push("Audit completed");
      summaryParts.push(`for ${campaign.name} v${campaign.version}`);
      summaryParts.push(`using ${creativeLabel}`);
      if (details.review.syspromptNoChanges) summaryParts.push("— no sysprompt changes");
      if (failedSteps.length > 0) summaryParts.push(`— WARNING: ${failedSteps.join(", ")} failed`);
      const summary = summaryParts.join(" ") + ".";
      this.runs.markCompleted(next.id, completedAt, summary, JSON.stringify(details));
      try {
        if (next.sessionId) {
          this.sessions.resetPipelineCounter(next.sessionId, "rolling_diff");
          this.sessions.resetPipelineCounter(next.sessionId, "repetition_detection");
          this.sessions.resetPipelineCounter(next.sessionId, "sysprompt_audit");
        }
      } catch {}
      this.logger.info({ runId: next.id, campaignId: next.campaignId, status: "completed" }, "pipeline run completed");
      pipelineStreamBus.publish({ type: "run_complete", runId: next.id, ts: Date.now() });
    } catch (error) {
      const message = humanizeError(error);
      const canceled = abortController.signal.aborted || (error instanceof Error && error.name === "AbortError");
      if (canceled) {
        this.runs.markCanceled(next.id, new Date().toISOString(), "pipeline run canceled", JSON.stringify(details));
        this.logger.info({ runId: next.id, campaignId: next.campaignId, status: "canceled" }, "pipeline run canceled");
        pipelineStreamBus.publish({ type: "run_error", runId: next.id, error: "canceled", ts: Date.now() });
      } else {
        this.runs.markFailed(next.id, new Date().toISOString(), message, JSON.stringify(details));
        this.logger.error({ runId: next.id, error: message }, "pipeline run failed");
        pipelineStreamBus.publish({ type: "run_error", runId: next.id, error: message, ts: Date.now() });
      }
    } finally {
      stopWatching();
      this.activeRuns.delete(next.id);
      pipelineStreamBus.finalize(next.id);
    }
    return true;
  }

  private watchForCancellation(userId: string, runId: string, controller: AbortController) {
    const interval = setInterval(() => {
      try {
        const current = this.runs.findById(userId, runId);
        if (current?.status === "canceled") controller.abort();
      } catch (err) {
        // DB lookup glitch shouldn't kill the process. The next tick will retry.
        this.logger.warn({ err, runId }, "cancellation poll failed");
      }
    }, 250);
    return () => clearInterval(interval);
  }

  private persist(runId: string, details: StoredPipelineRunDetails) {
    this.runs.updateRun(runId, {
      detailsJson: JSON.stringify(details),
      updatedAt: new Date().toISOString(),
    });
  }

  private buildIncrementalTranscript(userId: string, campaignId: string, sessionId?: string | null, overrideWatermark?: number | null) {
    const sessions = this.sessions.listForCampaign(userId, campaignId);
    const session = sessionId ? sessions.find(s => s.id === sessionId) : sessions[0];
    if (!session) return { transcript: "", watermarkBefore: null, watermarkAfter: null };
    const watermark = overrideWatermark !== undefined ? overrideWatermark : (session.pipelineWatermark ?? null);
    const allMessages = watermark != null
      ? this.messages.listAfterSortOrder(userId, session.id, watermark)
      : this.messages.listForSession(userId, session.id);
    const filtered = allMessages.filter(m => m.role !== "cold-start");
    if (filtered.length === 0) return { transcript: "", watermarkBefore: watermark, watermarkAfter: watermark };
    const maxSortOrder = Math.max(...filtered.map(m => m.sortOrder));
    const transcript = filtered.map(m => {
      let scenePrefix = "";
      if (m.sceneData) {
        const scene = deserializeSceneData(m.sceneData);
        if (scene) scenePrefix = `${serializeSceneForContext(scene, scene.notPresent)}\n`;
      }
      return `${m.role}: ${scenePrefix}${m.content.trim()}`;
    }).join("\n");
    return { transcript, watermarkBefore: watermark, watermarkAfter: maxSortOrder };
  }

  private buildLorebookSummary(entries: { id: string; name: string; tag: string | null; keys: string; content: string }[]) {
    if (entries.length === 0) return "No lorebook entries exist yet.";
    return entries.map((e) => {
      const keys = (() => { try { return JSON.parse(e.keys); } catch { return []; } })();
      return `[${e.id}] ${e.name} (${e.tag ?? "untagged"})\nKeys: ${keys.join(", ") || "none"}\n${e.content}`;
    }).join("\n\n---\n\n");
  }

  private getExistingAntiRepetitionRules(userId: string, campaignId: string): string | null {
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign?.contextDefaultsJson) return null;
    try {
      const defaults = JSON.parse(campaign.contextDefaultsJson);
      return defaults.antiRepetitionRules ? JSON.stringify(defaults.antiRepetitionRules) : null;
    } catch { return null; }
  }

  private async runModelPrompt(runtime: ChatRuntime | null, modelId: string, prompt: string, fallback: () => string, signal?: AbortSignal) {
    if (!runtime) return fallback();
    let text = "";
    let thinkingText = "";
    let completed = false;
    const ctx = this.currentStreamCtx;
    if (ctx) { try { this.artifacts.write(ctx.runId, ctx.step, "prompt", prompt); } catch {} }
    try {
      await runtime.streamChat({
        modelId,
        messages: [{ role: "user", content: prompt }],
        requestId: randomUUID(),
        thinkingMode: "adaptive",
        effort: "max",
        signal,
      }, {
        onStart: () => {
          text = "";
          if (ctx) pipelineStreamBus.publish({ type: "step_start", runId: ctx.runId, step: ctx.step, ts: Date.now() });
        },
        onDelta: (delta) => {
          text += delta;
          if (ctx) pipelineStreamBus.publish({ type: "step_delta", runId: ctx.runId, step: ctx.step, delta, ts: Date.now() });
        },
        onThinkingDelta: (delta) => {
          thinkingText += delta;
          if (ctx) pipelineStreamBus.publish({ type: "step_thinking_delta", runId: ctx.runId, step: ctx.step, delta, ts: Date.now() });
        },
        onComplete: () => {
          completed = true;
        },
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      if (!isTransientStreamError(error, signal)) throw error;
      this.logger.warn({ modelId, error: error instanceof Error ? error.message : "stream error" }, "transient stream error — retrying");
      text = "";
      thinkingText = "";
      completed = false;
      try {
        await runtime.streamChat({
          modelId,
          messages: [{ role: "user", content: prompt }],
          requestId: randomUUID(),
          thinkingMode: "adaptive",
          effort: "max",
          signal,
        }, {
          onStart: () => { text = ""; },
          onDelta: (delta) => {
            text += delta;
            if (ctx) pipelineStreamBus.publish({ type: "step_delta", runId: ctx.runId, step: ctx.step, delta, ts: Date.now() });
          },
          onThinkingDelta: (delta) => {
            thinkingText += delta;
            if (ctx) pipelineStreamBus.publish({ type: "step_thinking_delta", runId: ctx.runId, step: ctx.step, delta, ts: Date.now() });
          },
          onComplete: () => { completed = true; },
        });
      } catch (retryError) {
        if (signal?.aborted || (retryError instanceof Error && retryError.name === "AbortError")) throw retryError;
        throw retryError;
      }
    }
    const result = completed && text.trim() ? text.trim() : fallback();
    if (ctx) {
      try {
        this.artifacts.write(ctx.runId, ctx.step, "response", text);
        if (thinkingText) this.artifacts.write(ctx.runId, ctx.step, "thinking", thinkingText);
      } catch {}
      pipelineStreamBus.publish({ type: "step_complete", runId: ctx.runId, step: ctx.step, result, ts: Date.now() });
    }
    return result;
  }

  private async withStreamCtx<T>(runId: string, step: PipelineStreamStep, fn: () => Promise<T>): Promise<T> {
    this.currentStreamCtx = { runId, step };
    try { return await fn(); }
    finally { this.currentStreamCtx = null; }
  }

  private systemPromptNoChanges(result: string) {
    return /^\s*(NO_CHANGES_NEEDED|no changes needed\.?|no changes\.?)\s*$/i.test(result);
  }
}

function humanizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "pipeline substep failed";
  const msg = raw.toLowerCase();
  if (msg === "terminated" || msg.includes("other side closed") || msg.includes("und_err_socket")) {
    return "LLM stream dropped mid-response. Retry the run.";
  }
  if (msg.includes("econnreset") || msg.includes("network error") || msg.includes("premature close")) {
    return "Network error during LLM stream. Retry the run.";
  }
  if (msg === "canceled") return "Run canceled.";
  return raw;
}

function isTransientStreamError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const code = (error as { code?: string }).code?.toString().toLowerCase() ?? "";
  if (msg === "terminated") return true;
  if (msg.includes("socket") && msg.includes("closed")) return true;
  if (msg.includes("other side closed")) return true;
  if (msg.includes("econnreset") || code.includes("econnreset")) return true;
  if (msg.includes("und_err_socket") || code.includes("und_err_socket")) return true;
  if (msg.includes("network error") || msg.includes("premature close")) return true;
  if (msg.includes("upstream connect error") || msg.includes("upstream timeout")) return true;
  if (error.name.toLowerCase() === "aborterror" && !signal?.aborted) return true;
  return false;
}
