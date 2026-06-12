import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Persistent record of passive-subsystem failures so background machinery
// (embeddings, HyDE, researcher, validators, workers) can never fail silently.
export const systemEvents = sqliteTable("system_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  source: text("source").notNull(),
  severity: text("severity").notNull().default("warn"),
  message: text("message").notNull(),
  campaignId: text("campaign_id"),
  sessionId: text("session_id"),
  detailsJson: text("details_json"),
  acknowledgedAt: text("acknowledged_at"),
  createdAt: text("created_at").notNull(),
});
