import { randomUUID } from "node:crypto";

import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import { getDefaultChatModelId } from "@tracyhill-rp/model-catalog";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../../../api/src/domain/providerKeys/providerKeyRepository";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import { createChatRuntimeForUser } from "../../../api/src/domain/providerKeys/providerKeyRuntime";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { WizardRunRepository, createDefaultWizardRunDetails, parseWizardRunDetails } from "../../../api/src/domain/wizard/wizardRunRepository";
import { WizardTemplateRepository } from "../../../api/src/domain/wizard/wizardTemplateRepository";
import {
  WIZARD_V3_SYSTEM_PROMPT,
  WIZARD_V3_CORPUS_PROMPT,
} from "./wizardV3Prompts";
import type { LorebookCorpusEntry } from "../../../api/src/domain/wizard/wizardRunRepository";

export type WizardWorkerOptions = {
  runtime?: ChatRuntime | null;
  runtimeDefaults?: ProviderRuntimeDefaults;
};

export class WizardWorker {
  private readonly logger = createLogger("tracyhill-rp-v2-worker");
  private readonly templates;
  private readonly runs;
  private readonly providerKeys;
  private readonly customEndpoints;
  private readonly runtime: ChatRuntime | null | undefined;
  private readonly runtimeDefaults;
  private readonly activeRuns = new Map<string, AbortController>();
  private ticking = false;

