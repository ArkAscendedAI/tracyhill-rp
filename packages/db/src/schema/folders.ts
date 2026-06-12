import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
  position: integer("position").notNull().default(0),
  collapsed: integer("collapsed").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  userPositionIdx: uniqueIndex("folders_user_position_idx").on(table.userId, table.position),
}));
