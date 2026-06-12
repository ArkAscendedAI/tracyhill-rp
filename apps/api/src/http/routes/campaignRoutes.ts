import { Router } from "express";

import type { CampaignService } from "../../domain/campaigns/campaignService";
import { createCampaignController } from "../controllers/campaignController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createCampaignRoutes(campaigns: CampaignService, users: UserRepository) {
  const router = Router();
  const controller = createCampaignController(campaigns);
  router.use(createRequireAuth(users));
  router.get("/", controller.list);
  router.post("/", controller.create);
  router.get("/:campaignId/versions", controller.listVersions);
  router.post("/:campaignId/versions/:version/restore", controller.restoreVersion);
  router.patch("/:campaignId", controller.update);
  router.delete("/:campaignId", controller.remove);
  return router;
}
