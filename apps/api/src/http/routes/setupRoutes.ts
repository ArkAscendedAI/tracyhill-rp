import { Router } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { SetupService } from "../../domain/setup/setupService";
import { createSetupController } from "../controllers/setupController";

// Reachable before anyone is signed in, like /api/auth: the code check and the first account. Whether setup is needed
// is part of the public sign-in options (GET /api/auth/options).
export function createSetupRoutes(setup: SetupService, audit?: AuditService) {
  const router = Router();
  const controller = createSetupController(setup, audit);
  router.post("/verify", controller.verify);
  router.post("/admin", controller.createAdmin);
  return router;
}
