import { Router } from "express";

import { ackSystemEventsRequestSchema, systemEventClassSchema } from "@tracyhill-rp/contracts";

import { ackSystemEvents, countUnackedSystemEvents, listSystemEvents } from "../../domain/system/systemEvents";
import { describeIssues } from "../describeIssues";
import { createRequireAuth } from "../middleware/requireAuth";

import type { UserRepository } from "../../domain/users/userRepository";

export function createSystemEventRoutes(users: UserRepository) {
  const router = Router();
  router.use(createRequireAuth(users));

  // Process-level `__system__` events (worker DEAD/recovered, catalog
  // invariants, bridge-not-configured) belong to no user; admins see and ack
  // them alongside their own so the watchdogs actually reach a human.
  // Non-admin feeds are unchanged. requireAuth already verified the
  // user exists, so the role lookup cannot miss.
  const scopeFor = (userId: string) => ({ includeSystem: users.findById(userId)?.role === "admin" });

  router.get("/", (req, res) => {
    const userId = req.session.userId!;
    const scope = scopeFor(userId);
    const unackedOnly = req.query.unacked === "1" || req.query.unacked === "true";
    const limitRaw = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    // ?class=alert|notice narrows the list; the counts always cover both.
    const eventClass = systemEventClassSchema.safeParse(req.query.class).data;
    const rows = listSystemEvents(userId, { unackedOnly, limit, eventClass, ...scope });
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
      unackedCount: countUnackedSystemEvents(userId, scope),
      alertCount: countUnackedSystemEvents(userId, scope, "alert"),
      noticeCount: countUnackedSystemEvents(userId, scope, "notice"),
    });
  });

  router.post("/ack", (req, res) => {
    const parsed = ackSystemEventsRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // The field and the reason follow the old prefix.
      res.status(400).json({ error: `invalid request: ${describeIssues(parsed.error)}` });
      return;
    }
    const userId = req.session.userId!;
    const scope = scopeFor(userId);
    const acknowledged = ackSystemEvents(userId, parsed.data.ids, scope, parsed.data.class);
    res.json({
      acknowledged,
      unackedCount: countUnackedSystemEvents(userId, scope),
      alertCount: countUnackedSystemEvents(userId, scope, "alert"),
      noticeCount: countUnackedSystemEvents(userId, scope, "notice"),
    });
  });

  return router;
}
