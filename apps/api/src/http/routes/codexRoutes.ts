import { Router } from "express";
import type { RequestHandler, Response } from "express";

import {
  PANEL_UPLOAD_MAX_BYTES,
  base64DecodedBytes,
  codexAnswerRequestSchema,
  codexForkRequestSchema,
  codexPatchRequestSchema,
  codexReviewRequestSchema,
  codexSendRequestSchema,
  codexSettingsRequestSchema,
  codexShellRequestSchema,
  codexSteerRequestSchema,
  codexUploadRequestSchema,
} from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { CodexBridge } from "../../domain/codex/codexBridgeService";
import { codexUpstreamStatus } from "../../domain/codex/codexBridgeService";
import type { UserRepository } from "../../domain/users/userRepository";
import { getAuditContext } from "../auditContext";
import { createRequireAuth } from "../middleware/requireAuth";

export function createCodexRoutes(codex: CodexBridge, audit: AuditService, requireAdmin: RequestHandler, users: UserRepository) {
  const router = Router();
  router.use(createRequireAuth(users), requireAdmin);

  router.get("/status", async (_req, res) => {
    try { res.json(await codex.getStatus()); }
    catch (error) { sendError(res, error, "Codex bridge unavailable", 503); }
  });

  router.post("/upload", async (req, res) => {
    try {
      const payload = codexUploadRequestSchema.parse(req.body);
      // Same ceiling the sidecar enforces on the decoded bytes and the composer
      // advertises — a clear 413 here instead of proxying a 20 MB+ body just to
      // be refused (the body-parser mount for these routes lives in createApp).
      if (base64DecodedBytes(payload.data) > PANEL_UPLOAD_MAX_BYTES) {
        res.status(413).json({ error: `Upload exceeds ${PANEL_UPLOAD_MAX_BYTES / (1024 * 1024)} MB` });
        return;
      }
      const response = await codex.upload(payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "codex-upload", targetId: response.path }),
        action: "codex.uploaded",
        metadata: { name: response.name, path: response.path },
      });
      res.json(response);
    } catch (error) { sendError(res, error, "Upload failed"); }
  });

  router.get("/sessions", async (_req, res) => {
    try { res.json(await codex.listSessions()); }
    catch (error) { sendError(res, error, "Unable to list Codex sessions", 503); }
  });

  router.post("/sessions", async (req, res) => {
    try {
      const payload = codexSendRequestSchema.parse(req.body);
      const response = await codex.send(payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "codex-session", targetId: response.sessionId }),
        action: "codex.turn_started",
        metadata: {
          sessionId: response.sessionId,
          resumed: Boolean(payload.sessionId),
          workspaceId: payload.workspaceId ?? null,
          mode: payload.mode,
          model: payload.model ?? null,
          effort: payload.effort ?? null,
          promptLength: payload.prompt?.length ?? 0,
          hasFiles: Boolean(payload.files?.length),
        },
      });
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to start Codex turn", 502); }
  });

  router.get("/sessions/:sessionId", async (req, res) => {
    try { res.json(await codex.getSession(req.params.sessionId)); }
    catch (error) { sendError(res, error, "Unable to load Codex session", missingSession(error) ? 404 : 400); }
  });

  router.patch("/sessions/:sessionId", async (req, res) => {
    try {
      const payload = codexPatchRequestSchema.parse(req.body);
      const response = await codex.patchSession(req.params.sessionId, payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "codex-session", targetId: req.params.sessionId }),
        action: "codex.session_updated",
        metadata: payload,
      });
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to update Codex session"); }
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
    } catch (error) { sendError(res, error, "Unable to delete Codex session"); }
  });

  router.get("/sessions/:sessionId/stream", async (req, res) => {
    const after = Number.parseInt(String(req.query.after ?? "-1"), 10);
    try { await codex.stream(req.params.sessionId, Number.isFinite(after) ? after : -1, res); }
    catch (error) {
      // A session the sidecar no longer has is a 404 to the client so its
      // stop condition fires (web: [401, 403, 404]); every other failure
      // stays the 502 that means "retry".
      if (!res.headersSent) sendError(res, error, "Unable to stream Codex session", missingSession(error) ? 404 : 502);
      else try { res.end(); } catch {}
    }
  });

  router.get("/sessions/:sessionId/export", async (req, res) => {
    try { await codex.exportSession(req.params.sessionId, res); }
    catch (error) {
      if (!res.headersSent) sendError(res, error, "Unable to export Codex session");
      else try { res.end(); } catch {}
    }
  });

  router.post("/sessions/:sessionId/steer", async (req, res) => {
    try {
      const payload = codexSteerRequestSchema.parse(req.body);
      const response = await codex.steer(req.params.sessionId, payload);
      auditAction(audit, req, res, req.params.sessionId, "codex.turn_steered", { promptLength: payload.prompt?.length ?? 0 });
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to steer Codex turn"); }
  });

  router.post("/sessions/:sessionId/settings", async (req, res) => {
    try {
      const payload = codexSettingsRequestSchema.parse(req.body);
      const response = await codex.updateSettings(req.params.sessionId, payload);
      auditAction(audit, req, res, req.params.sessionId, "codex.settings_updated", payload);
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to update Codex settings"); }
  });

  router.post("/sessions/:sessionId/interrupt", async (req, res) => {
    try {
      const response = await codex.interrupt(req.params.sessionId);
      auditAction(audit, req, res, req.params.sessionId, "codex.interrupted", { sessionId: req.params.sessionId });
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to interrupt Codex session"); }
  });

  router.post("/sessions/:sessionId/compact", async (req, res) => {
    try {
      const response = await codex.compact(req.params.sessionId);
      auditAction(audit, req, res, req.params.sessionId, "codex.compaction_started", {});
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to compact Codex session"); }
  });

  router.post("/sessions/:sessionId/fork", async (req, res) => {
    try {
      const payload = codexForkRequestSchema.parse(req.body);
      const response = await codex.fork(req.params.sessionId, payload);
      auditAction(audit, req, res, response.sessionId, "codex.forked", { sourceSessionId: req.params.sessionId });
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to fork Codex session"); }
  });

  router.post("/sessions/:sessionId/review", async (req, res) => {
    try {
      const payload = codexReviewRequestSchema.parse(req.body);
      const response = await codex.review(req.params.sessionId, payload);
      auditAction(audit, req, res, req.params.sessionId, "codex.review_started", { target: payload.target ?? { type: "uncommittedChanges" } });
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to start Codex review"); }
  });

  router.post("/sessions/:sessionId/shell", async (req, res) => {
    try {
      const payload = codexShellRequestSchema.parse(req.body);
      const response = await codex.shell(req.params.sessionId, payload);
      auditAction(audit, req, res, req.params.sessionId, "codex.shell_executed", { commandLength: payload.command.length });
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to run Codex shell command"); }
  });

  router.post("/sessions/:sessionId/answer", async (req, res) => {
    try {
      const payload = codexAnswerRequestSchema.parse(req.body);
      const response = await codex.answer(req.params.sessionId, payload);
      // Answering a request_user_input question can steer a YOLO turn — it was
      // the one mutating panel action with no audit trail. Ids and
      // counts only, never the answer content.
      auditAction(audit, req, res, req.params.sessionId, "codex.answered", { requestId: String(payload.requestId), answerCount: Object.keys(payload.answers).length });
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to answer Codex question"); }
  });

  router.post("/sessions/:sessionId/archive", async (req, res) => {
    try {
      const response = await codex.archive(req.params.sessionId);
      auditAction(audit, req, res, req.params.sessionId, "codex.archived", {});
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to archive Codex session"); }
  });

  router.post("/sessions/:sessionId/unarchive", async (req, res) => {
    try {
      const response = await codex.unarchive(req.params.sessionId);
      auditAction(audit, req, res, req.params.sessionId, "codex.unarchived", {});
      res.json(response);
    } catch (error) { sendError(res, error, "Unable to unarchive Codex session"); }
  });

  router.get("/fs/search", async (req, res) => {
    try { res.json(await codex.searchFiles(String(req.query.workspaceId ?? ""), String(req.query.q ?? ""))); }
    catch (error) { sendError(res, error, "Unable to search workspace files"); }
  });

  router.get("/skills", async (req, res) => {
    try { res.json(await codex.listSkills(typeof req.query.sessionId === "string" ? req.query.sessionId : undefined)); }
    catch (error) { sendError(res, error, "Unable to list Codex skills"); }
  });

  router.get("/mcp", async (req, res) => {
    try { res.json(await codex.listMcp(typeof req.query.sessionId === "string" ? req.query.sessionId : undefined)); }
    catch (error) { sendError(res, error, "Unable to list MCP servers"); }
  });

  router.get("/doctor", async (req, res) => {
    try { res.json(await codex.doctor(typeof req.query.sessionId === "string" ? req.query.sessionId : undefined)); }
    catch (error) { sendError(res, error, "Unable to run Codex diagnostics"); }
  });

  return router;
}

function auditAction(audit: AuditService, req: Parameters<typeof getAuditContext>[0], res: Parameters<typeof getAuditContext>[1], targetId: string, action: string, metadata: Record<string, unknown>) {
  audit.record({ ...getAuditContext(req, res, { targetType: "codex-session", targetId }), action, metadata });
}

function sendError(res: Response, error: unknown, fallback: string, status = 400) {
  res.status(status).json({ error: error instanceof Error ? error.message : fallback });
}

// Only "the session does not exist" passes through as 404 (stream and detail):
// the sidecar's other 404s ("Session is not running", "Question is no longer
// pending") are state conflicts and keep the 400 that carries their message.
// 401/403 from the sidecar mean the API's own bearer/IP configuration is wrong
// and must never reach the browser as an auth loss.
function missingSession(error: unknown) {
  return codexUpstreamStatus(error) === 404 && error instanceof Error && /session not found/i.test(error.message);
}
