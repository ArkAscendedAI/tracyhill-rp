import type {
  AbandonPipelineRunResponse,
  ActivePipelineRunsResponse,
  ApprovePipelineRunRequest,
  ApprovePipelineRunResponse,
  CancelPipelineRunResponse,
  EnqueuePipelineRunRequest,
  PipelineRetryMode,
  PipelineRunArtifactsResponse,
  PipelineRunsResponse,
  RetryPipelineRunRequest,
  RetryPipelineRunResponse,
} from "@tracyhill-rp/contracts";

import { createLogger } from "@tracyhill-rp/logging";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { CampaignVersionRepository } from "../campaigns/campaignVersionRepository";
import { CampaignRepository } from "../campaigns/campaignRepository";
import { LorebookRepository } from "../context/lorebookRepository";
import { EmbeddingService } from "../context/embeddingService";
import { LorebookEmbeddingRepository } from "../context/lorebookEmbeddingRepository";
import { estimateTokens } from "../context/lorebookTokenEstimator";
import { UserRepository } from "../users/userRepository";
import { SessionRepository } from "../workspace/sessionRepository";
import { ArtifactRepository } from "./artifactRepository";
import { createDefaultPipelineRunDetails, parsePipelineRunDetails, PipelineRunRepository } from "./pipelineRunRepository";


const pipelineLogger = createLogger("pipeline-service");

export type PipelineKick = {
  kick: () => void;
};

export type PipelineControl = PipelineKick & {
  cancelRun?: (runId: string) => boolean;
};

export class PipelineService {
  constructor(
    private readonly users: UserRepository,
    private readonly campaigns: CampaignRepository,
    private readonly versions: CampaignVersionRepository,
    private readonly runs: PipelineRunRepository,
    private readonly sessions: SessionRepository,
    private readonly control: PipelineControl | null = null,
    private readonly artifacts: ArtifactRepository | null = null,
    private readonly lorebook: LorebookRepository | null = null,
    private readonly embeddingService: EmbeddingService | null = null,
    private readonly embeddingRepo: LorebookEmbeddingRepository | null = null,
  ) {}

  listRunArtifacts(userId: string, runId: string): PipelineRunArtifactsResponse {
    const run = this.runs.findById(userId, runId);
    if (!run) throw new HttpError(404, "pipeline run not found");
    if (!this.artifacts) return { runId, artifacts: [] };
    return { runId, artifacts: this.artifacts.listByRun(runId) };
  }

  listCampaignRuns(userId: string, campaignId: string): PipelineRunsResponse {
    this.requireCampaign(userId, campaignId);
    return {
      campaignId,
      runs: this.runs.listForCampaign(userId, campaignId).map((run) => this.serializeRun(run)),
    };
  }

