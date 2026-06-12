import { Router } from "express";
import type { RequestHandler } from "express";

import {
  claudeCodeAnswerRequestSchema,
  claudeCodeForkRequestSchema,
  claudeCodeMemoryWriteRequestSchema,
  claudeCodeModeRequestSchema,
  claudeCodeModelRequestSchema,
  claudeCodePatchRequestSchema,
  claudeCodeRejectPlanRequestSchema,
  claudeCodeRewindRequestSchema,
  claudeCodeSendRequestSchema,
  claudeCodeUploadRequestSchema,
} from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { ClaudeCodeBridge } from "../../domain/claudeCode/claudeCodeBridgeService";
import { getAuditContext } from "../auditContext";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createClaudeCodeRoutes(claudeCode: ClaudeCodeBridge, audit: AuditService, requireAdmin: RequestHandler, users: UserRepository) {
  const router = Router();
  router.use(createRequireAuth(users), requireAdmin);

  router.post("/upload", async (req, res) => {
    try {
      const payload = claudeCodeUploadRequestSchema.parse(req.body);
      const response = await claudeCode.upload(payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-upload", targetId: response.path }),
        action: "claude_code.uploaded",
        metadata: { name: response.name, path: response.path },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Upload failed" });
    }
  });

  router.post("/send", async (req, res) => {
    try {
      const payload = claudeCodeSendRequestSchema.parse(req.body);
      const response = await claudeCode.send(payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: payload.sessionId ?? "new-session" }),
        action: "claude_code.sent",
        metadata: {
          sessionId: payload.sessionId ?? null,
          promptLength: payload.prompt?.length ?? 0,
          fileCount: payload.files?.length ?? 0,
          queryKey: response.queryKey,
        },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Claude Code bridge unavailable" });
    }
  });

  router.get("/sessions", async (_req, res) => {
    try {
      res.json(await claudeCode.listSessions());
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : "Claude Code bridge unavailable" });
    }
  });

  router.get("/sessions/:sessionId/messages", async (req, res) => {
    try {
      res.json(await claudeCode.getMessages(req.params.sessionId));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to load Claude Code session messages" });
    }
  });

  router.get("/sessions/:sessionId/stream", async (req, res) => {
    try {
      const after = Number.parseInt(String(req.query.after ?? "-1"), 10);
      await claudeCode.stream(req.params.sessionId, Number.isNaN(after) ? -1 : after, res);
    } catch (error) {
      if (!res.headersSent) res.status(502).json({ error: error instanceof Error ? error.message : "Claude Code bridge unavailable" });
      else try { res.end(); } catch {}
    }
  });

  router.get("/sessions/:sessionId/status", async (req, res) => {
    try {
      res.json(await claudeCode.getStatus(req.params.sessionId));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to load Claude Code status" });
    }
  });

  router.post("/sessions/:sessionId/interrupt", async (req, res) => {
    try {
      const response = await claudeCode.interrupt(req.params.sessionId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.interrupted",
        metadata: { sessionId: req.params.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to interrupt Claude Code session" });
    }
  });

  router.delete("/sessions/:sessionId", async (req, res) => {
    try {
      const response = await claudeCode.deleteSession(req.params.sessionId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.deleted",
        metadata: { sessionId: req.params.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to delete Claude Code session" });
    }
  });

  router.patch("/sessions/:sessionId", async (req, res) => {
    try {
      const payload = claudeCodePatchRequestSchema.parse(req.body);
      const response = await claudeCode.patchSession(req.params.sessionId, payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.patched",
        metadata: { sessionId: req.params.sessionId, ...payload },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update session" });
    }
  });

  router.get("/sessions/:sessionId/export", async (req, res) => {
    try {
      await claudeCode.exportSession(req.params.sessionId, res);
    } catch (error) {
      if (!res.headersSent) res.status(400).json({ error: error instanceof Error ? error.message : "Export failed" });
      else try { res.end(); } catch {}
    }
  });

  router.get("/fs/tree", async (req, res) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path : undefined;
      res.json(await claudeCode.fsTree(path));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Filesystem unavailable" });
    }
  });

  router.post("/sessions/:sessionId/answer", async (req, res) => {
    try {
      const payload = claudeCodeAnswerRequestSchema.parse(req.body);
      const response = await claudeCode.answer(req.params.sessionId, payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.answered",
        metadata: { sessionId: req.params.sessionId, questionId: payload.questionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Unable to post answer" });
    }
  });

  router.get("/sessions/:sessionId/doctor", async (req, res) => {
    try {
      res.json(await claudeCode.doctor(req.params.sessionId));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Doctor unavailable" });
    }
  });

  router.get("/memory", async (_req, res) => {
    try {
      res.json(await claudeCode.memoryList());
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Memory list failed" });
    }
  });

  router.get("/memory/read", async (req, res) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path : "";
      res.json(await claudeCode.memoryRead(path));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Memory read failed" });
    }
  });

  router.put("/memory/write", async (req, res) => {
    try {
      const payload = claudeCodeMemoryWriteRequestSchema.parse(req.body);
      const response = await claudeCode.memoryWrite(payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-memory", targetId: payload.path }),
        action: "claude_code.memory_wrote",
        metadata: { path: payload.path, size: payload.content.length },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Memory write failed" });
    }
  });

  router.post("/sessions/:sessionId/rewind", async (req, res) => {
    try {
      const payload = claudeCodeRewindRequestSchema.parse(req.body);
      const response = await claudeCode.rewind(req.params.sessionId, payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.rewound",
        metadata: { sessionId: req.params.sessionId, userMessageId: payload.userMessageId, dryRun: !!payload.dryRun },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Rewind failed" });
    }
  });

  router.post("/sessions/:sessionId/execute-plan", async (req, res) => {
    try {
      const response = await claudeCode.executePlan(req.params.sessionId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.plan_executed",
        metadata: { sessionId: req.params.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Execute-plan failed" });
    }
  });

  // ── v2 control surface ──

  router.post("/sessions/:sessionId/mode", async (req, res) => {
    try {
      const payload = claudeCodeModeRequestSchema.parse(req.body);
      const response = await claudeCode.setMode(req.params.sessionId, payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.mode_set",
        metadata: { sessionId: req.params.sessionId, ...payload },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Mode change failed" });
    }
  });

  router.post("/sessions/:sessionId/approve-plan", async (req, res) => {
    try {
      const response = await claudeCode.approvePlan(req.params.sessionId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.plan_approved",
        metadata: { sessionId: req.params.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Approve-plan failed" });
    }
  });

  router.post("/sessions/:sessionId/reject-plan", async (req, res) => {
    try {
      const payload = claudeCodeRejectPlanRequestSchema.parse(req.body ?? {});
      const response = await claudeCode.rejectPlan(req.params.sessionId, payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.plan_rejected",
        metadata: { sessionId: req.params.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Reject-plan failed" });
    }
  });

  router.get("/sessions/:sessionId/context", async (req, res) => {
    try {
      res.json(await claudeCode.context(req.params.sessionId));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : "No context data" });
    }
  });

  router.post("/sessions/:sessionId/compact", async (req, res) => {
    try {
      const response = await claudeCode.compact(req.params.sessionId);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.compacted",
        metadata: { sessionId: req.params.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Compact failed" });
    }
  });

  router.post("/sessions/:sessionId/model", async (req, res) => {
    try {
      const payload = claudeCodeModelRequestSchema.parse(req.body);
      const response = await claudeCode.setModel(req.params.sessionId, payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.model_set",
        metadata: { sessionId: req.params.sessionId, model: payload.model },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Model change failed" });
    }
  });

  router.post("/sessions/:sessionId/fork", async (req, res) => {
    try {
      const payload = claudeCodeForkRequestSchema.parse(req.body ?? {});
      const response = await claudeCode.fork(req.params.sessionId, payload);
      audit.record({
        ...getAuditContext(req, res, { targetType: "claude-code-session", targetId: req.params.sessionId }),
        action: "claude_code.forked",
        metadata: { sessionId: req.params.sessionId, forkId: response.sessionId },
      });
      res.json(response);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Fork failed" });
    }
  });

  router.get("/sessions/:sessionId/tasks", async (req, res) => {
    try {
      res.json(await claudeCode.tasks(req.params.sessionId));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Tasks unavailable" });
    }
  });

  router.get("/sessions/:sessionId/suggestions", async (req, res) => {
    try {
      res.json(await claudeCode.suggestions(req.params.sessionId));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Suggestions unavailable" });
    }
  });

  router.get("/commands", async (_req, res) => {
    try {
      res.json(await claudeCode.commands());
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : "Commands unavailable" });
    }
  });

  router.get("/sessions/:sessionId/commands", async (req, res) => {
    try {
      res.json(await claudeCode.commands(req.params.sessionId));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : "Commands unavailable" });
    }
  });

  return router;
}
