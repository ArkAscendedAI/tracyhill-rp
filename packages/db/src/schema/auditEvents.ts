import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
});
