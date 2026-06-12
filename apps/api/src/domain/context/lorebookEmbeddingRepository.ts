import { and, eq, sql } from "drizzle-orm";

import { lorebookEntryEmbeddings, type DatabaseClient } from "@tracyhill-rp/db";

export class LorebookEmbeddingRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  findByEntryAndModel(entryId: string, model: string) {
    return this.db.select().from(lorebookEntryEmbeddings)
      .where(and(eq(lorebookEntryEmbeddings.entryId, entryId), eq(lorebookEntryEmbeddings.model, model)))
      .get();
  }

  listForUserAndModel(userId: string, model: string) {
    return this.db.select().from(lorebookEntryEmbeddings)
      .where(and(eq(lorebookEntryEmbeddings.userId, userId), eq(lorebookEntryEmbeddings.model, model)))
      .all();
  }

  upsert(input: typeof lorebookEntryEmbeddings.$inferInsert) {
    const existing = this.findByEntryAndModel(input.entryId, input.model);
    if (existing) {
      this.db.update(lorebookEntryEmbeddings).set({
        vector: input.vector,
        dimensions: input.dimensions,
        contentHash: input.contentHash,
        createdAt: input.createdAt,
      }).where(eq(lorebookEntryEmbeddings.id, existing.id)).run();
    } else {
      this.db.insert(lorebookEntryEmbeddings).values(input).run();
    }
  }

  deleteForEntry(entryId: string) {
    this.db.delete(lorebookEntryEmbeddings)
      .where(eq(lorebookEntryEmbeddings.entryId, entryId)).run();
  }

  countStatus(userId: string, campaignId: string, model: string) {
    const row = this.db.select({
      total: sql<number>`count(distinct le.id)`,
      indexed: sql<number>`count(distinct lee.entry_id)`,
      stale: sql<number>`sum(case when lee.entry_id is not null and le.updated_at > lee.created_at then 1 else 0 end)`,
    }).from(sql`lorebook_entries le left join lorebook_entry_embeddings lee on le.id = lee.entry_id and lee.model = ${model}`)
      .where(sql`le.user_id = ${userId} and le.campaign_id = ${campaignId} and le.is_enabled = 1`)
      .get();
    const total = row?.total ?? 0;
    const indexed = row?.indexed ?? 0;
    const stale = row?.stale ?? 0;
    return { total, indexed, stale, missing: total - indexed };
  }
}
