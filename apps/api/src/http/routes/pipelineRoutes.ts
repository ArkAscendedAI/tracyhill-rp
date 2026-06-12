import { Router } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { PipelineService } from "../../domain/pipeline/pipelineService";
import type { PipelineRunRepository } from "../../domain/pipeline/pipelineRunRepository";
import { pipelineStreamBus } from "../../domain/pipeline/pipelineStreamBus";
import { createPipelineController } from "../controllers/pipelineController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createPipelineRoutes(pipeline: PipelineService, audit: AuditService, users: UserRepository, pipelineRuns?: PipelineRunRepository) {
  const router = Router();
  const controller = createPipelineController(pipeline, audit);
  router.use(createRequireAuth(users));
  router.get("/active", controller.listActiveRuns);
  router.get("/campaigns/:campaignId/runs", controller.listCampaignRuns);
  router.post("/campaigns/:campaignId/runs", controller.enqueueCampaignRun);
  router.post("/campaigns/:campaignId/runs/:runId/approve", controller.approveCampaignRun);
  router.post("/campaigns/:campaignId/runs/:runId/cancel", controller.cancelCampaignRun);
  router.post("/campaigns/:campaignId/runs/:runId/retry", controller.retryCampaignRun);
  router.post("/campaigns/:campaignId/runs/:runId/abandon", controller.abandonCampaignRun);
  router.get("/runs/:runId/artifacts", controller.listRunArtifacts);
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
  router.get("/runs/:runId/stream", (req, res) => {
    try {
      pipeline.listRunArtifacts(req.session.userId!, req.params.runId);
    } catch {
      res.status(404).json({ error: "pipeline run not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    });
    const unsubscribe = pipelineStreamBus.subscribe(req.params.runId, res);
    const hb = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); } }, 15000);
    req.on("close", () => { clearInterval(hb); unsubscribe(); });
  });
  return router;
}
