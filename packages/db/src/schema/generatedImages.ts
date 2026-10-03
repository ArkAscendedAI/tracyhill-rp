import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { messages } from "./messages";
import { sessions } from "./sessions";
import { users } from "./users";

export const generatedImages = sqliteTable("generated_images", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  mimeType: text("mime_type").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  messageIdx: index("generated_images_message_idx").on(table.messageId),
  sessionIdx: index("generated_images_session_idx").on(table.sessionId),
  userIdx: index("idx_generated_images_user").on(table.userId),
}));
