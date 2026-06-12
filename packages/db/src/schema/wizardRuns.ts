import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const wizardRuns = sqliteTable("wizard_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  modelId: text("model_id").notNull(),
  status: text("status").notNull(),
  summary: text("summary"),
  error: text("error"),
  detailsJson: text("details_json"),
  requestedAt: text("requested_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  approvedAt: text("approved_at"),
  updatedAt: text("updated_at").notNull(),
});
