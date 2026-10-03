import { Router } from "express";

import type { LorebookService } from "../../domain/context/lorebookService";
import { createLorebookController } from "../controllers/lorebookController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createLorebookRoutes(lorebook: LorebookService, users: UserRepository) {
  const router = Router();
  const controller = createLorebookController(lorebook);
  router.use(createRequireAuth(users));
  router.get("/campaigns/:campaignId/entries", controller.list);
  router.get("/campaigns/:campaignId/tags", controller.tags);
  router.post("/campaigns/:campaignId/entries", controller.create);
  router.post("/campaigns/:campaignId/import", controller.importLorebook);
  router.post("/campaigns/:campaignId/character-card", controller.importCharacterCard);
  router.get("/campaigns/:campaignId/export", controller.exportLorebook);
  router.post("/campaigns/:campaignId/bulk", controller.bulkAction);
  router.get("/campaigns/:campaignId/deleted", controller.deleted);
  router.get("/entries/:entryId", controller.get);
  router.patch("/entries/:entryId", controller.update);
  router.delete("/entries/:entryId", controller.remove);
  router.get("/entries/:entryId/revisions", controller.revisions);
  router.post("/entries/:entryId/revert", controller.revert);
  return router;
}
