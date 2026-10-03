import type { AuditFinding, AuditFindingsResponse, AuditFindingStatus, CampaignAuditReport, CampaignAuditStatusResponse, EnqueueCampaignAuditRequest, PipelineRunStatus, SubmitAuditRulingsRequest } from "@tracyhill-rp/contracts";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import type { UserRepository } from "../users/userRepository";
import type { CampaignRepository } from "../campaigns/campaignRepository";
import type { SessionRepository } from "../workspace/sessionRepository";
import type { PipelineRunRepository } from "./pipelineRunRepository";
import type { AuditFindingRepository, AuditFindingRow } from "./auditFindingRepository";
import type { ContextEngine } from "../context/contextEngine";
import type { CustomEndpointRepository } from "../providerKeys/customEndpointRepository";
import type { LorebookRepository } from "../context/lorebookRepository";
import type { MessageRepository } from "../chat/messageRepository";
import { PipelineTranscriptInput } from "../chat/pipelineTranscriptInput";
import { embedModelFromOverrides, resolveCampaignEmbedModel } from "../context/embedModelResolver";
import { resolveChatModelConfig } from "../providerKeys/chatModelConfig";
import { recordSystemEvent } from "../system/systemEvents";
import { PIPELINE_KIND_PRIORITY } from "./pipelineQueueService";

// Campaign Audit enqueue/status. The audit
// is a normal auto-kind pipeline run: the worker auto-applies behind the
// adversarial tail and this service only launches runs and reads reports —
// there is no approval surface.

interface AuditDetails {
  mode?: "quick" | "full";
  auditModel?: string;
  auto?: boolean;
  progress?: { stage: string; current: number; total: number };
  report?: CampaignAuditReport;
}

export class CampaignAuditService {
  constructor(
    private readonly users: UserRepository,
    private readonly campaigns: CampaignRepository,
    private readonly sessions: SessionRepository,
    private readonly runs: PipelineRunRepository,
    private readonly contextEngine: ContextEngine | null,
    private readonly customEndpoints: CustomEndpointRepository | null,
    private readonly kick: (() => void) | null,
    private readonly messages: MessageRepository,
    // Findings review queue; nullable so older constructions
    // (tests) keep working — the routes 503 when absent.
    private readonly findingsRepo: AuditFindingRepository | null = null,
    private readonly lorebook: LorebookRepository | null = null,
  ) {}

  private requireCampaign(userId: string, campaignId: string) {
    if (!this.users.findById(userId)) throw new HttpError(401, "authentication required");
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  }

  /** The embedding model a launched run embeds and dedups under: the
   *  launching session's dial when a session is given, otherwise the campaign's
   *  newest session's dial (`resolveCampaignEmbedModel`, the rule every other
   *  session-less path uses). It used to default to the contract's shipped id,
   *  so an audit launched without a session on a campaign that plays on another
   *  embedding model deduplicated against, and embedded into, a namespace its
   *  sessions never read. */
  private embeddingModelFor(userId: string, campaignId: string, session: { contextOverridesJson: string | null } | null | undefined, settings: { embeddingModel: string } | undefined): string {
    if (session) return settings?.embeddingModel ?? embedModelFromOverrides(session.contextOverridesJson);
    return resolveCampaignEmbedModel(this.sessions, userId, campaignId);
  }

