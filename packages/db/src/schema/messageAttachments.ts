import { text, sqliteTable } from "drizzle-orm/sqlite-core";

export const messageAttachments = sqliteTable("message_attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  contentMode: text("content_mode").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});
