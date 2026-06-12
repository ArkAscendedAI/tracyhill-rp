import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id").primaryKey(),
  activeSessionId: text("active_session_id"),
  fontSize: integer("font_size").notNull().default(14),
  sidebarOpen: integer("sidebar_open").notNull().default(1),
  statusBarOpen: integer("status_bar_open").notNull().default(1),
  ctrlBarOpen: integer("ctrl_bar_open").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});
