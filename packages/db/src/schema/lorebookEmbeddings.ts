import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const lorebookEntryEmbeddings = sqliteTable("lorebook_entry_embeddings", {
  id: text("id").primaryKey(),
  entryId: text("entry_id").notNull(),
  userId: text("user_id").notNull(),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  vector: text("vector").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
});
