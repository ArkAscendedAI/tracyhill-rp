import { Router, type RequestHandler } from "express";

import type { CodingPanelsResponse } from "@tracyhill-rp/contracts";

import type { UserRepository } from "../../domain/users/userRepository";
import { createRequireAuth } from "../middleware/requireAuth";

type Panel = { isConfigured(): boolean };

// Admin only, like the panels themselves: which coding panels are set up, so the web can grey out the rest.
export function createCodingPanelRoutes(panels: { claudeCode: Panel; codex: Panel; kimi: Panel }, requireAdmin: RequestHandler, users: UserRepository) {
  const router = Router();
  router.use(createRequireAuth(users), requireAdmin);
  router.get("/", (_req, res) => {
    const body: CodingPanelsResponse = {
      claudeCode: { configured: panels.claudeCode.isConfigured() },
      codex: { configured: panels.codex.isConfigured() },
      kimi: { configured: panels.kimi.isConfigured() },
    };
    res.json(body);
  });
  return router;
}
