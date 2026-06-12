import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const providerKeys = sqliteTable("provider_keys", {
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  apiKey: text("api_key").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.provider] }),
}));
