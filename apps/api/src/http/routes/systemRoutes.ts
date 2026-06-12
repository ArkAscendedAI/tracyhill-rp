import { Router } from "express";

import { healthController } from "../controllers/systemController";

export function createSystemRoutes() {
  const router = Router();
  router.get("/health", healthController);
  return router;
}
