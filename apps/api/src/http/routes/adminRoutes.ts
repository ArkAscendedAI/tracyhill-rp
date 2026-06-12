import { Router } from "express";

import type { RequestHandler } from "express";

import type { AuditService } from "../../domain/audit/auditService";
import type { AdminService } from "../../domain/admin/adminService";
import { createAdminController } from "../controllers/adminController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createAdminRoutes(admin: AdminService, audit: AuditService, requireAdmin: RequestHandler, users: UserRepository) {
  const router = Router();
  const controller = createAdminController(admin, audit);
  router.use(createRequireAuth(users), requireAdmin);
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
