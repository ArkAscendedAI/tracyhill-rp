import { Router } from "express";

import type { UserRepository } from "../../domain/users/userRepository";
import { createModelCatalogController } from "../controllers/modelCatalogController";
import { createRequireAuth } from "../middleware/requireAuth";

export function createModelCatalogRoutes(users: UserRepository) {
  const router = Router();
  const controller = createModelCatalogController();
  router.use(createRequireAuth(users));
  router.get("/", controller.get);
  return router;
}
