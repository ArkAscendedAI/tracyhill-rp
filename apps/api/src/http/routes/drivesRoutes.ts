import { Router } from "express";

import type { CampaignRepository } from "../../domain/campaigns/campaignRepository";
import type { CharacterDrivesRepository } from "../../domain/chat/characterDrivesRepository";
import type { UserRepository } from "../../domain/users/userRepository";
import type { CurrentTurnResolver } from "../controllers/characterAttireController";
import { createDrivesController } from "../controllers/drivesController";
import { createRequireAuth } from "../middleware/requireAuth";

export function createDrivesRoutes(
  drives: CharacterDrivesRepository,
  campaigns: CampaignRepository,
  users: UserRepository,
  // Current-turn resolver for manual edits (shared with the attire routes).
  resolveCurrentTurn?: CurrentTurnResolver | null,
) {
  const router = Router();
  const controller = createDrivesController(drives, campaigns, resolveCurrentTurn);
  router.use(createRequireAuth(users));
  router.get("/campaigns/:campaignId", controller.list);
  router.get("/campaigns/:campaignId/:characterName", controller.get);
  router.patch("/campaigns/:campaignId/:characterName", controller.update);
  router.delete("/campaigns/:campaignId/:characterName", controller.remove);
  router.get("/campaigns/:campaignId/:characterName/history", controller.history);
  router.post("/campaigns/:campaignId/:characterName/revert", controller.revert);
  return router;
}
