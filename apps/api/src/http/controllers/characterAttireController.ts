import type { RequestHandler } from "express";

import { updateCharacterAttireRequestSchema } from "@tracyhill-rp/contracts";

import type { CampaignRepository } from "../../domain/campaigns/campaignRepository";
import type { CharacterAttireRepository } from "../../domain/chat/characterAttireRepository";
import { HttpError } from "../../lib/httpError";
import { describeIssues } from "../describeIssues";

/**
 * Resolves the campaign's CURRENT turn estimate (the newest live session's max
 * active sort_order + 1 — the same number chatService's staleness check
 * computes) for manual edits. Optional: without it the controller falls back
 * to the character's last-seen turn (see `update`).
 */
export type CurrentTurnResolver = (userId: string, campaignId: string) => number | null;

// Optional caller-supplied turn (the web composer knows the loaded
// conversation's tail). Local extension until the contract carries it.

export function createCharacterAttireController(
  attire: CharacterAttireRepository,
  campaigns: CampaignRepository,
  resolveCurrentTurn?: CurrentTurnResolver | null,
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
      // The field and the reason follow the old prefix: a 2,001-character
      // description used to read only "invalid attire update".
      if (!parsed.success) { res.status(400).json({ error: `invalid attire update: ${describeIssues(parsed.error)}` }); return; }
      const existing = attire.findByCharacter(campaignId, characterName);
      // A manual edit is stamped at the CURRENT turn. It used to keep the OLD
      // lastUpdatedTurn (or 0 for a new character), so an owner correction at
      // turn 500 of an attire last changed at turn 100 was injected as
      // "[stale — consider plausible changes …]" the very next turn.
      // Precedence: caller-supplied turn → server-resolved current turn →
      // the character's last-seen turn (fresh if the character is in scene).
      const turn = parsed.data.turn
        ?? resolveCurrentTurn?.(userId, campaignId)
        ?? (existing ? Math.max(existing.lastSeenInPresentTurn, existing.lastUpdatedTurn) : 0);
      attire.upsert({
        campaignId,
        characterName,
        attireDescription: parsed.data.attireDescription,
        turn,
        messageId: null,
        source: "manual",
        previousAttire: existing?.attireDescription ?? null,
        reason: parsed.data.reason ?? "manual edit",
        recordHistory: true,
      });
      res.json(attire.findByCharacter(campaignId, characterName));
    } catch (error) { next(error); }
  };

  return { list, get, update };
}
