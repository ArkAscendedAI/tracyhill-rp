import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { folders } from "./folders";
import { users } from "./users";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionType: text("session_type").notNull().default("standard"),
  campaignId: text("campaign_id"),
  folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  modelId: text("model_id").notNull().default("claude-opus-4-6"),
  temperature: real("temperature").notNull().default(1),
  thinkingMode: text("thinking_mode").notNull().default("off"),
  thinkingBudget: integer("thinking_budget"),
  effort: text("effort"),
  cacheTtl: text("cache_ttl").notNull().default("off"),
  // Written only by the retired V1 importer (standalone imported sessions); read
  // by the `campaign?.systemPrompt ?? session.systemPrompt` fallback in
  // chatService. 15 live standalone sessions still carry one (measured
  // 2026-09-02) — kept for as long as they do; not a dead column.
  systemPrompt: text("system_prompt").notNull().default(""),
  sceneLocation: text("scene_location"),
  scenePresent: text("scene_present").default("[]"),
  scenePresentUnaware: text("scene_present_unaware").default("[]"),
  contextOverridesJson: text("context_overrides_json"),
  pipelineCharsSinceRollingDiff: integer("pipeline_chars_since_rolling_diff").notNull().default(0),
  pipelineCharsSinceRepetition: integer("pipeline_chars_since_repetition").notNull().default(0),
  pipelineCharsSinceSysprompt: integer("pipeline_chars_since_sysprompt").notNull().default(0),
  autoScroll: integer("auto_scroll").notNull().default(0),
  messageCount: integer("message_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastMessageAt: text("last_message_at"),
  deletedAt: text("deleted_at"),
}, (table) => ({
  // Migration 0030 (rebuild). updated_at is DESC in the SQL; Drizzle's
  // declaration records the column set only.
  userFolderIdx: index("sessions_user_folder_idx").on(table.userId, table.folderId),
  userUpdatedIdx: index("sessions_user_updated_idx").on(table.userId, table.updatedAt),
}));
