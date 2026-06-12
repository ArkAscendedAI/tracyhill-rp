import { text, sqliteTable } from "drizzle-orm/sqlite-core";

export const generatedImages = sqliteTable("generated_images", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  prompt: text("prompt").notNull(),
  mimeType: text("mime_type").notNull(),
  createdAt: text("created_at").notNull(),
});
