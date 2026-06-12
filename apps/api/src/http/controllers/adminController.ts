import type { RequestHandler } from "express";

import {
  adminResetUserPasswordRequestSchema,
  adminUpdateUserRoleRequestSchema,
  createAdminUserRequestSchema,
} from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { AdminService } from "../../domain/admin/adminService";
import { getAuditContext } from "../auditContext";

export function createAdminController(admin: AdminService, audit: AuditService) {
  const storage: RequestHandler = (req, res, next) => {
    try {
      const response = admin.getStorage();
      audit.record({
        ...getAuditContext(req, res),
        action: "admin.storage.viewed",
        metadata: {
          imageCount: response.dataDir.imageCount,
          totalBytes: response.dataDir.total,
        },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const purgeImages: RequestHandler = (req, res, next) => {
    try {
      const response = admin.purgeImages();
      audit.record({
        ...getAuditContext(req, res, { targetType: "images", targetId: "generated-images" }),
        action: "admin.images.purged",
        metadata: { deleted: response.deleted },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const listUsers: RequestHandler = (req, res, next) => {
    try {
      const response = admin.listUsers();
      audit.record({
        ...getAuditContext(req, res),
        action: "admin.users.listed",
        metadata: { count: response.users.length },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const createUser: RequestHandler = async (req, res, next) => {
    try {
      const parsed = createAdminUserRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid admin user request" });
        return;
      }
      const response = await admin.createUser(parsed.data);
      audit.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: response.user.id }),
        action: "admin.user.created",
        metadata: {
          username: response.user.username,
          role: response.user.role,
        },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const deleteUser: RequestHandler = (req, res, next) => {
    try {
      const targetUserId = String(req.params.userId);
      const response = admin.deleteUser(req.session.userId!, targetUserId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: targetUserId }),
        action: "admin.user.deleted",
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const resetUserPassword: RequestHandler = async (req, res, next) => {
    try {
      const parsed = adminResetUserPasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid admin password request" });
        return;
      }
      const targetUserId = String(req.params.userId);
      const response = await admin.resetUserPassword(targetUserId, parsed.data);
      audit.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: targetUserId }),
        action: "admin.user.password_reset",
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const updateUserRole: RequestHandler = (req, res, next) => {
    try {
      const parsed = adminUpdateUserRoleRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid admin role request" });
        return;
      }
      const targetUserId = String(req.params.userId);
      const response = admin.updateUserRole(req.session.userId!, targetUserId, parsed.data);
      audit.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: targetUserId }),
        action: "admin.user.role_updated",
        metadata: { role: response.user.role },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const listUserSessions: RequestHandler = (req, res, next) => {
    try {
      const targetUserId = String(req.params.userId);
      const response = admin.listUserSessions(targetUserId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: targetUserId }),
        action: "admin.user.sessions_listed",
        metadata: {
          username: response.username,
          sessionCount: response.sessions.length,
        },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const getUserSessionDetail: RequestHandler = (req, res, next) => {
    try {
      const targetUserId = String(req.params.userId);
      const sessionId = String(req.params.sessionId);
      const response = admin.getUserSessionDetail(targetUserId, sessionId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "session", targetId: sessionId, sessionId }),
        action: "admin.user.session_viewed",
        metadata: {
          targetUserId,
          username: response.username,
          messageCount: response.messages.length,
        },
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const listAuditEvents: RequestHandler = (req, res, next) => {
    try {
      const rawLimit = Number.parseInt(String(req.query.limit ?? "100"), 10);
      res.json(audit.listRecent(Number.isNaN(rawLimit) ? 100 : rawLimit));
    } catch (error) {
      next(error);
    }
  };

  return { storage, purgeImages, listUsers, createUser, deleteUser, resetUserPassword, updateUserRole, listUserSessions, getUserSessionDetail, listAuditEvents };
}
