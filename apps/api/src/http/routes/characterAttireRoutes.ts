import { Router } from "express";

import type { CampaignRepository } from "../../domain/campaigns/campaignRepository";
import type { CharacterAttireRepository } from "../../domain/chat/characterAttireRepository";
import type { UserRepository } from "../../domain/users/userRepository";
import { createCharacterAttireController, type CurrentTurnResolver } from "../controllers/characterAttireController";
import { createRequireAuth } from "../middleware/requireAuth";

export function createCharacterAttireRoutes(
  attire: CharacterAttireRepository,
  campaigns: CampaignRepository,
  users: UserRepository,
  // Current-turn resolver for manual edits; optional so the app can
  // wire it without a signature break.
  resolveCurrentTurn?: CurrentTurnResolver | null,
) {
  const router = Router();
  const controller = createCharacterAttireController(attire, campaigns, resolveCurrentTurn);
  router.use(createRequireAuth(users));
  router.get("/campaigns/:campaignId/attire", controller.list);
  router.get("/campaigns/:campaignId/attire/:characterName", controller.get);
  router.patch("/campaigns/:campaignId/attire/:characterName", controller.update);
  return router;
}
