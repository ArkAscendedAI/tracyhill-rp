import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  folderId: text("folder_id"),
  pipelineModelId: text("pipeline_model_id").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  characterRoster: text("character_roster").default("[]"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  kindRegistry: text("kind_registry").notNull().default('{"kinds":{}}'),
  creativeModelId: text("creative_model_id"),
  contextDefaultsJson: text("context_defaults_json"),
});
