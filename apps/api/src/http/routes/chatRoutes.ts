import { Router } from "express";

import type { ChatService } from "../../domain/chat/chatService";
import type { MessageContextSnapshotRepository } from "../../domain/chat/messageContextSnapshotRepository";
import { createChatController } from "../controllers/chatController";
import type { UserRepository } from "../../domain/users/userRepository";
import type { SessionRepository } from "../../domain/workspace/sessionRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createChatRoutes(chat: ChatService, users: UserRepository, deps: { contextSnapshots: MessageContextSnapshotRepository; sessions: SessionRepository }) {
  const router = Router();
  const controller = createChatController(chat, deps);
  router.use(createRequireAuth(users));
  router.get("/sessions/:sessionId", controller.getSessionDetail);
  // Scene/date outline: compact location/date/time index over every
  // active scene-bearing message — drives the Scenes popover's jump list.
  router.get("/sessions/:sessionId/scene-outline", controller.getSceneOutline);
  router.get("/sessions/:sessionId/export", controller.exportSession);
  router.put("/sessions/:sessionId/messages/:messageId", controller.updateMessage);
  router.delete("/sessions/:sessionId/messages/:messageId", controller.deleteMessage);
  router.post("/sessions/:sessionId/messages/truncate", controller.truncateMessages);
  router.post("/sessions/:sessionId/stream/stop", controller.stopSessionResponse);
  router.post("/sessions/:sessionId/messages/:messageId/scene-resolve", controller.resolveSceneValidation);
  router.patch("/sessions/:sessionId/messages/:messageId/scene-edit", controller.editSceneMetadata);
  // Per-reply context snapshot: what the engine
  // assembled for that reply's turn, kept for the newest 50 replies per session.
  router.get("/sessions/:sessionId/messages/:messageId/context", controller.getMessageContextSnapshot);
  router.post("/sessions/:sessionId/stream", controller.streamSessionResponse);
  // Message branching / swipes (0065): regenerate streams a NEW sibling variant
  // instead of destroying the prior reply; continue appends in place after a
  // max_tokens truncation; edit-regenerate is the atomic edit-user-turn-and-rerun;
  // variants/switch flips the active sibling (non-streaming).
  router.post("/sessions/:sessionId/messages/:messageId/regenerate", controller.regenerateMessage);
  router.post("/sessions/:sessionId/messages/:messageId/continue", controller.continueMessage);
  router.post("/sessions/:sessionId/messages/:messageId/edit-regenerate", controller.editAndRegenerate);
  router.post("/sessions/:sessionId/variants/switch", controller.switchVariant);
  return router;
}
