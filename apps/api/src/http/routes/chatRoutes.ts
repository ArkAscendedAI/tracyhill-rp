import { Router } from "express";

import type { ChatService } from "../../domain/chat/chatService";
import { createChatController } from "../controllers/chatController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createChatRoutes(chat: ChatService, users: UserRepository) {
  const router = Router();
  const controller = createChatController(chat);
  router.use(createRequireAuth(users));
  router.get("/sessions/:sessionId", controller.getSessionDetail);
  router.get("/sessions/:sessionId/export", controller.exportSession);
  router.put("/sessions/:sessionId/messages/:messageId", controller.updateMessage);
  router.delete("/sessions/:sessionId/messages/:messageId", controller.deleteMessage);
  router.post("/sessions/:sessionId/messages/truncate", controller.truncateMessages);
  router.post("/sessions/:sessionId/stream/stop", controller.stopSessionResponse);
  router.post("/sessions/:sessionId/messages/:messageId/scene-resolve", controller.resolveSceneValidation);
  router.patch("/sessions/:sessionId/messages/:messageId/scene-edit", controller.editSceneMetadata);
  router.post("/sessions/:sessionId/stream", controller.streamSessionResponse);
  return router;
}
