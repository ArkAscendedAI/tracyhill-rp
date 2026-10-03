import { Router } from "express";

import type { ImageService } from "../../domain/images/imageService";
import { createImageController } from "../controllers/imageController";
import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createImageRoutes(images: ImageService, users: UserRepository) {
  const router = Router();
  const controller = createImageController(images);
  router.use(createRequireAuth(users));
  router.post("/sessions/:sessionId/generate", controller.generate);
  router.get("/:imageId", controller.getImage);
  return router;
}
