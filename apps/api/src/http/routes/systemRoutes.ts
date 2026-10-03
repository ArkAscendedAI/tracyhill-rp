import { Router } from "express";

import { createHealthController } from "../controllers/systemController";

import type { HealthOptions } from "../controllers/systemController";

export function createSystemRoutes(health?: HealthOptions) {
  const router = Router();
  router.get("/health", createHealthController(health));
  return router;
}
