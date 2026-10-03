import { DEFAULT_EMBEDDING_MODEL, getChatModel } from "@tracyhill-rp/model-catalog";
import { Router } from "express";

import { contextPreviewRequestSchema, contextPreviewResponseSchema, embeddingRebuildRequestSchema, lorebookEmbeddingStatusSchema, promptFragmentsResponseSchema } from "@tracyhill-rp/contracts";
import { listPromptFragments } from "../../domain/chat/promptFragments";
import { normalizePresentNames } from "../../domain/chat/sceneParser";

import type { ContextEngine } from "../../domain/context/contextEngine";
import type { EmbeddingService } from "../../domain/context/embeddingService";
import type { LorebookRepository } from "../../domain/context/lorebookRepository";
import type { UserRepository } from "../../domain/users/userRepository";
import type { SessionRepository } from "../../domain/workspace/sessionRepository";
import type { CampaignRepository } from "../../domain/campaigns/campaignRepository";
import type { MessageRepository } from "../../domain/chat/messageRepository";
import { describeIssues } from "../describeIssues";
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
      // Both refusals here name the field and the reason after the old prefix.
      if (!parsed.success) { res.status(400).json({ error: `invalid preview request: ${describeIssues(parsed.error)}` }); return; }
      const userId = req.session.userId!;
      const session = deps.sessions.findActiveById(userId, String(req.params.sessionId));
      if (!session?.campaignId) { res.status(404).json({ error: "session not found or not a campaign session" }); return; }
      const campaign = deps.campaigns.findById(userId, session.campaignId);
      if (!campaign) { res.status(404).json({ error: "campaign not found" }); return; }
      const history = deps.messages.listForSession(userId, session.id)
        .filter(m => m.role !== "cold-start")
        .map(m => ({ role: m.role, content: m.content }));
      // Live-turn parity: the same two lists chatService
      // passes. The aware list drives the scene-present guarantee, the budget
      // subtraction for guaranteed entries and knownBy routing; the
      // present-unaware list adds its cores to the guarantee (never as knowers).
      // Both go through normalizePresentNames as on the live turn (the raw list
      // missed "O’Brien" against a core named "O'Brien"); the unaware list drops
      // anyone also aware. Only these two lists are read: never NOT PRESENT or
      // the campaign roster.
      const nameList = (raw: string | null | undefined): string[] => {
        try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
      };
      const presentCharacters = normalizePresentNames(nameList(session.scenePresent));
      const presentUnawareCharacters = normalizePresentNames(nameList(session.scenePresentUnaware))
        .filter((name) => !presentCharacters.includes(name));
      const result = await deps.contextEngine.assembleForTurn({
        userId,
        session: { id: session.id, contextOverridesJson: session.contextOverridesJson },
        campaign: { id: campaign.id },
        history,
        userTurnText: parsed.data.prompt,
        // Defaults true (preview never mutates). A caller can pass dryRun:false to
        // assemble-and-commit, but the preview surface keeps the safe default. A
        // dry run records no tracker-freshness event (the engine's rule).
        dryRun: parsed.data.dryRun,
        presentCharacters,
        presentUnawareCharacters,
        // `network: false` skips HyDE, the query embedding and the researcher, so
        // a measurement costs no paid call. Absent means true.
        network: parsed.data.network ?? true,
      });
      // Validated against the shared contract so the hand-built shape cannot
      // drift from what a client parses (the response schema was never used).
      res.json(contextPreviewResponseSchema.parse({
        entries: result.preview,
        totalTokens: result.debug.totalTokens,
        budgetTokens: deps.contextEngine.resolveSettings(session).retrievalBudgetTokens,
        debug: result.debug,
        // Degradation notes — the inspection surface could not show the very
        // signal it exists to inspect.
        notes: result.notes,
      }));
    } catch (error) { next(error); }
  });

  // What the engine injects for this session, in wire order (the Engine dialog's
  // "Injected text" viewer, 2026-09-24). Read-only; built by the live turn's own
  // builders so it cannot drift from the wire.
  router.get("/sessions/:sessionId/prompt-fragments", (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const session = deps.sessions.findActiveById(userId, String(req.params.sessionId));
      if (!session?.campaignId) { res.status(404).json({ error: "session not found or not a campaign session" }); return; }
      const campaign = deps.campaigns.findById(userId, session.campaignId);
      if (!campaign) { res.status(404).json({ error: "campaign not found" }); return; }
      const modelId = typeof req.query.modelId === "string" && req.query.modelId ? req.query.modelId : null;
      const model = modelId ? { id: modelId, provider: getChatModel(modelId)?.provider ?? "custom" } : null;
      res.json(promptFragmentsResponseSchema.parse({
        fragments: listPromptFragments({
          settings: deps.contextEngine.resolveSettings(session),
          model,
          campaignPrompt: campaign.systemPrompt ?? null,
          antiRepetitionJson: (campaign as { antiRepetitionJson?: string | null }).antiRepetitionJson ?? null,
        }),
      }));
    } catch (error) { next(error); }
  });

  // Embedding rebuild
  router.post("/embeddings/rebuild", async (req, res, next) => {
    try {
      const parsed = embeddingRebuildRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: `invalid rebuild request: ${describeIssues(parsed.error)}` }); return; }
      const userId = req.session.userId!;
      const entries = deps.lorebook.listEnabledForCampaign(userId, parsed.data.campaignId);
      const toIndex = entries.map(e => ({ id: e.id, userId: e.userId, content: e.content }));
      // staleOnly: Android has sent this flag since it shipped; it was
      // accepted and ignored — every "rebuild stale" was a full paid rebuild.
      const indexed = await deps.embeddingService.indexEntries(toIndex, parsed.data.model, { staleOnly: parsed.data.staleOnly });
      res.json({ indexed, total: entries.length });
    } catch (error) { next(error); }
  });

  // Embedding status. The repository counts `total`; the contract and both
  // clients (web LorebookPanel, Android LorebookEmbeddingStatus) read
  // `totalEntries`, which this route never sent, so the web's "N/M embedded"
  // footer never rendered and Android's embedding bar (hidden at a total of 0,
  // Gson's default) never showed.
  // Parsed through the contract so the shape cannot drift from the clients again.
  router.get("/embeddings/status", (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignIdRaw = req.query.campaignId;
      if (typeof campaignIdRaw !== "string" || !campaignIdRaw) { res.status(400).json({ error: "campaignId required" }); return; }
      const campaignId = campaignIdRaw;
      const model = String(req.query.model || DEFAULT_EMBEDDING_MODEL);
      const { total, indexed, stale, missing } = deps.embeddingService.getStatus(userId, campaignId, model);
      res.json(lorebookEmbeddingStatusSchema.parse({ totalEntries: total, indexed, stale, missing, model }));
    } catch (error) { next(error); }
  });

  return router;
}
