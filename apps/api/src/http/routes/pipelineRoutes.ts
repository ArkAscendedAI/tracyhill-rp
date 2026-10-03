import { Router } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { CampaignAuditService } from "../../domain/pipeline/campaignAuditService";
import type { PipelineService } from "../../domain/pipeline/pipelineService";
import type { PipelineRunRepository } from "../../domain/pipeline/pipelineRunRepository";
import { createPipelineController } from "../controllers/pipelineController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createPipelineRoutes(pipeline: PipelineService, audit: AuditService, users: UserRepository, pipelineRuns?: PipelineRunRepository, campaignAudit?: CampaignAuditService | null) {
  const router = Router();
  const controller = createPipelineController(pipeline, audit, campaignAudit);
  router.use(createRequireAuth(users));
  router.get("/active", controller.listActiveRuns);
  router.get("/campaigns/:campaignId/runs", controller.listCampaignRuns);
  router.post("/campaigns/:campaignId/recap", controller.enqueueRecap);
  router.get("/campaigns/:campaignId/recap", controller.recapStatus);
  router.post("/campaigns/:campaignId/audit", controller.enqueueCampaignAudit);
  router.get("/campaigns/:campaignId/audit/latest", controller.campaignAuditStatus);
  router.get("/campaigns/:campaignId/audit/findings", controller.auditFindings);
  router.post("/campaigns/:campaignId/audit/findings/rulings", controller.submitAuditRulings);
  router.post("/campaigns/:campaignId/runs/:runId/cancel", controller.cancelCampaignRun);
  router.get("/queue-status", (req, res) => {
    // Express delivers ?campaignId=a&campaignId=b as a string[], so the prior
    // `as string | undefined` cast lied; pass the array straight to Drizzle's
    // eq() and you get wrong rows. Validate explicitly.
    const raw = req.query.campaignId;
    const campaignId = typeof raw === "string" ? raw : undefined;
    if (!campaignId || !pipelineRuns) { res.json({ campaignId: campaignId ?? "", jobs: [] }); return; }
    // Ownership: every other pipeline route scopes by the session user; this
    // one used to return any campaign's run metadata to any authenticated user.
    const jobs = pipelineRuns.listQueuedOrRunningForCampaign(campaignId)
      .filter((j) => j.userId === req.session.userId);
    const now = Date.now();
    res.json({
      campaignId,
      jobs: jobs.map(j => ({
        runId: j.id,
        kind: j.kind,
        status: j.status as "queued" | "running",
        priority: j.priority,
        startedAt: j.startedAt ?? null,
        elapsedMs: j.startedAt ? now - new Date(j.startedAt).getTime() : null,
      })),
    });
  });
  // `/runs/:runId/stream` (the pipeline SSE bus) and `/runs/:runId/artifacts`
  // were removed 2026-09-02 once their last clients went: the bus never had a
  // publisher after the campaign_review sunset, and the artifacts table has had
  // no writer since 2026-07-10. Run progress is polled via
  // `/active` and `/queue-status`.
  return router;
}