  listActiveRuns(userId: string): ActivePipelineRunsResponse {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    const seenCampaigns = new Set<string>();
    const runs = [];
    for (const run of this.runs.listActiveForUser(userId)) {
      if (seenCampaigns.has(run.campaignId)) continue;
      const campaign = this.campaigns.findById(userId, run.campaignId);
      if (!campaign) continue;
      seenCampaigns.add(run.campaignId);
      runs.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        run: this.serializeRun(run),
      });
    }
    return { runs };
  }

  enqueueCampaignRun(userId: string, campaignId: string, input?: EnqueuePipelineRunRequest): PipelineRunsResponse {
    return this.enqueueCampaignRunInternal(userId, campaignId, null, null, input);
  }

  retryCampaignRun(userId: string, campaignId: string, runId: string, input?: RetryPipelineRunRequest): RetryPipelineRunResponse {
    this.requireCampaign(userId, campaignId);
    const run = this.runs.findById(userId, runId);
    if (!run || run.campaignId !== campaignId) throw new HttpError(404, "pipeline run not found");
    const sourceDetails = parsePipelineRunDetails(run.detailsJson);
    const modelOverride = sourceDetails.models
      ? { creativeModelId: sourceDetails.models.creativeModelId }
      : undefined;
    const retryWatermark = { before: sourceDetails.review.watermarkBefore ?? null, after: sourceDetails.review.watermarkAfter ?? null };
    return this.enqueueCampaignRunInternal(userId, campaignId, run.id, mapRetryMode(input?.fromStep), modelOverride, retryWatermark);
  }

  private enqueueCampaignRunInternal(userId: string, campaignId: string, retriedFromRunId: string | null, retriedFromStep: PipelineRetryMode | null, input?: EnqueuePipelineRunRequest, retryWatermark?: { before: number | null; after: number | null }) {
    const now = new Date().toISOString();
    const campaign = this.requireCampaign(userId, campaignId);
    const existing = this.runs.listForCampaign(userId, campaignId);
    if (existing.some(r => r.status === "queued" || r.status === "running")) {
      throw new HttpError(409, "a pipeline run is already active for this campaign");
    }
    const details = createDefaultPipelineRunDetails();
    details.review.retriedFromRunId = retriedFromRunId;
    details.review.retriedFromStep = retriedFromStep;
    if (retryWatermark) {
      details.review.watermarkBefore = retryWatermark.before;
      details.review.watermarkAfter = retryWatermark.after;
    }
    const creativeModelId = input?.creativeModelId || campaign.creativeModelId || campaign.pipelineModelId;
    details.models = { creativeModelId };
    // Find the active session to attach the run for incremental auditing
    const campaignSessions = this.sessions.listForCampaign(userId, campaignId);
    const activeSession = campaignSessions.find(s => s.sessionType === "standard");
    this.runs.createRun({
      id: createId(),
      userId,
      campaignId,
      sessionId: activeSession?.id ?? null,
      status: "queued",
      summary: null,
      error: null,
      detailsJson: JSON.stringify(details),
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    });
    this.control?.kick();
    return this.listCampaignRuns(userId, campaignId);
  }

  cancelCampaignRun(userId: string, campaignId: string, runId: string): CancelPipelineRunResponse {
    this.requireCampaign(userId, campaignId);
    const run = this.runs.findById(userId, runId);
    if (!run || run.campaignId !== campaignId) throw new HttpError(404, "pipeline run not found");
    if (run.approvedAt) throw new HttpError(400, "approved pipeline runs cannot be canceled");
    if (run.status === "queued") {
      this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", run.detailsJson);
      return this.listCampaignRuns(userId, campaignId);
    }
    if (run.status === "running") {
      const canceled = this.control?.cancelRun?.(run.id) ?? false;
      if (!canceled) this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", run.detailsJson);
      return this.listCampaignRuns(userId, campaignId);
    }
    if (run.status === "canceled") return this.listCampaignRuns(userId, campaignId);
    throw new HttpError(400, "only queued or running pipeline runs can be canceled");
  }

  approveCampaignRun(userId: string, campaignId: string, runId: string, _input?: ApprovePipelineRunRequest): ApprovePipelineRunResponse {
    const campaign = this.requireCampaign(userId, campaignId);
    const run = this.runs.findById(userId, runId);
    if (!run || run.campaignId !== campaignId) throw new HttpError(404, "pipeline run not found");
    if (run.status !== "completed") throw new HttpError(400, "pipeline run is not ready for approval");
    if (run.approvedAt) return this.listCampaignRuns(userId, campaignId);
    const details = parsePipelineRunDetails(run.detailsJson);
    const nextSystemPrompt = details.review.systemPromptDraft?.trim() || campaign.systemPrompt;
    const now = new Date().toISOString();
    const transactBody = () => {
      this.versions.createVersion({
        id: createId(),
        campaignId: campaign.id,
        userId,
        version: campaign.version,
        systemPrompt: campaign.systemPrompt,
        createdAt: now,
        label: null,
      });
      const campaignUpdate: Record<string, unknown> = {
        systemPrompt: nextSystemPrompt,
        version: campaign.version + 1,
        updatedAt: now,
      };
      if (details.review.antiRepetitionRules) {
        const existingDefaults = campaign.contextDefaultsJson ? safeParseJson(campaign.contextDefaultsJson, {}) : {};
        const parsed = parseAntiRepetitionRules(details.review.antiRepetitionRules);
        if (parsed.length > 0) {
          existingDefaults.antiRepetitionRules = parsed;
          campaignUpdate.contextDefaultsJson = JSON.stringify(existingDefaults);
        }
      }
      this.campaigns.updateCampaign(userId, campaignId, campaignUpdate);
      if (details.review.lorebookOperations && this.lorebook) {
        this.applyLorebookOperations(userId, campaignId, details.review.lorebookOperations);
      }
      if (run.sessionId && details.review.watermarkAfter != null) {
        this.sessions.updateSession(userId, run.sessionId, {
          pipelineWatermark: details.review.watermarkAfter,
          updatedAt: now,
        });
      }
      const summary = run.summary?.includes("Approved")
        ? run.summary
        : `${run.summary ?? "Audit completed."} Approved into campaign version ${campaign.version + 1}.`;
      this.runs.updateRun(runId, { summary, approvedAt: now, updatedAt: now, detailsJson: JSON.stringify(details) });
    };
    if (this.lorebook) this.lorebook.transact(transactBody);
    else this.runs.transact(transactBody);
    return this.listCampaignRuns(userId, campaignId);
  }

  abandonCampaignRun(userId: string, campaignId: string, runId: string): AbandonPipelineRunResponse {
    this.requireCampaign(userId, campaignId);
    const run = this.runs.findById(userId, runId);
    if (!run || run.campaignId !== campaignId) throw new HttpError(404, "pipeline run not found");
    if (run.approvedAt) throw new HttpError(400, "approved pipeline runs cannot be abandoned");
    if (run.status === "queued" || run.status === "running") {
      this.control?.cancelRun?.(run.id);
    }
    this.runs.deleteRun(userId, runId);
    return this.listCampaignRuns(userId, campaignId);
  }

  private serializeRun(run: ReturnType<PipelineRunRepository["listForCampaign"]>[number]) {
    const details = parsePipelineRunDetails(run.detailsJson);
    return {
      id: run.id,
      campaignId: run.campaignId,
      status: run.status as "queued" | "running" | "completed" | "failed" | "canceled",
      summary: run.summary ?? null,
      error: run.error ?? null,
      models: details.models,
      steps: details.steps,
      review: details.review,
      requestedAt: run.requestedAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      approvedAt: run.approvedAt ?? null,
      updatedAt: run.updatedAt,
    };
  }

  private applyLorebookOperations(userId: string, campaignId: string, opsJson: string) {
    let ops: any[]; // pipeline-generated JSON from LLM output
    try {
      const match = opsJson.match(/\[[\s\S]*\]/);
      if (!match) return;
      ops = JSON.parse(match[0]);
    } catch { return; }
    if (!Array.isArray(ops)) return;
    const now = new Date().toISOString();
    const embedTargets: Array<{ id: string; userId: string; content: string }> = [];
    this.lorebook!.transact(() => {
      for (const op of ops) {
        if (!op || typeof op !== "object") continue;
        if (op.op === "CREATE" && op.name && op.content) {
          const keys = Array.isArray(op.keys) ? op.keys : [];
          const id = createId();
          this.lorebook!.create({
            id, userId, campaignId, name: op.name, tag: op.tag ?? null,
            content: op.content, comment: null, keys: JSON.stringify(keys), keysSecondary: "[]",
            selectiveLogic: "and_any", scanDepth: 4, position: "before_main", insertionOrder: 100,
            probability: 100, isConstant: 0, isEnabled: 1, sticky: 0, cooldown: 0, delay: 0,
            excludeRecursion: 0, preventRecursion: 0, delayUntilRecursion: 0,
            tokensEstimate: estimateTokens(op.content),
            createdAt: now, updatedAt: now,
          });
          embedTargets.push({ id, userId, content: op.content });
        } else if (op.op === "UPDATE" && op.entry_id && op.content) {
          // LLM-supplied ids: scope to THIS campaign and never touch constants
          // (the constant Thread Index) or the tracker-owned threads entries.
          const target = this.lorebook!.findById(userId, op.entry_id);
          if (!target || target.campaignId !== campaignId || target.isConstant || target.tag === "threads") continue;
          this.lorebook!.update(userId, op.entry_id, {
            content: op.content, tokensEstimate: estimateTokens(op.content), updatedAt: now,
          });
          embedTargets.push({ id: op.entry_id, userId, content: op.content });
        } else if (op.op === "DELETE" && op.entry_id) {
          const target = this.lorebook!.findById(userId, op.entry_id);
          if (!target || target.campaignId !== campaignId || target.isConstant || target.tag === "threads") continue;
          this.lorebook!.remove(userId, op.entry_id);
          // Orphan vectors are cosine-scanned on every semantic turn forever.
          this.embeddingRepo?.deleteForEntry(op.entry_id);
          this.lorebook!.clearActivationStateForEntry(op.entry_id);
        }
      }
    });
    // Embed outside the transaction (network I/O). Failures record via the
    // embedding service and surface as system events.
    if (this.embeddingService && embedTargets.length > 0) {
      const model = this.resolveCampaignEmbedModelForApply(userId, campaignId);
      this.embeddingService.indexEntries(embedTargets, model).catch((err) => {
        pipelineLogger.warn({ err, campaignId, count: embedTargets.length }, "post-apply indexEntries failed");
      });
    }
  }

  private resolveCampaignEmbedModelForApply(userId: string, campaignId: string): string {
    try {
      const campaign = this.campaigns.findById(userId, campaignId);
      const json = (campaign as any)?.contextDefaultsJson;
      if (json) {
        const defaults = JSON.parse(json);
        if (typeof defaults?.embeddingModel === "string" && defaults.embeddingModel) return defaults.embeddingModel;
      }
    } catch { /* fall through */ }
    return "openai:text-embedding-3-large";
  }

  private requireCampaign(userId: string, campaignId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  }

}

function parseAntiRepetitionRules(raw: string): Array<{ pattern: string; category: string; frequency: number; replacement_guidance: string }> {
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r: any) => r && typeof r.pattern === "string" && typeof r.replacement_guidance === "string");
  } catch { return []; }
}

function safeParseJson(value: string | null | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapRetryMode(fromStep: RetryPipelineRunRequest["fromStep"]): PipelineRetryMode {
  if (fromStep === "fromLorebookRefresh") return "fromLorebookRefresh";
  if (fromStep === "fromSysprompt") return "fromSysprompt";
  return "full";
}
