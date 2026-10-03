import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  // The DEFAULT names the retired campaign_review kind (0071 sunset) and is dead:
  // every code path sets `kind` explicitly. It mirrors migration 0042 and stays
  // because a default change would be a table rebuild for no behavioral gain.
  kind: text("kind").notNull().default("campaign_review"),
  sessionId: text("session_id"),
  priority: integer("priority").notNull().default(50),
  updatedAt: text("updated_at").notNull(),
  // Resume-on-failure cooldown: a queued run whose not_before is in the future
  // is skipped by the claim query until then (transient self-requeue, e.g. a
  // Max-window rate-limit — the run keeps its checkpoint and retries later
  // instead of failing and wasting the tokens already spent).
  notBefore: text("not_before"),
}, (table) => ({
  campaignIdx: index("idx_pipeline_runs_campaign").on(table.campaignId),
  kindStatusIdx: index("idx_pipeline_runs_kind_status").on(table.kind, table.status),
}));
