import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

export const providerKeys = sqliteTable("provider_keys", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  apiKey: text("api_key").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.provider] }),
  userIdx: index("idx_provider_keys_user_id").on(table.userId),
}));
