import type { RequestHandler, Response } from "express";

import { chatSendRequestSchema, continueChatMessageRequestSchema, editAndRegenerateRequestSchema, editSceneMetadataRequestSchema, messageContextSnapshotResponseSchema, regenerateChatMessageRequestSchema, resolveSceneValidationRequestSchema, sessionDetailQuerySchema, sessionExportQuerySchema, stopChatStreamRequestSchema, switchVariantRequestSchema, truncateChatMessagesRequestSchema, updateChatMessageRequestSchema } from "@tracyhill-rp/contracts";
import type { ChatStreamEvent } from "@tracyhill-rp/contracts";

import type { ChatService } from "../../domain/chat/chatService";
import type { MessageContextSnapshotRepository } from "../../domain/chat/messageContextSnapshotRepository";
import type { SessionRepository } from "../../domain/workspace/sessionRepository";
import { firstHeaderValue } from "../../lib/headerUtil";
import { HttpError } from "../../lib/httpError";
import { describeIssues } from "../describeIssues";

function writeSse(res: Response, event: string, payload: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Shared SSE scaffolding for every streaming chat route (send / regenerate /
// continue / edit-regenerate): sets the event-stream headers, disables proxy
// buffering, runs a 10s browser-facing heartbeat (keeps NPM's 60s read-timeout
// from firing during a long silent model ingestion), and bridges emit→SSE with
// client-disconnect detection. `run` receives the live `emit` + `isClientConnected`.
async function runChatSseStream(
  res: Response,
  next: (err?: unknown) => void,
  run: (emit: (event: ChatStreamEvent) => void, isClientConnected: () => boolean) => Promise<void>,
) {
  try {
    let responseFinished = false;
    let clientConnected = true;
    res.on("finish", () => { responseFinished = true; });
    res.on("close", () => { if (!responseFinished) clientConnected = false; });
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    const heartbeat = setInterval(() => {
      if (clientConnected && !res.writableEnded) {
        try { res.write(": hb\n\n"); } catch { /* client gone; finally clears */ }
      }
    }, 10000);
    try {
      await run(
        (event) => { if (!clientConnected || res.writableEnded) return; writeSse(res, event.type, event); },
        () => clientConnected && !res.writableEnded,
      );
      if (clientConnected && !res.writableEnded) res.end();
    } finally {
      clearInterval(heartbeat);
    }
  } catch (error) {
    if (res.headersSent && !res.writableEnded) {
      // Headers are always flushed before `run`, so a service-side HttpError
      // (404 / 429 / 503 thrown by the synchronous validation at the top of
      // streamResponse & co.) can never reach `next(error)` — it is delivered
      // on the 200 event stream. Surface the status in the payload instead so
      // clients can still branch on it (HTTP semantics unchanged).
      const payload: Extract<ChatStreamEvent, { type: "response.error" }> = {
        type: "response.error",
        error: error instanceof Error ? error.message : "chat request failed",
        ...(error instanceof HttpError ? { status: error.statusCode } : {}),
      };
      writeSse(res, "response.error", payload);
      res.end();
      return;
    }
    next(error);
  }
}

export function createChatController(chat: ChatService, deps: { contextSnapshots: MessageContextSnapshotRepository; sessions: SessionRepository }) {
  const getSessionDetail: RequestHandler = (req, res, next) => {
    // Transcript windowing: ?before=<sortOrder> pages older windows,
    // ?after=<sortOrder> pages forward (scene jump), ?limit= caps the window
    // size. No params = newest window + sessionStats. Setting BOTH cursors fails
    // the schema's mutual-exclusion refine → 400.
    const parsed = sessionDetailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      // Every refusal in this controller names the field and the reason after the old prefix. The mutual-exclusion
      // refine has no field: it is the query.
      res.status(400).json({ error: `invalid session detail query: ${describeIssues(parsed.error, (path) => path.join(".") || "query")}` });
      return;
    }
    try {
      res.json(chat.getSessionDetail(req.session.userId!, String(req.params.sessionId), parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const getSceneOutline: RequestHandler = (req, res, next) => {
    try {
      res.json(chat.getSceneOutline(req.session.userId!, String(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  };

  const exportSession: RequestHandler = (req, res, next) => {
    try {
      const parsed = sessionExportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid export format: ${describeIssues(parsed.error)}` });
        return;
      }
      const userId = req.session.userId!;
      const sessionId = String(req.params.sessionId);
      if (parsed.data.format === "json") {
        res.json(chat.exportSessionJson(userId, sessionId));
        return;
      }
      res.json(chat.exportSession(userId, sessionId));
    } catch (error) {
      next(error);
    }
  };

  const updateMessage: RequestHandler = (req, res, next) => {
    const parsed = updateChatMessageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid message update: ${describeIssues(parsed.error)}` });
      return;
    }
    try {
      res.json(chat.updateMessage(req.session.userId!, String(req.params.sessionId), String(req.params.messageId), parsed.data.content));
    } catch (error) {
      next(error);
    }
  };

  const deleteMessage: RequestHandler = (req, res, next) => {
    try {
      res.json(chat.deleteMessage(req.session.userId!, String(req.params.sessionId), String(req.params.messageId)));
    } catch (error) {
      next(error);
    }
  };

  const truncateMessages: RequestHandler = (req, res, next) => {
    const parsed = truncateChatMessagesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid message truncate request: ${describeIssues(parsed.error)}` });
      return;
    }
    try {
      res.json(chat.truncateAfterMessage(req.session.userId!, String(req.params.sessionId), parsed.data.messageId, {
        expectNextMessageId: parsed.data.expectNextMessageId,
        expectLastMessageId: parsed.data.expectLastMessageId,
        confirmDeleteCount: parsed.data.confirmDeleteCount,
      }));
    } catch (error) {
      next(error);
    }
  };

  const streamSessionResponse: RequestHandler = async (req, res, next) => {
    const parsed = chatSendRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // Every failing field, as the other chat routes name them (it named only the
      // first issue, as "<path> — <message>").
      res.status(400).json({ error: `invalid chat request: ${describeIssues(parsed.error)}` });
      return;
    }
    const requestId = firstHeaderValue(req.headers["x-request-id"]) ?? crypto.randomUUID();
    await runChatSseStream(res, next, (emit, isClientConnected) =>
      chat.streamResponse(req.session.userId!, String(req.params.sessionId), parsed.data, requestId, emit, { isClientConnected }),
    );
  };

  const regenerateMessage: RequestHandler = async (req, res, next) => {
    const parsed = regenerateChatMessageRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: `invalid regenerate request: ${describeIssues(parsed.error)}` });
      return;
    }
    const requestId = firstHeaderValue(req.headers["x-request-id"]) ?? crypto.randomUUID();
    await runChatSseStream(res, next, (emit, isClientConnected) =>
      chat.regenerateAssistant(req.session.userId!, String(req.params.sessionId), String(req.params.messageId), requestId, emit, { isClientConnected, modelId: parsed.data.modelId, rollOverride: parsed.data.rollOverride }),
    );
  };

  const continueMessage: RequestHandler = async (req, res, next) => {
    const parsed = continueChatMessageRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: `invalid continue request: ${describeIssues(parsed.error)}` });
      return;
    }
    const requestId = firstHeaderValue(req.headers["x-request-id"]) ?? crypto.randomUUID();
    await runChatSseStream(res, next, (emit, isClientConnected) =>
      chat.continueAssistant(req.session.userId!, String(req.params.sessionId), String(req.params.messageId), requestId, emit, { isClientConnected, modelId: parsed.data.modelId }),
    );
  };

  const editAndRegenerate: RequestHandler = async (req, res, next) => {
    const parsed = editAndRegenerateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid edit-regenerate request: ${describeIssues(parsed.error)}` });
      return;
    }
    const requestId = firstHeaderValue(req.headers["x-request-id"]) ?? crypto.randomUUID();
    await runChatSseStream(res, next, (emit, isClientConnected) =>
      chat.editAndRegenerate(req.session.userId!, String(req.params.sessionId), String(req.params.messageId), parsed.data.content, requestId, emit, { isClientConnected, modelId: parsed.data.modelId, rollOverride: parsed.data.rollOverride }),
    );
  };

  const switchVariant: RequestHandler = (req, res, next) => {
    const parsed = switchVariantRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid variant switch request: ${describeIssues(parsed.error)}` });
      return;
    }
    try {
      res.json(chat.switchVariant(req.session.userId!, String(req.params.sessionId), parsed.data.variantMessageId));
    } catch (error) {
      next(error);
    }
  };

  const resolveSceneValidation: RequestHandler = async (req, res, next) => {
    const parsed = resolveSceneValidationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid scene resolution request: ${describeIssues(parsed.error)}` });
      return;
    }
    try {
      const result = await chat.resolveSceneValidation(
        req.session.userId!,
        String(req.params.sessionId),
        String(req.params.messageId),
        { choice: parsed.data.choice, userPresent: parsed.data.userPresent, userPresentUnaware: parsed.data.userPresentUnaware },
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  const editSceneMetadata: RequestHandler = (req, res, next) => {
    const parsed = editSceneMetadataRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid scene metadata edit: ${describeIssues(parsed.error)}` });
      return;
    }
    try {
      res.json(chat.editSceneMetadata(
        req.session.userId!,
        String(req.params.sessionId),
        String(req.params.messageId),
        parsed.data,
      ));
    } catch (error) {
      next(error);
    }
  };

  // The stored context snapshot of one
  // reply. Owner-scoped like every chat route: another user's session, a
  // session in the recycle bin and a reply without a snapshot all answer 404.
  const getMessageContextSnapshot: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const sessionId = String(req.params.sessionId);
      const messageId = String(req.params.messageId);
      if (!deps.sessions.findActiveById(userId, sessionId)) throw new HttpError(404, "session not found");
      const snapshot = deps.contextSnapshots.get(userId, sessionId, messageId);
      if (!snapshot) throw new HttpError(404, "no context snapshot for this message");
      res.json(messageContextSnapshotResponseSchema.parse({ messageId, snapshot }));
    } catch (error) {
      next(error);
    }
  };

  const stopSessionResponse: RequestHandler = (req, res, next) => {
    const parsed = stopChatStreamRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid chat stop request: ${describeIssues(parsed.error)}` });
      return;
    }
    try {
      res.json({ stopped: chat.stopResponse(req.session.userId!, String(req.params.sessionId), parsed.data.requestId) });
    } catch (error) {
      next(error);
    }
  };

  return { getSessionDetail, getSceneOutline, exportSession, updateMessage, deleteMessage, truncateMessages, streamSessionResponse, stopSessionResponse, resolveSceneValidation, editSceneMetadata, regenerateMessage, continueMessage, editAndRegenerate, switchVariant, getMessageContextSnapshot };
}
