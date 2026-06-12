import type { RequestHandler } from "express";

import { updateCharacterAttireRequestSchema } from "@tracyhill-rp/contracts";

import type { CampaignRepository } from "../../domain/campaigns/campaignRepository";
import type { CharacterAttireRepository } from "../../domain/chat/characterAttireRepository";
import { HttpError } from "../../lib/httpError";

export function createCharacterAttireController(
  attire: CharacterAttireRepository,
  campaigns: CampaignRepository,
) {
  function requireCampaign(userId: string, campaignId: string) {
    const campaign = campaigns.findById(userId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  }

  const list: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      requireCampaign(userId, campaignId);
      res.json({ entries: attire.listForCampaign(campaignId) });
    } catch (error) { next(error); }
  };

  const get: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      const characterName = String(req.params.characterName);
      requireCampaign(userId, campaignId);
      const row = attire.findByCharacter(campaignId, characterName);
      if (!row) { res.status(404).json({ error: "no attire recorded for character" }); return; }
      res.json(row);
    } catch (error) { next(error); }
  };

  const update: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      const characterName = String(req.params.characterName);
      requireCampaign(userId, campaignId);
      const parsed = updateCharacterAttireRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "invalid attire update" }); return; }
      const existing = attire.findByCharacter(campaignId, characterName);
      attire.upsert({
        campaignId,
        characterName,
        attireDescription: parsed.data.attireDescription,
        turn: existing?.lastUpdatedTurn ?? 0,
        messageId: existing?.lastUpdatedMessageId ?? null,
        source: "manual",
        previousAttire: existing?.attireDescription ?? null,
        reason: parsed.data.reason ?? "manual edit",
        recordHistory: true,
      });
      res.json(attire.findByCharacter(campaignId, characterName));
    } catch (error) { next(error); }
  };

  const history: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      const characterName = String(req.params.characterName);
      requireCampaign(userId, campaignId);
      res.json({ entries: attire.history(campaignId, characterName) });
    } catch (error) { next(error); }
  };

  return { list, get, update, history };
}
