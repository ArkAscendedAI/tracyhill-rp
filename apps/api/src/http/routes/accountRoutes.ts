import { Router } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { AuthService } from "../../domain/auth/authService";
import type { UserRepository } from "../../domain/users/userRepository";
import type { SqliteSessionStore } from "../../services/sqliteSessionStore";
import { createRequireAuth } from "../middleware/requireAuth";
import { createAuthController } from "../controllers/authController";

export function createAccountRoutes(authService: AuthService, audit: AuditService, users: UserRepository, sessionStore?: SqliteSessionStore) {
  const router = Router();
  const controller = createAuthController(authService, audit, sessionStore);
  router.use(createRequireAuth(users));
  router.put("/password", controller.changePassword);
  router.get("/mfa", controller.getMfaStatus);
  router.get("/mfa/trusted-devices", controller.getTrustedDevices);
  router.delete("/mfa/trusted-devices/:deviceId", controller.revokeTrustedDevice);
  router.delete("/mfa/trusted-devices", controller.revokeAllTrustedDevices);
  router.post("/delete-request", controller.requestAccountDeletion);
  router.post("/delete-request/send-code", controller.resendAccountDeletion);
  router.post("/delete-confirm", controller.confirmAccountDeletion);
  router.delete("/delete-execute", controller.executeAccountDeletion);
  return router;
}
