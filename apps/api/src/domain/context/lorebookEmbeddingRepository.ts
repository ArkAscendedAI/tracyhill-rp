import { createHash } from "node:crypto";

import { and, eq, isNull, or, sql } from "drizzle-orm";

import { lorebookEntryEmbeddings, lorebookEntries, type DatabaseClient } from "@tracyhill-rp/db";

export class LorebookEmbeddingRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  findByEntryAndModel(entryId: string, model: string) {
    return this.db.select().from(lorebookEntryEmbeddings)
      .where(and(eq(lorebookEntryEmbeddings.entryId, entryId), eq(lorebookEntryEmbeddings.model, model)))
      .get();
  }

  // Campaign-scoped candidate pool. The semantic top-K must run over the
  // current campaign's vectors only — otherwise a user with two campaigns under
  // one embedding model has the slice starved by the other campaign's entries.
  // GLOBAL (campaign-less) entries have campaign_id NULL and are included in
  // every campaign's pool.
  listForCampaignAndModel(userId: string, campaignId: string, model: string) {
    return this.db.select().from(lorebookEntryEmbeddings)
      .where(and(
        eq(lorebookEntryEmbeddings.userId, userId),
        eq(lorebookEntryEmbeddings.model, model),
        or(
          eq(lorebookEntryEmbeddings.campaignId, campaignId),
          isNull(lorebookEntryEmbeddings.campaignId),
        ),
        sql`EXISTS (SELECT 1 FROM lorebook_entries le WHERE le.id = ${lorebookEntryEmbeddings.entryId} AND le.user_id = ${lorebookEntryEmbeddings.userId} AND le.sealed = 0)`,
      ))
      .all();
  }

  upsert(input: typeof lorebookEntryEmbeddings.$inferInsert): boolean {
    return this.db.transaction(() => {
      // Provider calls can finish after a newer edit, deletion or seal. Derive
      // scope from the surviving row and compare the FULL source hash atomically.
      const entry = this.db.select().from(lorebookEntries)
        .where(and(eq(lorebookEntries.id, input.entryId), eq(lorebookEntries.userId, input.userId))).get();
      if (!entry || entry.sealed === 1) {
        if (entry?.sealed === 1) this.deleteForEntry(input.entryId);
        return false;
      }
      if (createHash("sha256").update(entry.content).digest("hex") !== input.contentHash) return false;
      const existing = this.findByEntryAndModel(input.entryId, input.model);
      if (existing) {
        this.db.update(lorebookEntryEmbeddings).set({
          vector: input.vector, dimensions: input.dimensions,
          contentHash: input.contentHash, createdAt: input.createdAt,
          campaignId: entry.campaignId,
        }).where(eq(lorebookEntryEmbeddings.id, existing.id)).run();
      } else {
        this.db.insert(lorebookEntryEmbeddings).values({ ...input, campaignId: entry.campaignId }).run();
      }
      return true;
    });
  }

  deleteForEntry(entryId: string) {
    this.db.delete(lorebookEntryEmbeddings)
      .where(eq(lorebookEntryEmbeddings.entryId, entryId)).run();
  }

  isEntrySealed(entryId: string): boolean {
    return this.db.select({ sealed: lorebookEntries.sealed }).from(lorebookEntries)
      .where(eq(lorebookEntries.id, entryId)).get()?.sealed === 1;
  }

  // "Stale" = the stored vector was computed from DIFFERENT content than the
  // row holds now, decided by content hash. The old `updated_at >
  // embedding.created_at` test flagged every entry touched by a non-content
  // write (bulk set-sticky / append-keys bump updated_at) as stale, so the
  // coverage monitor warned on vectors that were perfectly current. SQLite has
  // no sha256, so the hash comparison runs here over the campaign's rows (a
  // few hundred to ~1k entries on a 6-hourly timer and the status endpoint).
  countStatus(userId: string, campaignId: string, model: string) {
    const rows = this.db.select({
      content: sql<string>`le.content`,
      storedHash: sql<string | null>`lee.content_hash`,
    }).from(sql`lorebook_entries le left join lorebook_entry_embeddings lee on le.id = lee.entry_id and lee.model = ${model}`)
      .where(sql`le.user_id = ${userId} and le.campaign_id = ${campaignId} and le.is_enabled = 1 and le.sealed = 0`)
      .all();
    let indexed = 0;
    let stale = 0;
    for (const row of rows) {
      if (row.storedHash == null) continue;
      indexed++;
      if (row.storedHash !== createHash("sha256").update(row.content ?? "").digest("hex")) stale++;
    }
    const total = rows.length;
    return { total, indexed, stale, missing: total - indexed };
  }
}
