import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const lorebookEntryEmbeddings = sqliteTable("lorebook_entry_embeddings", {
  id: text("id").primaryKey(),
  entryId: text("entry_id").notNull(),
  userId: text("user_id").notNull(),
  // Campaign scoping for the semantic candidate pool. Nullable — global
  // (campaign-less) lorebook entries embed with campaign_id NULL.
  campaignId: text("campaign_id"),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  vector: text("vector").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  // One vector per (entry, model) — re-embedding under a new model adds a row
  // rather than replacing the prior model's vector (migration 0040).
  entryModelUq: uniqueIndex("idx_lorebook_entry_embeddings_unique").on(table.entryId, table.model),
  userModelIdx: index("idx_lorebook_entry_embeddings_user_model").on(table.userId, table.model),
  campaignModelIdx: index("idx_lee_campaign_model").on(table.userId, table.campaignId, table.model),
}));
