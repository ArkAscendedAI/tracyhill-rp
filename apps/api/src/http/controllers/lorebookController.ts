import type { RequestHandler } from "express";

import { createLorebookEntryRequestSchema, updateLorebookEntryRequestSchema, lorebookBulkActionSchema, lorebookListQuerySchema } from "@tracyhill-rp/contracts";

import type { LorebookService } from "../../domain/context/lorebookService";

export function createLorebookController(lorebook: LorebookService) {
  const list: RequestHandler = (req, res, next) => {
    try {
      const parsed = lorebookListQuerySchema.safeParse(req.query);
      if (!parsed.success) { res.status(400).json({ error: "invalid query" }); return; }
      const campaignId = String(req.params.campaignId);
      res.json(lorebook.list(req.session.userId!, campaignId, {
        isEnabled: parsed.data.isEnabled === "true" ? true : parsed.data.isEnabled === "false" ? false : undefined,
        isConstant: parsed.data.isConstant === "true" ? true : parsed.data.isConstant === "false" ? false : undefined,
        sort: parsed.data.sort,
        order: parsed.data.order,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        search: parsed.data.search,
        tag: parsed.data.tag,
      }));
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
      if (!parsed.success) { res.status(400).json({ error: "invalid lorebook entry" }); return; }
      res.status(201).json(lorebook.create(req.session.userId!, String(req.params.campaignId), parsed.data));
    } catch (error) { next(error); }
  };

  const update: RequestHandler = (req, res, next) => {
    try {
      const parsed = updateLorebookEntryRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "invalid lorebook entry update" }); return; }
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
      if (!parsed.success) { res.status(400).json({ error: "invalid bulk action" }); return; }
      lorebook.bulkAction(req.session.userId!, parsed.data);
      res.json({ ok: true });
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

  const tags: RequestHandler = (req, res, next) => {
    try {
      res.json({ tags: lorebook.getTags(req.session.userId!, String(req.params.campaignId)) });
    } catch (error) { next(error); }
  };

  return { list, get, create, update, remove, bulkAction, importLorebook, tags };
}
