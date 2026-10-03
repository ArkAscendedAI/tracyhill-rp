import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { messages } from "./messages";
import { sessions } from "./sessions";
import { users } from "./users";

export const messageAttachments = sqliteTable("message_attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  // DEFAULT 'text' since migration 0007 — the Drizzle side lacked it, so
  // $inferInsert wrongly required the field.
  contentMode: text("content_mode").notNull().default("text"),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  messageIdx: index("message_attachments_message_idx").on(table.messageId),
  sessionIdx: index("message_attachments_session_idx").on(table.sessionId),
}));
