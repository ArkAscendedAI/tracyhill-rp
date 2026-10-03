import { Router } from "express";

import type { PromptTemplateService } from "../../domain/promptTemplates/promptTemplateService";
import { createPromptTemplateController } from "../controllers/promptTemplateController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createPromptTemplateRoutes(templates: PromptTemplateService, users: UserRepository) {
  const router = Router();
  const controller = createPromptTemplateController(templates);
  router.use(createRequireAuth(users));
  router.get("/", controller.list);
  router.post("/", controller.create);
  router.put("/:templateId", controller.update);
  router.delete("/:templateId", controller.remove);
  return router;
}
