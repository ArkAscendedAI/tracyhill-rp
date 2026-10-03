import { Router } from "express";

import type { WorkspaceService } from "../../domain/workspace/workspaceService";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";
import { createWorkspaceController } from "../controllers/workspaceController";

export function createWorkspaceRoutes(workspace: WorkspaceService, users: UserRepository) {
  const router = Router();
  const controller = createWorkspaceController(workspace);
  router.use(createRequireAuth(users));
  router.get("/", controller.getState);
  router.get("/search", controller.search);
  router.post("/folders", controller.createFolder);
  router.patch("/folders/:folderId", controller.updateFolder);
  router.delete("/folders/:folderId", controller.deleteFolder);
  router.delete("/recycle-bin", controller.emptyRecycleBin);
  router.post("/sessions", controller.createSession);
  router.post("/sessions/from-campaign/:campaignId", controller.startSessionFromCampaign);
  router.patch("/sessions/:sessionId", controller.updateSession);
  router.delete("/sessions/:sessionId", controller.deleteSession);
  router.post("/sessions/:sessionId/restore", controller.restoreSession);
  router.delete("/sessions/:sessionId/permanent", controller.permanentlyDeleteSession);
  router.patch("/preferences", controller.updatePreferences);
  return router;
}
