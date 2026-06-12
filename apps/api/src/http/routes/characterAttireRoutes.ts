import { Router } from "express";

import type { CampaignRepository } from "../../domain/campaigns/campaignRepository";
import type { CharacterAttireRepository } from "../../domain/chat/characterAttireRepository";
import type { UserRepository } from "../../domain/users/userRepository";
import { createCharacterAttireController } from "../controllers/characterAttireController";
import { createRequireAuth } from "../middleware/requireAuth";

export function createCharacterAttireRoutes(
  attire: CharacterAttireRepository,
  campaigns: CampaignRepository,
  users: UserRepository,
) {
  const router = Router();
  const controller = createCharacterAttireController(attire, campaigns);
  router.use(createRequireAuth(users));
  router.get("/campaigns/:campaignId/attire", controller.list);
  router.get("/campaigns/:campaignId/attire/:characterName", controller.get);
  router.patch("/campaigns/:campaignId/attire/:characterName", controller.update);
  router.get("/campaigns/:campaignId/attire/:characterName/history", controller.history);
  return router;
}