  constructor(dbFile: string, options?: WizardWorkerOptions) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.templates = new WizardTemplateRepository(db);
    this.runs = new WizardRunRepository(db);
    this.providerKeys = new ProviderKeyRepository(db);
    this.customEndpoints = new CustomEndpointRepository(db);
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
        // Survive any drain failure under INLINE_WORKERS=1; the next kick() retries.
        this.logger.error({ err }, "wizard drain failed");
      } finally {
        this.ticking = false;
      }
    });
  }

  async drain() {
    while (await this.runNext()) {
      continue;
    }
  }

  cancelRun(runId: string) {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async runNext() {
    const next = this.runs.findNextQueued();
    if (!next) return false;
    const startedAt = new Date().toISOString();
    if (!this.runs.markRunning(next.id, startedAt)) return true;
    let details = parseWizardRunDetails(next.detailsJson);
    const abortController = new AbortController();
    this.activeRuns.set(next.id, abortController);
    const stopWatching = this.watchForCancellation(next.userId, next.id, abortController);
    try {
      details = {
        ...createDefaultWizardRunDetails(details.review.campaignName, details.review.brief, details.review.wizardTranscript),
        review: {
          ...createDefaultWizardRunDetails(details.review.campaignName, details.review.brief, details.review.wizardTranscript).review,
          campaignName: details.review.campaignName,
          brief: details.review.brief,
          wizardTranscript: details.review.wizardTranscript,
          retriedFromRunId: details.review.retriedFromRunId,
        },
      };
      const templates = this.templates.ensureForUser(next.userId, startedAt);
      const modelId = resolveChatModelConfig(this.customEndpoints, next.userId, next.modelId)?.id ?? getDefaultChatModelId();
      const runtime = this.runtime !== undefined ? this.runtime : createChatRuntimeForUser(this.providerKeys, this.customEndpoints, next.userId, this.runtimeDefaults);

      // Generate system prompt + lorebook corpus in parallel
      details.steps.systemPrompt.status = "running";
      details.steps.lorebookCorpus.status = "running";
      this.persist(next.id, details);

      const systemPromptPromise = this.generateSystemPrompt(runtime, modelId, details.review.campaignName, details.review.wizardTranscript, templates.exampleSystemPrompt, abortController.signal)
        .then(result => {
          details.steps.systemPrompt = { status: "completed", result, error: null };
          details.review.systemPromptDraft = result;
          this.persist(next.id, details);
        })
        .catch((error: unknown) => {
          details.steps.systemPrompt = { status: "failed", result: null, error: error instanceof Error ? error.message : "system prompt generation failed" };
          this.persist(next.id, details);
          throw error;
        });

      const corpusPromise = this.generateLorebookCorpus(runtime, modelId, details.review.campaignName, details.review.wizardTranscript, abortController.signal)
        .then(entries => {
          details.steps.lorebookCorpus = { status: "completed", result: JSON.stringify(entries), error: null };
          details.review.lorebookCorpusDraft = entries;
          this.persist(next.id, details);
        })
        .catch((error: unknown) => {
          details.steps.lorebookCorpus = { status: "failed", result: null, error: error instanceof Error ? error.message : "lorebook corpus generation failed" };
          this.persist(next.id, details);
          throw error;
        });

      try {
        await Promise.all([systemPromptPromise, corpusPromise]);
      } catch (error) {
        await Promise.allSettled([systemPromptPromise, corpusPromise]);
        if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        const message = error instanceof Error ? error.message : "wizard generation failed";
        this.runs.markFailed(next.id, new Date().toISOString(), message, JSON.stringify(details));
        return true;
      }

      const completedAt = new Date().toISOString();
      const modelLabel = resolveChatModelConfig(this.customEndpoints, next.userId, modelId)?.label ?? modelId;
      const summary = `Wizard review prepared for ${details.review.campaignName} using ${modelLabel}.`;
      this.runs.markCompleted(next.id, completedAt, summary, JSON.stringify(details));
      this.logger.info({ runId: next.id, status: "completed" }, "wizard run completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "wizard worker failed";
      const canceled = abortController.signal.aborted || (error instanceof Error && error.name === "AbortError");
      if (canceled) {
        this.runs.markCanceled(next.id, new Date().toISOString(), "wizard run canceled", JSON.stringify(details));
        this.logger.info({ runId: next.id, status: "canceled" }, "wizard run canceled");
      } else {
        this.runs.markFailed(next.id, new Date().toISOString(), message, JSON.stringify(details));
        this.logger.error({ runId: next.id, error: message }, "wizard run failed");
      }
    } finally {
      stopWatching();
      this.activeRuns.delete(next.id);
    }
    return true;
  }

  private watchForCancellation(userId: string, runId: string, controller: AbortController) {
    const interval = setInterval(() => {
      try {
        const current = this.runs.findById(userId, runId);
        if (current?.status === "canceled") controller.abort();
      } catch (err) {
        this.logger.warn({ err, runId }, "cancellation poll failed");
      }
    }, 250);
    return () => clearInterval(interval);
  }

  private persist(runId: string, details: ReturnType<typeof createDefaultWizardRunDetails>) {
    this.runs.updateRun(runId, {
      detailsJson: JSON.stringify(details),
      updatedAt: new Date().toISOString(),
    });
  }

  private async generateSystemPrompt(runtime: ChatRuntime | null, modelId: string, campaignName: string, wizardTranscript: string, exampleSystemPrompt: string, signal?: AbortSignal) {
    const prompt = [
      WIZARD_V3_SYSTEM_PROMPT,
      "",
      `<campaign_name>\n${campaignName}\n</campaign_name>`,
      "",
      `<wizard_conversation>\n${wizardTranscript}\n</wizard_conversation>`,
      "",
      `<example_system_prompt>\n${exampleSystemPrompt || "No example system prompt provided."}\n</example_system_prompt>`,
    ].join("\n");
    return this.runModelPrompt(runtime, modelId, prompt, () => `# ${campaignName}\n\nThe model must never write dialogue, inner thoughts, or actions for the user's character.`, signal);
  }

  private async generateLorebookCorpus(runtime: ChatRuntime | null, modelId: string, campaignName: string, wizardTranscript: string, signal?: AbortSignal): Promise<LorebookCorpusEntry[]> {
    const prompt = [
      WIZARD_V3_CORPUS_PROMPT,
      "",
      `<campaign_name>\n${campaignName}\n</campaign_name>`,
      "",
      `<wizard_conversation>\n${wizardTranscript}\n</wizard_conversation>`,
    ].join("\n");
    const text = await this.runModelPrompt(runtime, modelId, prompt, () => "[]", signal);
    return this.parseCorpusResponse(text);
  }

  private parseCorpusResponse(text: string): LorebookCorpusEntry[] {
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((e: any) => e && typeof e.name === "string" && typeof e.content === "string")
        .map((e: any) => ({
          name: String(e.name).trim(),
          tag: typeof e.tag === "string" ? e.tag.trim().toLowerCase() : null,
          content: String(e.content).trim(),
          keys: Array.isArray(e.keys) ? e.keys.map(String) : [e.name],
          keysSecondary: Array.isArray(e.keysSecondary) ? e.keysSecondary.map(String) : [],
          isConstant: Boolean(e.isConstant),
          position: typeof e.position === "string" ? e.position : "before_main",
          insertionOrder: typeof e.insertionOrder === "number" ? e.insertionOrder : 100,
          scanDepth: typeof e.scanDepth === "number" ? e.scanDepth : 4,
          startingAttire: typeof e.startingAttire === "string" && e.startingAttire.trim() ? e.startingAttire.trim() : undefined,
        }));
    } catch {
      return [];
    }
  }

  private async runModelPrompt(runtime: ChatRuntime | null, modelId: string, prompt: string, fallback: () => string, signal?: AbortSignal) {
    if (!runtime) return fallback();
    let text = "";
    let completed = false;
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
        onDelta: (delta) => { text += delta; },
        onThinkingDelta: () => {},
        onComplete: () => { completed = true; },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      // THROW instead of silently substituting the fallback: a transient API
      // error used to produce a "completed" run whose approval created a
      // campaign with a 2-line stub system prompt and an empty lorebook. The
      // outer run loop marks the run failed (which records a system event),
      // and the user retries instead of approving junk.
      throw new Error(`wizard model call failed (${modelId}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!completed || !text.trim()) {
      throw new Error(`wizard model returned ${completed ? "empty output" : "no completion"} (${modelId})`);
    }
    return text.trim();
  }
}
