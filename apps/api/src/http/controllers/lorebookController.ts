import type { RequestHandler } from "express";

import { createLorebookEntryRequestSchema, updateLorebookEntryRequestSchema, lorebookBulkActionSchema, lorebookListQuerySchema, lorebookExportQuerySchema, lorebookRevertRequestSchema, characterCardImportRequestSchema, lorebookDeletedListQuerySchema } from "@tracyhill-rp/contracts";

import type { LorebookService } from "../../domain/context/lorebookService";
import { extractCardFromPng } from "../../domain/context/characterCardImporter";
import { describeIssues } from "../describeIssues";

export function createLorebookController(lorebook: LorebookService) {
  const list: RequestHandler = (req, res, next) => {
    try {
      const parsed = lorebookListQuerySchema.safeParse(req.query);
      // The list, bulk, export and revert refusals name the field and the reason after the old prefix too, as
      // create, update and the deleted list already did.
      if (!parsed.success) { res.status(400).json({ error: `invalid query: ${describeIssues(parsed.error)}` }); return; }
      const campaignId = String(req.params.campaignId);
      const opts = {
        isEnabled: parsed.data.isEnabled === "true" ? true : parsed.data.isEnabled === "false" ? false : undefined,
        isConstant: parsed.data.isConstant === "true" ? true : parsed.data.isConstant === "false" ? false : undefined,
        sort: parsed.data.sort,
        order: parsed.data.order,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        search: parsed.data.search,
        tag: parsed.data.tag,
        offscreen: parsed.data.offscreen === "true" ? true : undefined,
        provisional: parsed.data.provisional === "true" ? true : undefined,
      };
      // `view=summary`: rows without their text; the default stays the full rows.
      res.json(parsed.data.view === "summary"
        ? lorebook.listSummary(req.session.userId!, campaignId, opts)
        : lorebook.list(req.session.userId!, campaignId, opts));
    } catch (error) { next(error); }
  };

  const get: RequestHandler = (req, res, next) => {
    try {
      res.json(lorebook.get(req.session.userId!, String(req.params.entryId)));
    } catch (error) { next(error); }
  };

  const create: RequestHandler = (req, res, next) => {
    try {
      const parsed = createLorebookEntryRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: `invalid lorebook entry: ${describeIssues(parsed.error)}` }); return; }
      res.status(201).json(lorebook.create(req.session.userId!, String(req.params.campaignId), parsed.data));
    } catch (error) { next(error); }
  };

  const update: RequestHandler = (req, res, next) => {
    try {
      const parsed = updateLorebookEntryRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: `invalid lorebook entry update: ${describeIssues(parsed.error)}` }); return; }
      res.json(lorebook.update(req.session.userId!, String(req.params.entryId), parsed.data));
    } catch (error) { next(error); }
  };

  const remove: RequestHandler = (req, res, next) => {
    try {
      lorebook.remove(req.session.userId!, String(req.params.entryId));
      res.json({ ok: true });
    } catch (error) { next(error); }
  };

  const bulkAction: RequestHandler = (req, res, next) => {
    try {
      const parsed = lorebookBulkActionSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: `invalid bulk action: ${describeIssues(parsed.error)}` }); return; }
      // The route campaign scopes every verb: a client cannot cross campaigns.
      res.json(lorebook.bulkAction(req.session.userId!, String(req.params.campaignId), parsed.data));
    } catch (error) { next(error); }
  };

  const importLorebook: RequestHandler = (req, res, next) => {
    try {
      const campaignId = String(req.params.campaignId);
      const formatRaw = req.query.format;
      const format = typeof formatRaw === "string" && formatRaw ? formatRaw : "sillytavern";
      res.json(lorebook.import(req.session.userId!, campaignId, req.body, format));
    } catch (error) { next(error); }
  };

  const importCharacterCard: RequestHandler = (req, res, next) => {
    try {
      const parsed = characterCardImportRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "card or pngBase64 required" }); return; }
      let card: unknown = parsed.data.card;
      if (parsed.data.pngBase64) {
        const extracted = extractCardFromPng(Buffer.from(parsed.data.pngBase64, "base64"));
        if (!extracted) { res.status(422).json({ error: "no character card found in the PNG (missing chara/ccv3 tEXt chunk)" }); return; }
        card = extracted;
      }
      res.json(lorebook.importCharacterCard(req.session.userId!, String(req.params.campaignId), card));
    } catch (error) { next(error); }
  };

  const exportLorebook: RequestHandler = (req, res, next) => {
    try {
      const parsed = lorebookExportQuerySchema.safeParse(req.query);
      if (!parsed.success) { res.status(400).json({ error: `invalid export format: ${describeIssues(parsed.error)}` }); return; }
      const campaignId = String(req.params.campaignId);
      const result = lorebook.export(req.session.userId!, campaignId, parsed.data.format);
      res.setHeader("Content-Disposition", `attachment; filename="lorebook-${campaignId}-${parsed.data.format}.json"`);
      res.json(result);
    } catch (error) { next(error); }
  };

  const tags: RequestHandler = (req, res, next) => {
    try {
      res.json({ tags: lorebook.getTags(req.session.userId!, String(req.params.campaignId)) });
    } catch (error) { next(error); }
  };

  const revisions: RequestHandler = (req, res, next) => {
    try {
      res.json({ revisions: lorebook.getRevisions(req.session.userId!, String(req.params.entryId)) });
    } catch (error) { next(error); }
  };

  // The campaign's deleted entries that revert can bring back.
  const deleted: RequestHandler = (req, res, next) => {
    try {
      const parsed = lorebookDeletedListQuerySchema.safeParse(req.query);
      if (!parsed.success) { res.status(400).json({ error: `invalid query: ${describeIssues(parsed.error)}` }); return; }
      res.json(lorebook.listDeleted(req.session.userId!, String(req.params.campaignId), parsed.data.limit));
    } catch (error) { next(error); }
  };

  const revert: RequestHandler = (req, res, next) => {
    try {
      const parsed = lorebookRevertRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: `invalid revert request: ${describeIssues(parsed.error)}` }); return; }
      res.json(lorebook.revert(req.session.userId!, String(req.params.entryId), parsed.data.revisionId));
    } catch (error) { next(error); }
  };

  return { list, get, create, update, remove, bulkAction, importLorebook, importCharacterCard, exportLorebook, tags, revisions, revert, deleted };
}
