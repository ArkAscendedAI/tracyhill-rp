import type { RequestHandler } from "express";

import { approveWizardRunRequestSchema, enqueueWizardRunRequestSchema, updateWizardTemplatesRequestSchema } from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { WizardService } from "../../domain/wizard/wizardService";
import { getAuditContext } from "../auditContext";

export function createWizardController(wizard: WizardService, audit: AuditService) {
  const listActiveRuns: RequestHandler = (req, res, next) => {
    try {
      res.json(wizard.listActiveRuns(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const getTemplates: RequestHandler = (req, res, next) => {
    try {
      res.json(wizard.getTemplates(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const updateTemplates: RequestHandler = (req, res, next) => {
    try {
      const parsed = updateWizardTemplatesRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid wizard template request" });
        return;
      }
      const response = wizard.updateTemplates(req.session.userId!, parsed.data);
      audit.record({
        ...getAuditContext(req, res, { targetType: "wizard-templates", targetId: req.session.userId! }),
        action: "wizard.templates.updated",
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const listRuns: RequestHandler = (req, res, next) => {
    try {
      res.json(wizard.listRuns(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const enqueueRun: RequestHandler = (req, res, next) => {
    try {
      const parsed = enqueueWizardRunRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid wizard run request" });
        return;
      }
      const response = wizard.enqueueRun(req.session.userId!, parsed.data);
      audit.record({
        ...getAuditContext(req, res, { runId: response.runs[0]?.id ?? null, targetType: "wizard-run", targetId: response.runs[0]?.id ?? null }),
        action: "wizard.run.enqueued",
        metadata: {
          runId: response.runs[0]?.id ?? null,
          campaignName: parsed.data.campaignName,
          modelId: parsed.data.modelId,
          wizardSessionId: parsed.data.wizardSessionId ?? null,
        },
      });
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  const approveRun: RequestHandler = (req, res, next) => {
    try {
      const parsed = approveWizardRunRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "invalid wizard approve request" });
        return;
      }
      const runId = String(req.params.runId);
      const response = wizard.approveRun(req.session.userId!, runId, parsed.data);
      audit.record({
        ...getAuditContext(req, res, { runId, targetType: "wizard-run", targetId: runId }),
        action: "wizard.run.approved",
        metadata: {
          runId,
          campaignName: parsed.data.campaignName ?? null,
          approvedCampaignId: response.runs[0]?.review.approvedCampaignId ?? null,
          approvedSessionId: response.runs[0]?.review.approvedSessionId ?? null,
        },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const retryRun: RequestHandler = (req, res, next) => {
    try {
      const runId = String(req.params.runId);
      const response = wizard.retryRun(req.session.userId!, runId);
      audit.record({
        ...getAuditContext(req, res, { runId: response.runs[0]?.id ?? runId, targetType: "wizard-run", targetId: response.runs[0]?.id ?? runId }),
        action: "wizard.run.retried",
        metadata: {
          fromRunId: runId,
          newRunId: response.runs[0]?.id ?? null,
        },
      });
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  };

  const cancelRun: RequestHandler = (req, res, next) => {
    try {
      const runId = String(req.params.runId);
      const response = wizard.cancelRun(req.session.userId!, runId);
      audit.record({
        ...getAuditContext(req, res, { runId, targetType: "wizard-run", targetId: runId }),
        action: "wizard.run.canceled",
        metadata: { runId },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  return { listActiveRuns, getTemplates, updateTemplates, listRuns, enqueueRun, approveRun, retryRun, cancelRun };
}
