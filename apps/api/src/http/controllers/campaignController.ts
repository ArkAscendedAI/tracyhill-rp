import type { RequestHandler } from "express";

import { createCampaignRequestSchema, updateCampaignRequestSchema } from "@tracyhill-rp/contracts";

import type { CampaignService } from "../../domain/campaigns/campaignService";

export function createCampaignController(campaigns: CampaignService) {
  const list: RequestHandler = (req, res, next) => {
    try {
      res.json(campaigns.list(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const create: RequestHandler = (req, res, next) => {
    try {
      const parsed = createCampaignRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid campaign request" });
        return;
      }
      res.status(201).json(campaigns.create(req.session.userId!, parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const update: RequestHandler = (req, res, next) => {
    try {
      const parsed = updateCampaignRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid campaign request" });
        return;
      }
      res.json(campaigns.update(req.session.userId!, String(req.params.campaignId), parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const remove: RequestHandler = (req, res, next) => {
    try {
      res.json(campaigns.delete(req.session.userId!, String(req.params.campaignId)));
    } catch (error) {
      next(error);
    }
  };

  const listVersions: RequestHandler = (req, res, next) => {
    try {
      res.json(campaigns.listVersions(req.session.userId!, String(req.params.campaignId)));
    } catch (error) {
      next(error);
    }
  };

  const restoreVersion: RequestHandler = (req, res, next) => {
    try {
      const version = Number.parseInt(String(req.params.version), 10);
      if (!Number.isInteger(version) || version < 0) {
        res.status(400).json({ error: "invalid campaign version" });
        return;
      }
      res.json(campaigns.restoreVersion(req.session.userId!, String(req.params.campaignId), version));
    } catch (error) {
      next(error);
    }
  };

  return { list, create, update, remove, listVersions, restoreVersion };
}
