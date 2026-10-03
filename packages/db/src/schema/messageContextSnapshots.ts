import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { messages } from "./messages";
import { sessions } from "./sessions";
import { users } from "./users";

// One context snapshot per assistant reply (migration 0089): the turn's
// `response.context` payload as JSON (contract `messageContextSnapshotSchema`).
// The API keeps each session's newest 50 rows by created_at and prunes the rest
// on write (MessageContextSnapshotRepository.save).
export const messageContextSnapshots = sqliteTable("message_context_snapshots", {
  messageId: text("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
}, (table) => ({
  sessionCreatedIdx: index("message_context_snapshots_session_created_idx").on(table.sessionId, table.createdAt),
}));
