import { Router } from "express";
import type { RequestHandler } from "express";

import { codexSendRequestSchema, codexUploadRequestSchema } from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { CodexBridge } from "../../domain/codex/codexBridgeService";
import { getAuditContext } from "../auditContext";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createCodexRoutes(codex: CodexBridge, audit: AuditService, requireAdmin: RequestHandler, users: UserRepository) {
  const router = Router();
  router.use(createRequireAuth(users), requireAdmin);

  router.get("/status", async (_req, res) => {
    try {
      res.json(await codex.getStatus());
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Codex bridge unavailable" });
    }
  });

  router.post("/upload", async (req, res) => {
    try {
      const payload = codexUploadRequestSchema.parse(req.body);
      const response = await codex.upload(payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "codex-upload", targetId: response.path }),
        action: "codex.uploaded",
        metadata: { name: response.name, path: response.path },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Upload failed" });
    }
  });

  router.post("/send", async (req, res) => {
    try {
      const payload = codexSendRequestSchema.parse(req.body);
      audit.record({
        ...getAuditContext(req, res, { targetType: "codex-session", targetId: payload.sessionId ?? payload.workspaceId ?? "new-session" }),
        action: "codex.send_started",
        metadata: {
          sessionId: payload.sessionId ?? null,
          workspaceId: payload.workspaceId ?? null,
          promptLength: payload.prompt?.length ?? 0,
          hasFiles: Boolean(payload.files?.length),
        },
      });
      await codex.streamSend(payload, res, () => undefined);
    } catch (error) {
      if (!res.headersSent) res.status(502).json({ error: error instanceof Error ? error.message : "Codex bridge unavailable" });
      else try { res.end(); } catch {}
    }
  });

  router.get("/sessions", async (_req, res) => {
    try {
      res.json(await codex.listSessions());
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Codex bridge unavailable" });
    }
  });

  router.get("/sessions/:sessionId/messages", async (req, res) => {
    try {
      res.json(await codex.getMessages(req.params.sessionId));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to load session messages" });
    }
  });

  router.get("/sessions/:sessionId/output/:itemId", async (req, res) => {
    try {
      res.json(await codex.getOutput(req.params.sessionId, req.params.itemId));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to load command output" });
    }
  });

  router.post("/sessions/:sessionId/interrupt", async (req, res) => {
    try {
      const response = await codex.interrupt(req.params.sessionId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "codex-session", targetId: req.params.sessionId }),
        action: "codex.interrupted",
        metadata: { sessionId: req.params.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to interrupt session" });
    }
  });

  router.delete("/sessions/:sessionId", async (req, res) => {
    try {
      const response = await codex.deleteSession(req.params.sessionId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "codex-session", targetId: req.params.sessionId }),
        action: "codex.deleted",
        metadata: { sessionId: req.params.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to delete session" });
    }
  });

  return router;
}
