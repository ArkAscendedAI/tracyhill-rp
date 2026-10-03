import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  activeSessionId: text("active_session_id"),
  // font_size / status_bar_open / ctrl_bar_open (never in the workspace
  // contract) were dropped by 0083 (2026-09-02).
  sidebarOpen: integer("sidebar_open").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});
