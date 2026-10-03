import type { RequestHandler } from "express";

import { createCampaignRequestSchema, restoreCampaignVersionRequestSchema, updateCampaignRequestSchema } from "@tracyhill-rp/contracts";

import type { CampaignService } from "../../domain/campaigns/campaignService";
import { describeIssues } from "../describeIssues";

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
        // The field and the reason follow the old prefix: clients show this text, and
        // the bare "invalid campaign request" named neither a 161-character name nor an over-long prompt.
        res.status(400).json({ error: `invalid campaign request: ${describeIssues(parsed.error)}` });
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
        res.status(400).json({ error: `invalid campaign request: ${describeIssues(parsed.error)}` });
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
        // A path parameter, not a body: no contract parse, so the one rule it breaks is named in describeIssues' form.
        // The bare "invalid campaign version" named neither.
        res.status(400).json({ error: `invalid campaign version: ${describeIssues({ issues: [{ path: ["version"], message: "Expected a whole number of 0 or more" }] })}` });
        return;
      }
      // Optional body: `archiveId` restores that exact history row; older clients post none.
      const body = restoreCampaignVersionRequestSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: `invalid restore request: ${describeIssues(body.error)}` });
        return;
      }
      res.json(campaigns.restoreVersion(req.session.userId!, String(req.params.campaignId), version, body.data.archiveId));
    } catch (error) {
      next(error);
    }
  };

  return { list, create, update, remove, listVersions, restoreVersion };
}
