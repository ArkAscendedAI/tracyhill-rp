import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
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
import { withRetry, withDeadline, WORKER_LLM_DEADLINE_MS } from "./retryHelper";
import { resolveWorkerModel } from "../context/workerModel";

// Tail size for the recap window — the most-recent active messages via the
// transcript windowing read (NOT the full transcript).
const RECAP_TAIL_MESSAGES = 80;

const RECAP_SYSTEM = `You are writing a "Previously on…" style recap for an ongoing roleplay campaign. Read the recent transcript window and produce a story-so-far recap that re-orients a returning reader. Lines like [GM SPOTLIGHT — Name] are author meta-directives, not story events — ignore them.

Requirements:
- Markdown. Open with a short "**Previously on…**" hook line, then 3-6 short paragraphs or a tight bulleted structure.
- Cover: where the story currently stands, the active threads/goals, key recent events in order, notable character/relationship developments, and any unresolved cliffhanger the scene left off on.
- Write in-universe (no meta commentary about "the transcript" or "the user"). Past tense, present-stakes ending.
- 300-600 words. No preamble, no closing notes — output the recap only.`;

/**
 * Manual-trigger "recap" pipeline kind. Mirrors the rolling-diff
 * worker's runtime/model-resolution pattern (heartbeat before the stream,
 * abort signal threaded through, withRetry around the call) but is read-only:
 * the result is stored as recap markdown in the run's detailsJson.summary.
 */
export class RecapWorker {
  private readonly logger = createLogger("recap-worker");
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
      const campaign = this.campaigns.findById(run.userId, run.campaignId);
      if (!campaign) { this.runs.markFailed(run.id, now, "campaign not found", null); return; }
      const sessionId = run.sessionId;
      if (!sessionId) { this.runs.markFailed(run.id, now, "no session for recap", null); return; }

      // Transcript tail via the windowed read (active variants only).
      const tail = this.messages.listWindow(run.userId, sessionId, { limit: RECAP_TAIL_MESSAGES })
        .filter((m) => m.role !== "cold-start");
      if (tail.length === 0) {
        const doneAt = new Date().toISOString();
        this.runs.markCompleted(run.id, doneAt, "No messages to recap", JSON.stringify({ summary: null }));
        this.runs.updateRun(run.id, { approvedAt: doneAt });
        return;
      }
      const transcript = tail.map((m) => `[${m.role}]: ${m.content.trim()}`).join("\n\n");

      const details = run.detailsJson ? JSON.parse(run.detailsJson) as { recapModel?: string; workerEffort?: string; openaiFastMode?: boolean } : {};
      const runtime = this.runtime ?? createChatRuntimeForUser(this.providerKeys, this.customEndpoints, this.connections, run.userId, this.runtimeDefaults);
      if (!runtime) { this.runs.markFailed(run.id, now, "no chat runtime available", null); return; }
      // An unresolvable recap model (the session's rollingModel dial) fails the
      // run loudly.
      const modelId = resolveWorkerModel(this.customEndpoints, run, "pipeline", "recap", details.recapModel, getConfiguredDefaultModelId() ?? "claude-haiku-4-5-bridge");
      // Engine dial: explicit reasoning effort on effort-ladder models.
      const workerEffort = workerEffortFor(modelId, details.workerEffort);
      const speed = openaiFastModeFor(modelId, details.openaiFastMode);

      let responseText = "";
      let inputTokens = 0, outputTokens = 0;
      this.runs.heartbeat(run.id);
      await withDeadline(WORKER_LLM_DEADLINE_MS, "recap model call", (dl) => withRetry(() => runtime.streamChat({
        modelId,
        systemPrompt: RECAP_SYSTEM,
        messages: [{ role: "user", content: `<recent_transcript>\n${transcript}\n</recent_transcript>`, attachments: [] }],
        temperature: 0,
        thinkingMode: workerThinkingModeFor(modelId, workerEffort),
        thinkingBudget: null,
        effort: workerEffort,
        cacheTtl: "off",
        speed,
        requestId: `recap-${run.id}`,
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

      const recap = responseText.trim();
      // No-silent-failures: an empty/filtered response is a failure, not an
      // empty recap.
      if (!recap) {
        this.runs.markFailed(run.id, new Date().toISOString(), `recap model returned empty output (${modelId})`, null);
        return;
      }
      const doneAt = new Date().toISOString();
      this.runs.markCompleted(run.id, doneAt, `Recap generated (${recap.length} chars) using ${modelId}`, JSON.stringify({
        summary: recap,
        usage: { modelId, inputTokens, outputTokens },
      }));
      this.runs.updateRun(run.id, { approvedAt: doneAt });
      this.logger.info({ runId: run.id, campaignId: run.campaignId, chars: recap.length }, "recap completed");
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", null);
        return;
      }
      this.runs.markFailed(run.id, new Date().toISOString(), error instanceof Error ? error.message : "recap failed", null);
    }
  }
}
