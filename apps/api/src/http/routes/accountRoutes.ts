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
  // Set/change the account email with a code sent to the NEW address.
  router.post("/email", controller.requestEmailChange);
  router.post("/email/verify", controller.verifyEmailChange);
  router.get("/mfa", controller.getMfaStatus);
  router.get("/mfa/trusted-devices", controller.getTrustedDevices);
  router.delete("/mfa/trusted-devices/:deviceId", controller.revokeTrustedDevice);
  router.delete("/mfa/trusted-devices", controller.revokeAllTrustedDevices);
  // Authenticator-app two-factor. Changes ask for the password again.
  router.get("/two-factor", controller.getTwoFactorStatus);
  router.post("/two-factor/totp/start", controller.startTotp);
  router.post("/two-factor/totp/confirm", controller.confirmTotp);
  router.post("/two-factor/totp/disable", controller.disableTotp);
  router.post("/two-factor/recovery-codes", controller.regenerateRecoveryCodes);
  router.post("/delete-request", controller.requestAccountDeletion);
  router.post("/delete-request/send-code", controller.resendAccountDeletion);
  router.post("/delete-confirm", controller.confirmAccountDeletion);
  router.delete("/delete-execute", controller.executeAccountDeletion);
  return router;
}