  enqueue(userId: string, campaignId: string, req: EnqueueCampaignAuditRequest): CampaignAuditStatusResponse {
    this.requireCampaign(userId, campaignId);
    if (this.runs.hasQueuedOrRunningByKindAndCampaign("campaign_audit", campaignId)) {
      throw new HttpError(409, "a campaign audit is already queued or running for this campaign");
    }
    // Engine dials are per-session overrides (world-tick lesson): resolve
    // through the launching session when one is given.
    const session = req.sessionId ? this.sessions.findById(userId, req.sessionId) : null;
    if (req.sessionId && (!session || session.campaignId !== campaignId)) {
      throw new HttpError(404, "session not found in this campaign");
    }
    const settings = this.contextEngine?.resolveSettings({ contextOverridesJson: session?.contextOverridesJson ?? null });
    // Explicit dialog pick wins; it must resolve or the run would fall back
    // silently to a model the user didn't choose.
    let modelId = settings?.auditModel ?? "claude-opus-4-6-bridge";
    if (req.modelId) {
      if (!this.customEndpoints || !resolveChatModelConfig(this.customEndpoints, userId, req.modelId)) {
        throw new HttpError(400, "audit model not found");
      }
      modelId = req.modelId;
    } else if (this.customEndpoints && !resolveChatModelConfig(this.customEndpoints, userId, modelId)) {
      // The Engine dial is validated the same way as the dialog pick:
      // the worker no longer substitutes the deployment default for a dial
      // that does not resolve, so a manual launch fails here, at the request,
      // instead of as a failed run a minute later.
      throw new HttpError(400, `audit model "${modelId}" is not available to this account — choose a model in the Engine panel`);
    }
    const now = new Date().toISOString();
    const runDetails: Record<string, unknown> = {
      mode: req.mode,
      auditModel: modelId,
      embeddingModel: this.embeddingModelFor(userId, campaignId, session, settings),
      workerEffort: settings?.workerEffort ?? "model-max",
      openaiFastMode: settings?.openaiFastModeEnabled ?? false,
      auto: false,
    };
    // Resume-from-failed seed: if the most-recent audit FAILED within 6h at the
    // SAME mode and left a checkpoint, carry it forward so this run resumes from
    // where that one died instead of re-paying for the phase-1 sweep.
    const prior = this.runs.findLatestByKindAndCampaign("campaign_audit", campaignId);
    let checkpointResetNote: string | null = null;
    if (prior && prior.status === "failed" && prior.userId === userId && prior.completedAt && Date.now() - Date.parse(prior.completedAt) < 6 * 60 * 60 * 1000) {
      try {
        const pd = JSON.parse(prior.detailsJson ?? "{}");
        if (pd?.checkpoint && pd?.mode === req.mode) {
          const automatic = pd.auto === true || pd.settledSource !== undefined || pd.transcriptInput !== undefined;
          let reusable = true;
          if (automatic) {
            try {
              const source = pd.settledSource;
              if (!source || ![source.sessionId, source.messageId, source.sourceUserMessageId, source.sourceUserContentHash, source.contentHash, source.settledByMessageId].every(field => typeof field === "string" && field.length > 0)
                || !Number.isInteger(source.sortOrder) || pd.transcriptInput === undefined
                || (req.mode === "full" && (!Array.isArray(pd.transcriptSessionIds) || pd.transcriptSessionIds.some((id: unknown) => typeof id !== "string" || !id)
                  || new Set(pd.transcriptSessionIds).size !== pd.transcriptSessionIds.length))) throw new Error("incomplete automatic checkpoint proof");
              new PipelineTranscriptInput(this.messages, userId, source, pd.transcriptInput).assertCurrent();
            } catch {
              // Re-borrowing a stale checkpoint on each manual retry would
              // fail forever. A fresh manual audit can inspect current history.
              reusable = false;
              checkpointResetNote = "A fresh campaign audit was queued because the previous automatic checkpoint no longer has valid transcript evidence.";
              runDetails.checkpointResetNote = checkpointResetNote;
              runDetails.discardedCheckpointRunId = prior.id;
            }
          }
          if (reusable) {
            runDetails.checkpoint = pd.checkpoint;
            // Keep the original accepted transcript proof even when the retry
            // is launched manually. The worker rechecks it before every write.
            for (const field of ["settledSource", "transcriptInput", "transcriptSessionIds"] as const) {
              if (pd[field] !== undefined) runDetails[field] = pd[field];
            }
            if (pd.usageCarry) runDetails.usageCarry = pd.usageCarry;
            runDetails.seededFrom = `resumed from failed run (${prior.id.slice(0, 8)})`;
          }
        }
      } catch { /* unparseable prior details — start fresh */ }
    }
    // The single-flight guard is re-checked inside the insert's transaction so
    // the check-then-act window above cannot admit a second audit.
    this.runs.transact(() => {
      if (this.runs.hasQueuedOrRunningByKindAndCampaign("campaign_audit", campaignId)) {
        throw new HttpError(409, "a campaign audit is already queued or running for this campaign");
      }
      this.runs.createRun({
        id: createId(), userId, campaignId, sessionId: req.sessionId ?? null, kind: "campaign_audit",
        priority: PIPELINE_KIND_PRIORITY.campaign_audit, status: "queued",
        detailsJson: JSON.stringify(runDetails),
        requestedAt: now, updatedAt: now,
      });
    });
    if (checkpointResetNote) recordSystemEvent({ userId, source: "campaign_audit", severity: "info", campaignId, sessionId: req.sessionId, message: checkpointResetNote, details: { priorRunId: prior!.id } });
    this.kick?.();
    return this.latest(userId, campaignId);
  }

  /** The composer review queue: active findings + a bounded ruled tail. */
  findings(userId: string, campaignId: string): AuditFindingsResponse {
    this.requireCampaign(userId, campaignId);
    if (!this.findingsRepo) throw new HttpError(503, "audit findings unavailable");
    const rows = this.findingsRepo.listForCampaign(userId, campaignId);
    const findings = rows.map((row) => this.toContract(userId, row));
    return {
      findings,
      openCount: findings.filter((f) => f.status === "open").length,
      processing: findings.some((f) => f.status === "processing"),
    };
  }

