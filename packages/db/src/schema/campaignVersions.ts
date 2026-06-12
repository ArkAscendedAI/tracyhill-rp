import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const campaignVersions = sqliteTable("campaign_versions", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  userId: text("user_id").notNull(),
  version: integer("version").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  createdAt: text("created_at").notNull(),
  label: text("label"),
});
