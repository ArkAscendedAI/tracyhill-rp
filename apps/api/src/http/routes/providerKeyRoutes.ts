import { Router } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { ProviderKeyService } from "../../domain/providerKeys/providerKeyService";
import { createProviderKeyController } from "../controllers/providerKeyController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createProviderKeyRoutes(keys: ProviderKeyService, audit: AuditService, users: UserRepository) {
  const router = Router();
  const controller = createProviderKeyController(keys, audit);
  router.use(createRequireAuth(users));
  router.get("/", controller.list);
  router.put("/", controller.update);
  return router;
}
