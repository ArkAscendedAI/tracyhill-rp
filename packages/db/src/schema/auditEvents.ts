import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  actorUserId: text("actor_user_id"),
  actorRole: text("actor_role"),
  requestId: text("request_id"),
  jobId: text("job_id"),
  sessionId: text("session_id"),
  campaignId: text("campaign_id"),
  runId: text("run_id"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  // Migration 0029. created_at is DESC in the SQL.
  actionIdx: index("idx_audit_events_action").on(table.action),
  actorUserIdx: index("idx_audit_events_actor_user_id").on(table.actorUserId),
  campaignIdx: index("idx_audit_events_campaign_id").on(table.campaignId),
  createdAtIdx: index("idx_audit_events_created_at").on(table.createdAt),
  runIdx: index("idx_audit_events_run_id").on(table.runId),
}));
