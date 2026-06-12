import type { RequestHandler } from "express";

import { approvePipelineRunRequestSchema, enqueuePipelineRunRequestSchema, retryPipelineRunRequestSchema } from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { PipelineService } from "../../domain/pipeline/pipelineService";
import { getAuditContext } from "../auditContext";

export function createPipelineController(pipeline: PipelineService, audit: AuditService) {
  const listActiveRuns: RequestHandler = (req, res, next) => {
    try {
      res.json(pipeline.listActiveRuns(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const listCampaignRuns: RequestHandler = (req, res, next) => {
    try {
      res.json(pipeline.listCampaignRuns(req.session.userId!, String(req.params.campaignId)));
    } catch (error) {
      next(error);
    }
  };

  const enqueueCampaignRun: RequestHandler = (req, res, next) => {
    try {
      const campaignId = String(req.params.campaignId);
      const parsed = enqueuePipelineRunRequestSchema.safeParse(req.body);
      if (req.body && !parsed.success) return res.status(400).json({ error: parsed.error.message });
      const response = pipeline.enqueueCampaignRun(req.session.userId!, campaignId, parsed.success ? parsed.data ?? undefined : undefined);
      audit.record({
        ...getAuditContext(req, res, {
          campaignId,
          runId: response.runs[0]?.id ?? null,
          targetType: "pipeline-run",
          targetId: response.runs[0]?.id ?? null,
        }),
        action: "pipeline.run.enqueued",
        metadata: { campaignId, runId: response.runs[0]?.id ?? null },
      });
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  const approveCampaignRun: RequestHandler = (req, res, next) => {
    try {
      const campaignId = String(req.params.campaignId);
      const runId = String(req.params.runId);
      const parsed = approvePipelineRunRequestSchema.safeParse(req.body);
      if (req.body && !parsed.success) return res.status(400).json({ error: parsed.error.message });
      const response = pipeline.approveCampaignRun(req.session.userId!, campaignId, runId, parsed.success ? parsed.data : {});
      audit.record({
        ...getAuditContext(req, res, { campaignId, runId, targetType: "pipeline-run", targetId: runId }),
        action: "pipeline.run.approved",
        metadata: {
          campaignId,
          runId,
          startSession: req.body?.startSession === true,
          approvedSessionId: response.runs[0]?.review.approvedSessionId ?? null,
        },
      });
      res.json(response);
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

  const retryCampaignRun: RequestHandler = (req, res, next) => {
    try {
      const campaignId = String(req.params.campaignId);
      const runId = String(req.params.runId);
      const parsed = retryPipelineRunRequestSchema.safeParse(req.body);
      if (req.body && !parsed.success) return res.status(400).json({ error: parsed.error.message });
      const response = pipeline.retryCampaignRun(req.session.userId!, campaignId, runId, parsed.success ? parsed.data : {});
      audit.record({
        ...getAuditContext(req, res, {
          campaignId,
          runId: response.runs[0]?.id ?? runId,
          targetType: "pipeline-run",
          targetId: response.runs[0]?.id ?? runId,
        }),
        action: "pipeline.run.retried",
        metadata: {
          campaignId,
          fromRunId: runId,
          newRunId: response.runs[0]?.id ?? null,
          fromStep: req.body?.fromStep ?? null,
        },
      });
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  const abandonCampaignRun: RequestHandler = (req, res, next) => {
    try {
      const campaignId = String(req.params.campaignId);
      const runId = String(req.params.runId);
      const response = pipeline.abandonCampaignRun(req.session.userId!, campaignId, runId);
      audit.record({
        ...getAuditContext(req, res, { campaignId, runId, targetType: "pipeline-run", targetId: runId }),
        action: "pipeline.run.abandoned",
        metadata: { campaignId, runId },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const listRunArtifacts: RequestHandler = (req, res, next) => {
    try {
      res.json(pipeline.listRunArtifacts(req.session.userId!, String(req.params.runId)));
    } catch (error) {
      next(error);
    }
  };

  return { listActiveRuns, listCampaignRuns, enqueueCampaignRun, approveCampaignRun, cancelCampaignRun, retryCampaignRun, abandonCampaignRun, listRunArtifacts };
}
