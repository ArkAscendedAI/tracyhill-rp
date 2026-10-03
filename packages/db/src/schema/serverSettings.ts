import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// The in-app server settings (migration 0091): one JSON value per section. `updated_by` is a user id,
// or `setup`, `boot` or `recovery-cli` for the writes no person made in the page.
export const serverSettings = sqliteTable("server_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});
