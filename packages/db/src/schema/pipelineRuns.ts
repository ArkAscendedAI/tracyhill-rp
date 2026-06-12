import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  campaignId: text("campaign_id").notNull(),
  status: text("status").notNull(),
  summary: text("summary"),
  error: text("error"),
  detailsJson: text("details_json"),
  requestedAt: text("requested_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  approvedAt: text("approved_at"),
  kind: text("kind").notNull().default("campaign_review"),
  sessionId: text("session_id"),
  priority: integer("priority").notNull().default(50),
  updatedAt: text("updated_at").notNull(),
});
