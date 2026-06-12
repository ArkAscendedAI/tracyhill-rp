import { Router } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { WizardService } from "../../domain/wizard/wizardService";
import { createWizardController } from "../controllers/wizardController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createWizardRoutes(wizard: WizardService, audit: AuditService, users: UserRepository) {
  const router = Router();
  const controller = createWizardController(wizard, audit);
  router.use(createRequireAuth(users));
  router.get("/active", controller.listActiveRuns);
  router.get("/templates", controller.getTemplates);
  router.put("/templates", controller.updateTemplates);
  router.get("/runs", controller.listRuns);
  router.post("/runs", controller.enqueueRun);
  router.post("/runs/:runId/approve", controller.approveRun);
  router.post("/runs/:runId/retry", controller.retryRun);
  router.post("/runs/:runId/cancel", controller.cancelRun);
  return router;
}
