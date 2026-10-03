import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

// One-time invite links (migration 0094). The token is stored hashed.
export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  role: text("role").notNull(),
  username: text("username"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
  revokedAt: text("revoked_at"),
});
