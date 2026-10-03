import { Router } from "express";

import type { RequestHandler } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { AdminService } from "../../domain/admin/adminService";
import { createAdminController } from "../controllers/adminController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createInviteRequestSchema } from "@tracyhill-rp/contracts";

import type { InviteService } from "../../domain/auth/inviteService";
import { validateUsername } from "../../lib/password";
import { getAuditContext } from "../auditContext";
import { describeIssues } from "../describeIssues";
import { createRequireAuth } from "../middleware/requireAuth";

export function createAdminRoutes(admin: AdminService, audit: AuditService, requireAdmin: RequestHandler, users: UserRepository, resetTwoFactor?: (userId: string) => void, invites?: InviteService) {
  const router = Router();
  const controller = createAdminController(admin, audit);
  router.use(createRequireAuth(users), requireAdmin);
  // A lost phone: the account's authenticator, recovery codes and trusted devices are removed; its next
  // sign-in asks for a new authenticator if the server requires one.
  router.post("/users/:userId/two-factor/reset", (req, res, next) => {
    try {
      if (!resetTwoFactor) { res.status(503).json({ error: "Two-factor is not available on this server" }); return; }
      const userId = String(req.params.userId);
      resetTwoFactor(userId);
      audit.record({ ...getAuditContext(req, res, { targetType: "user", targetId: userId }), action: "admin.user.two_factor_reset" });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  // Invite links: the token is in the create response only; lists never carry one.
  router.get("/invites", (_req, res) => {
    if (!invites) { res.status(503).json({ error: "Invites are not available on this server" }); return; }
    res.json({ invites: invites.list() });
  });
  router.post("/invites", (req, res, next) => {
    try {
      if (!invites) { res.status(503).json({ error: "Invites are not available on this server" }); return; }
      const parsed = createInviteRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) { res.status(400).json({ error: `invalid invite request: ${describeIssues(parsed.error)}` }); return; }
      // A fixed username is checked now, so a link is never made that nobody can use.
      if (parsed.data.username) {
        const usernameError = validateUsername(parsed.data.username);
        if (usernameError) { res.status(400).json({ error: usernameError }); return; }
        if (users.findByUsername(parsed.data.username)) { res.status(409).json({ error: "Username already taken" }); return; }
      }
      const created = invites.create(req.session.userId!, parsed.data);
      audit.record({ ...getAuditContext(req, res, { targetType: "invite", targetId: created.invite.id }), action: "admin.invite.created", metadata: { role: created.invite.role, fixedUsername: Boolean(created.invite.username), days: parsed.data.days } });
      res.status(201).json({ ok: true, ...created });
    } catch (error) {
      next(error);
    }
  });
  router.delete("/invites/:inviteId", (req, res) => {
    if (!invites) { res.status(503).json({ error: "Invites are not available on this server" }); return; }
    const inviteId = String(req.params.inviteId);
    if (!invites.revoke(inviteId)) { res.status(404).json({ error: "No open invite with that id" }); return; }
    audit.record({ ...getAuditContext(req, res, { targetType: "invite", targetId: inviteId }), action: "admin.invite.revoked" });
    res.json({ ok: true });
  });
  router.get("/users", controller.listUsers);
  router.post("/users", controller.createUser);
  router.delete("/users/:userId", controller.deleteUser);
  router.put("/users/:userId/password", controller.resetUserPassword);
  router.put("/users/:userId/role", controller.updateUserRole);
  router.get("/users/:userId/sessions", controller.listUserSessions);
  router.get("/users/:userId/sessions/:sessionId", controller.getUserSessionDetail);
  router.get("/audit-events", controller.listAuditEvents);
  router.get("/storage", controller.storage);
  router.delete("/images", controller.purgeImages);
  return router;
}