  /** Submit owner rulings on open findings → one `audit_ruling` executor run.
   *  Partial submits are fine (unruled findings simply stay open). The ruling
   *  text lives on the finding rows; the run details carry only the dials. */
  submitRulings(userId: string, campaignId: string, req: SubmitAuditRulingsRequest): AuditFindingsResponse {
    this.requireCampaign(userId, campaignId);
    if (!this.findingsRepo) throw new HttpError(503, "audit findings unavailable");
    if (this.runs.hasQueuedOrRunningByKindAndCampaign("audit_ruling", campaignId)) {
      throw new HttpError(409, "rulings are already being processed for this campaign");
    }
    const ids = req.rulings.map((r) => r.findingId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "duplicate finding in rulings");
    const rows = this.findingsRepo.findByIds(userId, campaignId, ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) throw new HttpError(404, `finding not found: ${id}`);
      if (row.status !== "open") throw new HttpError(409, `finding is not open: ${row.summary.slice(0, 80)}`);
    }
    const session = req.sessionId ? this.sessions.findById(userId, req.sessionId) : null;
    if (req.sessionId && (!session || session.campaignId !== campaignId)) {
      throw new HttpError(404, "session not found in this campaign");
    }
    const settings = this.contextEngine?.resolveSettings({ contextOverridesJson: session?.contextOverridesJson ?? null });
    const now = new Date().toISOString();
    const runId = createId();
    const findingsRepo = this.findingsRepo;
    // Marking the findings `processing` and creating their executor run are one
    // transaction: a failed insert used to leave them processing with a
    // rulingRunId that had no run — the same stuck state as a reaped executor,
    // reached with no worker involved. The single-flight guard is
    // re-checked inside for the same reason as `enqueue`.
    this.runs.transact(() => {
      if (this.runs.hasQueuedOrRunningByKindAndCampaign("audit_ruling", campaignId)) {
        throw new HttpError(409, "rulings are already being processed for this campaign");
      }
      findingsRepo.markProcessing(req.rulings, runId, now);
      this.runs.createRun({
        id: runId, userId, campaignId, sessionId: req.sessionId ?? null, kind: "audit_ruling",
        priority: PIPELINE_KIND_PRIORITY.audit_ruling, status: "queued",
        detailsJson: JSON.stringify({
          auditModel: settings?.auditModel ?? "claude-opus-4-6-bridge",
          embeddingModel: this.embeddingModelFor(userId, campaignId, session, settings),
          workerEffort: settings?.workerEffort ?? "model-max",
          openaiFastMode: settings?.openaiFastModeEnabled ?? false,
          findingIds: ids,
        }),
        requestedAt: now, updatedAt: now,
      });
    });
    this.kick?.();
    return this.findings(userId, campaignId);
  }

  private toContract(userId: string, row: AuditFindingRow): AuditFinding {
    let entryIds: string[] = [];
    try {
      const parsed = JSON.parse(row.entryIds);
      entryIds = Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === "string") : [];
    } catch { /* malformed — render without entry refs */ }
    const entryNames = this.lorebook
      ? entryIds.map((id) => this.lorebook!.findById(userId, id)?.name).filter((n): n is string => Boolean(n))
      : [];
    return {
      id: row.id, runId: row.runId, kind: row.kind, summary: row.summary,
      detail: row.detail, reason: row.reason, entryIds, entryNames,
      status: row.status as AuditFindingStatus,
      ruling: row.ruling, executorQuestion: row.executorQuestion, outcome: row.outcome,
      createdAt: row.createdAt, updatedAt: row.updatedAt, ruledAt: row.ruledAt,
    };
  }

  latest(userId: string, campaignId: string): CampaignAuditStatusResponse {
    this.requireCampaign(userId, campaignId);
    const run = this.runs.findLatestByKindAndCampaign("campaign_audit", campaignId);
    if (!run || run.userId !== userId) {
      return { runId: null, status: null, mode: null, modelId: null, auto: false, progress: null, report: null, error: null, requestedAt: null, completedAt: null };
    }
    const details = safeDetails(run.detailsJson);
    return {
      runId: run.id,
      status: run.status as PipelineRunStatus,
      mode: details?.mode ?? null,
      modelId: details?.auditModel ?? null,
      auto: details?.auto ?? false,
      progress: details?.progress ?? null,
      report: details?.report ?? null,
      error: run.error ?? null,
      requestedAt: run.requestedAt,
      completedAt: run.completedAt ?? null,
    };
  }
}

function safeDetails(json: string | null): AuditDetails | null {
  if (!json) return null;
  try { return JSON.parse(json) as AuditDetails; } catch { return null; }
}
