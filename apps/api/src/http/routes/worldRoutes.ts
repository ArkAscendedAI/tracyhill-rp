import { Router } from "express";
import type { RequestHandler } from "express";

import { worldTickRequestSchema, worldApplyRequestSchema, updateBeatStatusRequestSchema } from "@tracyhill-rp/contracts";

import type { UserRepository } from "../../domain/users/userRepository";
import type { WorldService } from "../../domain/world/worldService";
import { createRequireAuth } from "../middleware/requireAuth";
import { createRequireAdmin } from "../middleware/requireAdmin";
import { describeIssues } from "../describeIssues";

/** An apply-body path as the reader knows it: "event 2 (Mara, Vale) summary" for
 *  `events.1.summary`, the event counted from 1 among those sent and named by up to three of its actors, since
 *  the review edits summaries and details and the bare "invalid apply request" named neither the event nor the
 *  field. Any other path is dot-joined, as `describeIssues` does. */
export function applyIssuePath(body: unknown) {
  return (path: ReadonlyArray<string | number>): string => {
    const [head, index] = path;
    if (head !== "events" || typeof index !== "number") return path.join(".") || "body";
    const sent = (body as { events?: unknown } | null)?.events;
    const event = Array.isArray(sent) ? sent[index] as { actors?: unknown } | undefined : undefined;
    const actors = Array.isArray(event?.actors)
      ? event.actors.filter((name): name is string => typeof name === "string" && name.trim() !== "").slice(0, 3).map((name) => Array.from(name.trim()).slice(0, 60).join(""))
      : [];
    const field = path.slice(2).join(".");
    return `event ${index + 1}${actors.length ? ` (${actors.join(", ")})` : ""}${field ? ` ${field}` : ""}`;
  };
}

export function createWorldRoutes(world: WorldService, users: UserRepository) {
  const router = Router();
  router.use(createRequireAuth(users));

  const status: RequestHandler = (req, res, next) => {
    try { res.json(world.status(req.session.userId!, String(req.params.campaignId))); } catch (e) { next(e); }
  };

  const tick: RequestHandler = (req, res, next) => {
    try {
      const parsed = worldTickRequestSchema.safeParse(req.body);
      // Names the field after the old prefix, as the apply route below does.
      if (!parsed.success) { res.status(400).json({ error: `invalid tick request: ${describeIssues(parsed.error)}` }); return; }
      res.json(world.tick(req.session.userId!, String(req.params.campaignId), parsed.data));
    } catch (e) { next(e); }
  };

  const apply: RequestHandler = async (req, res, next) => {
    try {
      const parsed = worldApplyRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: `invalid apply request: ${describeIssues(parsed.error, applyIssuePath(req.body))}` }); return; }
      res.json(await world.apply(req.session.userId!, String(req.params.campaignId), String(req.params.runId), parsed.data.events));
    } catch (e) { next(e); }
  };

  const beatStatus: RequestHandler = (req, res, next) => {
    try {
      const parsed = updateBeatStatusRequestSchema.safeParse(req.body);
      // Named like the tick and apply refusals.
      if (!parsed.success) { res.status(400).json({ error: `invalid beat status: ${describeIssues(parsed.error)}` }); return; }
      res.json(world.setBeatStatus(req.session.userId!, String(req.params.campaignId), String(req.params.beatId), parsed.data.status));
    } catch (e) { next(e); }
  };

  const behindCurtain: RequestHandler = (req, res, next) => {
    try { res.json(world.behindCurtain(req.session.userId!, String(req.params.campaignId))); } catch (e) { next(e); }
  };

  // "Confirm as canon" through the single offscreen-marker writer.
  const confirmOffscreen: RequestHandler = (req, res, next) => {
    try { res.json(world.confirmOffscreen(req.session.userId!, String(req.params.campaignId), String(req.params.entryId))); } catch (e) { next(e); }
  };

  router.get("/campaigns/:campaignId/status", status);
  router.post("/campaigns/:campaignId/tick", tick);
  router.post("/campaigns/:campaignId/runs/:runId/apply", apply);
  router.post("/campaigns/:campaignId/beats/:beatId/status", beatStatus);
  router.post("/campaigns/:campaignId/offscreen/:entryId/confirm", confirmOffscreen);
  const inspectAdversarial: RequestHandler = (req, res, next) => {
    try { res.json(world.inspectAdversarial(req.session.userId!, String(req.params.campaignId))); } catch (e) { next(e); }
  };

  const dismissConsequence: RequestHandler = (req, res, next) => {
    try {
      res.json(world.dismissConsequence(req.session.userId!, String(req.params.campaignId), String(req.params.consequenceId)));
    } catch (e) { next(e); }
  };

  router.get("/campaigns/:campaignId/dramatist-log", createRequireAdmin(users), behindCurtain);
  router.get("/campaigns/:campaignId/adversarial", createRequireAdmin(users), inspectAdversarial);
  router.delete("/campaigns/:campaignId/consequences/:consequenceId", createRequireAdmin(users), dismissConsequence);
  return router;
}
