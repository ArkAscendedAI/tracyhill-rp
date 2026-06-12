import { Router } from "express";

import { contextPreviewRequestSchema, embeddingRebuildRequestSchema } from "@tracyhill-rp/contracts";

import type { ContextEngine } from "../../domain/context/contextEngine";
import type { EmbeddingService } from "../../domain/context/embeddingService";
import type { LorebookRepository } from "../../domain/context/lorebookRepository";
import type { UserRepository } from "../../domain/users/userRepository";
import type { SessionRepository } from "../../domain/workspace/sessionRepository";
import type { CampaignRepository } from "../../domain/campaigns/campaignRepository";
import type { MessageRepository } from "../../domain/chat/messageRepository";
import { createRequireAuth } from "../middleware/requireAuth";

export function createContextRoutes(deps: {
  contextEngine: ContextEngine;
  embeddingService: EmbeddingService;
  lorebook: LorebookRepository;
  users: UserRepository;
  sessions: SessionRepository;
  campaigns: CampaignRepository;
  messages: MessageRepository;
}) {
  const router = Router();
  router.use(createRequireAuth(deps.users));

  // Per-turn context preview (dry run)
  router.post("/sessions/:sessionId/preview", async (req, res, next) => {
    try {
      const parsed = contextPreviewRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "invalid preview request" }); return; }
      const userId = req.session.userId!;
      const session = deps.sessions.findActiveById(userId, String(req.params.sessionId));
      if (!session?.campaignId) { res.status(404).json({ error: "session not found or not a campaign session" }); return; }
      const campaign = deps.campaigns.findById(userId, session.campaignId);
      if (!campaign) { res.status(404).json({ error: "campaign not found" }); return; }
      const history = deps.messages.listForSession(userId, session.id)
        .filter(m => m.role !== "cold-start")
        .map(m => ({ role: m.role, content: m.content }));
      const result = await deps.contextEngine.assembleForTurn({
        userId,
        session: { id: session.id, contextOverridesJson: (session as any).contextOverridesJson },
        campaign: { id: campaign.id, contextDefaultsJson: (campaign as any).contextDefaultsJson },
        history,
        userTurnText: parsed.data.prompt,
        dryRun: true,
      });
      res.json({
        entries: result.preview,
        totalTokens: result.debug.totalTokens,
        budgetTokens: deps.contextEngine.resolveSettings(session as any, campaign as any).retrievalBudgetTokens,
        debug: result.debug,
        // Degradation notes — the inspection surface could not show the very
        // signal it exists to inspect.
        notes: result.notes,
      });
    } catch (error) { next(error); }
  });

  // Embedding rebuild
  router.post("/embeddings/rebuild", async (req, res, next) => {
    try {
      const parsed = embeddingRebuildRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "invalid rebuild request" }); return; }
      const userId = req.session.userId!;
      const entries = deps.lorebook.listEnabledForCampaign(userId, parsed.data.campaignId);
      const toIndex = entries.map(e => ({ id: e.id, userId: e.userId, content: e.content }));
      const indexed = await deps.embeddingService.indexEntries(toIndex, parsed.data.model);
      res.json({ indexed, total: entries.length });
    } catch (error) { next(error); }
  });

  // Embedding status
  router.get("/embeddings/status", (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignIdRaw = req.query.campaignId;
      if (typeof campaignIdRaw !== "string" || !campaignIdRaw) { res.status(400).json({ error: "campaignId required" }); return; }
      const campaignId = campaignIdRaw;
      const model = String(req.query.model || "openai:text-embedding-3-large");
      const status = deps.embeddingService.getStatus(userId, campaignId, model);
      res.json({ ...status, model });
    } catch (error) { next(error); }
  });

  return router;
}
