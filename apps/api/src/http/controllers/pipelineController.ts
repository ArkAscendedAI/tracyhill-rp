import type { RequestHandler } from "express";

import { AUDIT_RULING_MAX_CHARS, AUDIT_RULINGS_PER_SUBMIT_MAX, enqueueCampaignAuditRequestSchema, pipelineRunsQuerySchema, submitAuditRulingsRequestSchema } from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { CampaignAuditService } from "../../domain/pipeline/campaignAuditService";
import type { PipelineService } from "../../domain/pipeline/pipelineService";
import { getAuditContext } from "../auditContext";
import { describeIssues } from "../describeIssues";

export function createPipelineController(pipeline: PipelineService, audit: AuditService, campaignAudit?: CampaignAuditService | null) {
  const listActiveRuns: RequestHandler = (req, res, next) => {
    try {
      res.json(pipeline.listActiveRuns(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const listCampaignRuns: RequestHandler = (req, res, next) => {
    try {
      const parsed = pipelineRunsQuerySchema.safeParse(req.query);
      if (!parsed.success) { res.status(400).json({ error: "invalid runs query: limit must be 1-500 and runId a run id" }); return; }
      res.json(pipeline.listCampaignRuns(req.session.userId!, String(req.params.campaignId), parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const cancelCampaignRun: RequestHandler = (req, res, next) => {
    try {
      const campaignId = String(req.params.campaignId);
      const runId = String(req.params.runId);
      const response = pipeline.cancelCampaignRun(req.session.userId!, campaignId, runId);
      audit.record({
        ...getAuditContext(req, res, { campaignId, runId, targetType: "pipeline-run", targetId: runId }),
        action: "pipeline.run.canceled",
        metadata: { campaignId, runId },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const enqueueRecap: RequestHandler = (req, res, next) => {
    try {
      const campaignId = String(req.params.campaignId);
      const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId ? req.query.sessionId : null;
      const response = pipeline.enqueueRecap(req.session.userId!, campaignId, sessionId);
      audit.record({
        ...getAuditContext(req, res, { campaignId, runId: response.runId, targetType: "pipeline-run", targetId: response.runId }),
        action: "pipeline.recap.enqueued",
        metadata: { campaignId, sessionId: response.sessionId, runId: response.runId },
      });
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  const recapStatus: RequestHandler = (req, res, next) => {
    try {
      const campaignId = String(req.params.campaignId);
      const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId ? req.query.sessionId : null;
      res.json(pipeline.getLatestRecap(req.session.userId!, campaignId, sessionId));
    } catch (error) {
      next(error);
    }
  };

  const enqueueCampaignAudit: RequestHandler = (req, res, next) => {
    try {
      if (!campaignAudit) { res.status(503).json({ error: "campaign audit unavailable" }); return; }
      const campaignId = String(req.params.campaignId);
      const parsed = enqueueCampaignAuditRequestSchema.safeParse(req.body);
      // The field and the reason follow the old prefix.
      if (!parsed.success) { res.status(400).json({ error: `invalid audit request: ${describeIssues(parsed.error)}` }); return; }
      const response = campaignAudit.enqueue(req.session.userId!, campaignId, parsed.data);
      audit.record({
        ...getAuditContext(req, res, { campaignId, runId: response.runId, targetType: "pipeline-run", targetId: response.runId }),
        action: "pipeline.audit.enqueued",
        metadata: { campaignId, runId: response.runId, mode: parsed.data.mode, modelId: response.modelId },
      });
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  const campaignAuditStatus: RequestHandler = (req, res, next) => {
    try {
      if (!campaignAudit) { res.status(503).json({ error: "campaign audit unavailable" }); return; }
      res.json(campaignAudit.latest(req.session.userId!, String(req.params.campaignId)));
    } catch (error) {
      next(error);
    }
  };

  const auditFindings: RequestHandler = (req, res, next) => {
    try {
      if (!campaignAudit) { res.status(503).json({ error: "campaign audit unavailable" }); return; }
      res.json(campaignAudit.findings(req.session.userId!, String(req.params.campaignId)));
    } catch (error) {
      next(error);
    }
  };

  const submitAuditRulings: RequestHandler = (req, res, next) => {
    try {
      if (!campaignAudit) { res.status(503).json({ error: "campaign audit unavailable" }); return; }
      const campaignId = String(req.params.campaignId);
      const parsed = submitAuditRulingsRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: describeRulingsRequestProblem(parsed.error.issues, req.body) }); return; }
      const response = campaignAudit.submitRulings(req.session.userId!, campaignId, parsed.data);
      audit.record({
        ...getAuditContext(req, res, { campaignId, targetType: "campaign", targetId: campaignId }),
        action: "pipeline.audit.rulings-submitted",
        metadata: { campaignId, count: parsed.data.rulings.length },
      });
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  return { listActiveRuns, listCampaignRuns, cancelCampaignRun, enqueueRecap, recapStatus, enqueueCampaignAudit, campaignAuditStatus, auditFindings, submitAuditRulings };
}

/**
 * The 400 for a rulings submit the contract refuses, naming the cap or the ruling that broke it. It used to
 * be the bare "invalid rulings request", which clients show verbatim (Android 1.2.0 among them), so an owner with 51
 * ready rulings or one pasted past 4,000 characters had nothing to go on. The prefix stays for anything that greps it.
 */
function describeRulingsRequestProblem(issues: ReadonlyArray<{ code: string; path: ReadonlyArray<string | number> }>, body: unknown): string {
  const issue = issues[0];
  const rulings = (body as { rulings?: unknown } | null)?.rulings;
  const sent = Array.isArray(rulings) ? rulings.length : 0;
  const count = (n: number) => n.toLocaleString("en-US");
  let problem: string | null = null;
  if (issue?.path.length === 1 && issue.path[0] === "rulings") {
    if (issue.code === "too_big") problem = `at most ${AUDIT_RULINGS_PER_SUBMIT_MAX} rulings per submit (${count(sent)} sent)`;
    else if (issue.code === "too_small") problem = "no rulings to submit";
  } else if (issue?.path.length === 3 && issue.path[0] === "rulings" && typeof issue.path[1] === "number" && issue.path[2] === "ruling") {
    const index = issue.path[1];
    const text = (rulings as Array<{ ruling?: unknown }>)[index]?.ruling;
    const length = typeof text === "string" ? text.trim().length : 0;
    if (issue.code === "too_big") problem = `ruling ${index + 1} of ${sent} is ${count(length)} characters; a ruling can be at most ${count(AUDIT_RULING_MAX_CHARS)}`;
    else if (issue.code === "too_small") problem = `ruling ${index + 1} of ${sent} is empty`;
  }
  return problem ? `invalid rulings request: ${problem}` : "invalid rulings request";
}
