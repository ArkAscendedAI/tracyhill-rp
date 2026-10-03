import type {
  ActivePipelineRunsResponse,
  CancelPipelineRunResponse,
  EnqueueRecapResponse,
  PipelineRunStatus,
  PipelineRunsQuery,
  PipelineRunsResponse,
  RecapStatusResponse,
} from "@tracyhill-rp/contracts";

import { createLogger } from "@tracyhill-rp/logging";
import { getConfiguredDefaultModelId } from "@tracyhill-rp/model-catalog";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { CampaignRepository } from "../campaigns/campaignRepository";
import { UserRepository } from "../users/userRepository";
import { SessionRepository } from "../workspace/sessionRepository";
import { PipelineRunRepository } from "./pipelineRunRepository";
import { PIPELINE_KIND_PRIORITY } from "./pipelineQueueService";


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
    private readonly runs: PipelineRunRepository,
    private readonly sessions: SessionRepository,
    private readonly control: PipelineControl | null = null,
  ) {}

  listCampaignRuns(userId: string, campaignId: string, filter: PipelineRunsQuery = {}): PipelineRunsResponse {
    this.requireCampaign(userId, campaignId);
    return {
      campaignId,
      runs: this.runs.listForCampaign(userId, campaignId, filter).map((run) => this.serializeRun(run)),
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

  enqueueRecap(userId: string, campaignId: string, sessionId?: string | null): EnqueueRecapResponse {
    this.requireCampaign(userId, campaignId);
    const campaignSessions = this.sessions.listForCampaign(userId, campaignId);
    const session = sessionId
      ? campaignSessions.find((s) => s.id === sessionId)
      : campaignSessions.find((s) => s.sessionType === "standard");
    if (!session) throw new HttpError(404, "session not found for this campaign");
    if (this.runs.hasQueuedOrRunningByKindAndCampaign("recap", campaignId)) {
      throw new HttpError(409, "a recap is already queued or running for this campaign");
    }
    // The recap uses the SESSION's rolling model (same resolution + fallback as
    // the auto-enqueued workers). This read was campaign-ONLY before 0077, so the
    // session's rollingModel/workerEffort dials were ignored outright.
    const sessionDials = (() => {
      try { return JSON.parse(session.contextOverridesJson ?? "{}") as { rollingModel?: unknown; workerEffort?: unknown; openaiFastModeEnabled?: unknown }; }
      catch { return {}; }
    })();
    const recapModel = (typeof sessionDials.rollingModel === "string" && sessionDials.rollingModel ? sessionDials.rollingModel : null)
      ?? getConfiguredDefaultModelId() ?? "claude-haiku-4-5-bridge";
    const workerEffort = typeof sessionDials.workerEffort === "string" && sessionDials.workerEffort ? sessionDials.workerEffort : "model-max";
    const openaiFastMode = sessionDials.openaiFastModeEnabled === true;
    const now = new Date().toISOString();
    const id = createId();
    this.runs.createRun({
      id, userId, campaignId, sessionId: session.id, kind: "recap",
      priority: PIPELINE_KIND_PRIORITY.recap, status: "queued",
      detailsJson: JSON.stringify({ recapModel, workerEffort, openaiFastMode }),
      requestedAt: now, updatedAt: now,
    });
    pipelineLogger.info({ campaignId, sessionId: session.id, runId: id }, "recap enqueued");
    this.control?.kick();
    return { runId: id, campaignId, sessionId: session.id, status: "queued" };
  }

  getLatestRecap(userId: string, campaignId: string, sessionId?: string | null): RecapStatusResponse {
    this.requireCampaign(userId, campaignId);
    const latest = this.runs.listForCampaign(userId, campaignId)
      .find((r) => r.kind === "recap" && (!sessionId || r.sessionId === sessionId));
    if (!latest) return { runId: null, status: null, recap: null, error: null, requestedAt: null, completedAt: null };
    let recap: string | null = null;
    try {
      const details = JSON.parse(latest.detailsJson ?? "{}");
      if (typeof details?.summary === "string" && details.summary) recap = details.summary;
    } catch { /* malformed details — surface status without content */ }
    return {
      runId: latest.id,
      status: latest.status as PipelineRunStatus,
      recap,
      error: latest.error ?? null,
      requestedAt: latest.requestedAt,
      completedAt: latest.completedAt ?? null,
    };
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
      // cancelRun now aborts the live AbortController for EVERY kind (the
      // auto kinds register a controller too), so the worker itself transitions
      // the row to canceled. Only fall back to an eager markCanceled if no
      // controller was registered (e.g. the run is on another process instance).
      const canceled = this.control?.cancelRun?.(run.id) ?? false;
      if (!canceled) this.runs.markCanceled(run.id, new Date().toISOString(), "pipeline run canceled", run.detailsJson);
      return this.listCampaignRuns(userId, campaignId);
    }
    if (run.status === "canceled") return this.listCampaignRuns(userId, campaignId);
    throw new HttpError(400, "only queued or running pipeline runs can be canceled");
  }

  private serializeRun(run: ReturnType<PipelineRunRepository["listForCampaign"]>[number]) {
    return {
      id: run.id,
      kind: run.kind,
      campaignId: run.campaignId,
      status: run.status as "queued" | "running" | "completed" | "failed" | "canceled",
      summary: run.summary ?? null,
      error: run.error ?? null,
      requestedAt: run.requestedAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      updatedAt: run.updatedAt,
    };
  }

  private requireCampaign(userId: string, campaignId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  }
}

