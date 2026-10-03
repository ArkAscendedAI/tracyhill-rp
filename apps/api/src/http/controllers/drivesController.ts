import type { RequestHandler } from "express";

import { updateDriveRequestSchema, revertDriveRequestSchema, driveSheetSchema, type DriveHistoryEntry } from "@tracyhill-rp/contracts";

import type { CampaignRepository } from "../../domain/campaigns/campaignRepository";
import type { CharacterDrivesRepository } from "../../domain/chat/characterDrivesRepository";
import { HttpError } from "../../lib/httpError";
import { describeIssues } from "../describeIssues";
import type { CurrentTurnResolver } from "./characterAttireController";

const NO_SHEET = { error: "no drive sheet for character" } as const;

export function createDrivesController(
  drives: CharacterDrivesRepository,
  campaigns: CampaignRepository,
  resolveCurrentTurn?: CurrentTurnResolver | null,
) {
  function requireCampaign(userId: string, campaignId: string) {
    const campaign = campaigns.findById(userId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  }

  // Hidden-until-fire applies to the owner: sealed (Dramatist-managed) records
  // must never reach the Drives panel — the list/get payloads would otherwise
  // hand the browser the full scheme JSON. Behind the Curtain (admin,
  // spoiler-blurred) is the only sanctioned reader, and mutations through this
  // surface could clobber or expose scheme state.
  //
  // A sealed sheet is INDISTINGUISHABLE from a missing one on this surface: it
  // reads as undefined here and every handler answers the same 404 body. The
  // old 403 ("sealed sheets are Dramatist-managed") let the owner walk the
  // cast and learn which NPCs carry secret schemes.
  function findUnsealed(campaignId: string, characterName: string) {
    const row = drives.findByCharacter(campaignId, characterName);
    return row && !row.sealed ? row : undefined;
  }

  // Manual edits stamp the CURRENT turn when the app can resolve it; otherwise
  // the existing watermark is kept. (The drive worker's user-edit protection
  // keys on `source === "user" && updatedAt > run start`, not on the turn,
  // so either stamp is safe for it.)
  const manualTurn = (userId: string, campaignId: string, existing: { lastUpdatedTurn: number | null } | undefined) =>
    resolveCurrentTurn?.(userId, campaignId) ?? existing?.lastUpdatedTurn ?? null;

  const list: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      requireCampaign(userId, campaignId);
      res.json({ drives: drives.listForCampaign(campaignId).filter((row) => !row.sealed) });
    } catch (error) { next(error); }
  };

  const get: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      const characterName = String(req.params.characterName);
      requireCampaign(userId, campaignId);
      const row = findUnsealed(campaignId, characterName);
      if (!row) { res.status(404).json(NO_SHEET); return; }
      res.json(row);
    } catch (error) { next(error); }
  };

  const update: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      const characterName = String(req.params.characterName);
      requireCampaign(userId, campaignId);
      const parsed = updateDriveRequestSchema.safeParse(req.body);
      // Name the failing field: the phone shows this message as sent.
      if (!parsed.success) { res.status(400).json({ error: `invalid drive sheet: ${describeIssues(parsed.error)}` }); return; }
      const existing = findUnsealed(campaignId, characterName);
      // PATCH creates when no sheet exists, so it can't 404 on "missing" — but
      // a name occupied by a SEALED row must neither be clobbered nor revealed:
      // it answers the same 404 body as the other verbs.
      if (!existing && drives.findByCharacter(campaignId, characterName)) { res.status(404).json(NO_SHEET); return; }
      drives.upsert({
        campaignId,
        characterName,
        sheet: parsed.data.sheet,
        turn: manualTurn(userId, campaignId, existing),
        messageId: existing?.lastUpdatedMessageId ?? null,
        source: "user",
        reason: parsed.data.reason ?? "manual edit",
        recordHistory: true,
      });
      res.json(drives.findByCharacter(campaignId, characterName));
    } catch (error) { next(error); }
  };

  const remove: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      const characterName = String(req.params.characterName);
      requireCampaign(userId, campaignId);
      if (!findUnsealed(campaignId, characterName)) { res.status(404).json(NO_SHEET); return; }
      drives.deleteForCharacter(campaignId, characterName);
      res.json({ drives: drives.listForCampaign(campaignId).filter((row) => !row.sealed) });
    } catch (error) { next(error); }
  };

  const history: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      const characterName = String(req.params.characterName);
      requireCampaign(userId, campaignId);
      if (!findUnsealed(campaignId, characterName)) { res.status(404).json(NO_SHEET); return; }
      const rows = drives.history(campaignId, characterName);
      const entries: DriveHistoryEntry[] = rows
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((r) => ({
          id: r.id,
          before: parseSheet(r.beforeJson),
          after: parseSheet(r.afterJson) ?? driveSheetSchema.parse({}),
          changedAtTurn: r.changedAtTurn ?? null,
          source: r.source,
          reason: r.reason ?? null,
          createdAt: r.createdAt,
        }));
      res.json({ characterName, entries });
    } catch (error) { next(error); }
  };

  const revert: RequestHandler = (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const campaignId = String(req.params.campaignId);
      const characterName = String(req.params.characterName);
      requireCampaign(userId, campaignId);
      const parsed = revertDriveRequestSchema.safeParse(req.body);
      // Named like the sheet's own refusals. The body is checked before the
      // sheet is looked up, so a sealed and a missing sheet still answer alike.
      if (!parsed.success) { res.status(400).json({ error: `invalid revert request: ${describeIssues(parsed.error)}` }); return; }
      const existing = findUnsealed(campaignId, characterName);
      if (!existing) { res.status(404).json(NO_SHEET); return; }
      const entry = drives.findHistoryEntry(campaignId, characterName, parsed.data.historyId);
      if (!entry) { res.status(404).json({ error: "history entry not found" }); return; }
      const target = parseSheet(entry.afterJson);
      if (!target) { res.status(422).json({ error: "history snapshot unreadable" }); return; }
      // The revert is itself captured as a new history row (lorebook-revert parity).
      drives.upsert({
        campaignId,
        characterName,
        sheet: target,
        turn: manualTurn(userId, campaignId, existing),
        messageId: existing?.lastUpdatedMessageId ?? null,
        source: "user",
        reason: `revert to ${entry.createdAt}`,
        recordHistory: true,
      });
      res.json(drives.findByCharacter(campaignId, characterName));
    } catch (error) { next(error); }
  };

  return { list, get, update, remove, history, revert };
}

function parseSheet(json: string | null | undefined) {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    if (raw === null) return null;
    const parsed = driveSheetSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
