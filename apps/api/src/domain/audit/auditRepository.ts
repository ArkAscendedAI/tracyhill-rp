import { desc, eq } from "drizzle-orm";

import { auditEvents, users, type DatabaseClient } from "@tracyhill-rp/db";

export class AuditRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  create(input: typeof auditEvents.$inferInsert) {
    this.db.insert(auditEvents).values(input).run();
  }

  listRecent(limit = 100) {
    return this.db.select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorUserId: auditEvents.actorUserId,
      actorUsername: users.username,
      actorRole: auditEvents.actorRole,
      requestId: auditEvents.requestId,
      jobId: auditEvents.jobId,
      sessionId: auditEvents.sessionId,
      campaignId: auditEvents.campaignId,
      runId: auditEvents.runId,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      metadataJson: auditEvents.metadataJson,
      createdAt: auditEvents.createdAt,
    })
      .from(auditEvents)
      .leftJoin(users, eq(auditEvents.actorUserId, users.id))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(Math.max(1, Math.min(200, limit)))
      .all();
  }
}
