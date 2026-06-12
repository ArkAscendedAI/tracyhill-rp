import { Router } from "express";

import { ackSystemEventsRequestSchema } from "@tracyhill-rp/contracts";

import { ackSystemEvents, countUnackedSystemEvents, listSystemEvents } from "../../domain/system/systemEvents";
import { createRequireAuth } from "../middleware/requireAuth";

import type { UserRepository } from "../../domain/users/userRepository";

export function createSystemEventRoutes(users: UserRepository) {
  const router = Router();
  router.use(createRequireAuth(users));

  router.get("/", (req, res) => {
    const userId = req.session.userId!;
    const unackedOnly = req.query.unacked === "1" || req.query.unacked === "true";
    const limitRaw = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    const rows = listSystemEvents(userId, { unackedOnly, limit });
    res.json({
      events: rows.map((row: typeof rows[number]) => ({
        id: row.id,
        source: row.source,
        severity: row.severity,
        message: row.message,
        campaignId: row.campaignId,
        sessionId: row.sessionId,
        detailsJson: row.detailsJson,
        acknowledgedAt: row.acknowledgedAt,
        createdAt: row.createdAt,
      })),
      unackedCount: countUnackedSystemEvents(userId),
    });
  });

  router.post("/ack", (req, res) => {
    const parsed = ackSystemEventsRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const userId = req.session.userId!;
    const acknowledged = ackSystemEvents(userId, parsed.data.ids);
    res.json({ acknowledged, unackedCount: countUnackedSystemEvents(userId) });
  });

  return router;
}
