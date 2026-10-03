import { Router } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { AuthService } from "../../domain/auth/authService";
import type { InviteService } from "../../domain/auth/inviteService";
import type { SqliteSessionStore } from "../../services/sqliteSessionStore";
import { createAuthController } from "../controllers/authController";

export function createAuthRoutes(authService: AuthService, audit?: AuditService, sessionStore?: SqliteSessionStore, invites?: InviteService) {
  const router = Router();
  const controller = createAuthController(authService, audit, sessionStore, invites);
  router.post("/register", controller.register);
  router.post("/register/verify", controller.verifyRegistration);
  router.post("/register/resend", controller.resendRegistration);
  router.post("/forgot-password", controller.forgotPassword);
  router.post("/forgot-password/resend", controller.resendPasswordReset);
  router.post("/forgot-password/verify", controller.verifyPasswordReset);
  router.post("/forgot-password/reset", controller.resetPassword);
  router.post("/mfa/resend", controller.resendMfaCode);
  router.post("/mfa/verify", controller.verifyMfaCode);
  // Required two-factor and none set up yet: an authenticator before the account is signed in.
  router.post("/two-factor/setup/start", controller.startForcedTwoFactorSetup);
  router.post("/two-factor/setup/confirm", controller.confirmForcedTwoFactorSetup);
  // Invite links: what a link points at, and the account it creates.
  router.get("/invites/:token", controller.peekInvite);
  router.post("/invites/accept", controller.acceptInvite);
  router.post("/login", controller.login);
  router.post("/logout", controller.logout);
  router.get("/me", controller.me);
  return router;
}
