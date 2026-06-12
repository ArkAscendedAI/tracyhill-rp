import type { RequestHandler, Response } from "express";

import { chatSendRequestSchema, editSceneMetadataRequestSchema, resolveSceneValidationRequestSchema, stopChatStreamRequestSchema, truncateChatMessagesRequestSchema, updateChatMessageRequestSchema } from "@tracyhill-rp/contracts";

import type { ChatService } from "../../domain/chat/chatService";
import { firstHeaderValue } from "../../lib/headerUtil";

function writeSse(res: Response, event: string, payload: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function createChatController(chat: ChatService) {
  const getSessionDetail: RequestHandler = (req, res, next) => {
    try {
      res.json(chat.getSessionDetail(req.session.userId!, String(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  };

  const exportSession: RequestHandler = (req, res, next) => {
    try {
      res.json(chat.exportSession(req.session.userId!, String(req.params.sessionId)));
    } catch (error) {
      next(error);
    }
  };

  const updateMessage: RequestHandler = (req, res, next) => {
    const parsed = updateChatMessageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid message update" });
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
      res.status(400).json({ error: "invalid message truncate request" });
      return;
    }
    try {
      res.json(chat.truncateAfterMessage(req.session.userId!, String(req.params.sessionId), parsed.data.messageId));
    } catch (error) {
      next(error);
    }
  };

  const streamSessionResponse: RequestHandler = async (req, res, next) => {
    const parsed = chatSendRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? issue.path.join(".") : "request";
      const message = issue?.message ?? "validation failed";
      res.status(400).json({ error: `invalid chat request: ${path} — ${message}` });
      return;
    }
    try {
      let responseFinished = false;
      let clientConnected = true;
      res.on("finish", () => {
        responseFinished = true;
      });
      res.on("close", () => {
        if (!responseFinished) clientConnected = false;
      });
      res.status(200);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      // Disable proxy buffering so heartbeats and tokens flush immediately
      // through NPM/nginx — otherwise the proxy holds the response and its
      // 60s read-timeout fires during a long silent model ingestion.
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();
      // Browser-facing heartbeat. Adaptive models (e.g. Opus 4.8) on the
      // ClaudeCode bridge ingest large prompts SILENTLY for minutes before the
      // first token. Without a heartbeat the proxy/browser connection times out
      // (user sees "network error") even though the backend is still working.
      // An SSE comment every 10s keeps the browser↔RP hop alive; it is ignored
      // by the EventSource parser. Mirrors the agent-service keepalive that
      // holds the bridge↔agent hop and the bridge's :ping that holds RP↔bridge.
      const heartbeat = setInterval(() => {
        if (clientConnected && !res.writableEnded) {
          try { res.write(": hb\n\n"); } catch { /* client gone; finally clears */ }
        }
      }, 10000);
      try {
        await chat.streamResponse(req.session.userId!, String(req.params.sessionId), parsed.data, firstHeaderValue(req.headers["x-request-id"]) ?? crypto.randomUUID(), (event) => {
          if (!clientConnected || res.writableEnded) return;
          writeSse(res, event.type, event);
        }, {
          isClientConnected: () => clientConnected && !res.writableEnded,
        });
        if (clientConnected && !res.writableEnded) res.end();
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      if (res.headersSent && !res.writableEnded) {
        writeSse(res, "response.error", {
          type: "response.error",
          error: error instanceof Error ? error.message : "chat request failed",
        });
        res.end();
        return;
      }
      next(error);
    }
  };

  const resolveSceneValidation: RequestHandler = async (req, res, next) => {
    const parsed = resolveSceneValidationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid scene resolution request" });
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
      res.status(400).json({ error: "invalid scene metadata edit" });
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

  const stopSessionResponse: RequestHandler = (req, res, next) => {
    const parsed = stopChatStreamRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid chat stop request" });
      return;
    }
    try {
      res.json({ stopped: chat.stopResponse(req.session.userId!, String(req.params.sessionId), parsed.data.requestId) });
    } catch (error) {
      next(error);
    }
  };

  return { getSessionDetail, exportSession, updateMessage, deleteMessage, truncateMessages, streamSessionResponse, stopSessionResponse, resolveSceneValidation, editSceneMetadata };
}
