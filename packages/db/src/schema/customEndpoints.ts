import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const customEndpoints = sqliteTable("custom_endpoints", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  apiFormat: text("api_format").notNull(),
  authHeader: text("auth_header").notNull(),
  modelsJson: text("models_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  userIdx: index("custom_endpoints_user_id_idx").on(table.userId),
}));
