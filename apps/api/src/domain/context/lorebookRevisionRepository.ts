import { and, desc, eq, sql } from "drizzle-orm";

import { lorebookEntries, lorebookEntryRevisions, type DatabaseClient } from "@tracyhill-rp/db";
import type { LorebookRevisionSource } from "@tracyhill-rp/contracts";

import { createId } from "../../lib/ids";

// The source union is the contract's (`lorebookRevisionSourceSchema`); it was
// once re-declared here and drifted.
export type { LorebookRevisionSource };

export interface RevisionWriteContext {
  source: LorebookRevisionSource;
  pipelineRunId?: string | null;
}

// Newest-N revisions kept per entry; older ones are pruned on capture.
const MAX_REVISIONS_PER_ENTRY = 20;

export class LorebookRevisionRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  /**
   * Snapshot the CURRENT row of an entry as a new revision, BEFORE a destructive
   * mutation overwrites it. isConstant entries are skipped (the thread-tracker
   * index is rewritten every run — capturing it is wasteful churn). Returns the
   * id of the captured revision, or null if nothing was captured.
   *
   * `userId` scopes the read so a caller can't snapshot another user's entry.
   */
  captureCurrent(userId: string, entryId: string, ctx: RevisionWriteContext): string | null {
    const row = this.db.select().from(lorebookEntries)
      .where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.id, entryId)))
      .get();
    if (!row) return null;
    if (row.isConstant === 1) return null; // EXCLUDE constants from capture
    return this.captureRow(row, ctx);
  }

  /** Snapshot a row object directly (caller already loaded it). Skips constants. */
  captureRow(row: typeof lorebookEntries.$inferSelect, ctx: RevisionWriteContext): string | null {
    if (row.isConstant === 1) return null;
    const id = createId();
    // MAX → INSERT → prune in ONE write transaction: the API and the worker
    // share this DB, and an owner edit racing a rolling-diff rewrite could mint
    // duplicate revision numbers (0064 has only a non-unique index). BEGIN
    // IMMEDIATE takes the write lock before the MAX read; when this runs inside
    // an outer mutation transaction it degrades to a savepoint.
    this.db.transaction(() => {
      const nextNo = this.nextRevisionNo(row.id);
      this.db.insert(lorebookEntryRevisions).values({
        id,
        entryId: row.id,
        userId: row.userId,
        campaignId: row.campaignId ?? null,
        revisionNo: nextNo,
        name: row.name,
        tag: row.tag ?? null,
        content: row.content,
        comment: row.comment ?? null,
        keys: row.keys ?? "[]",
        keysSecondary: row.keysSecondary ?? "[]",
        knownBy: row.knownBy ?? null,
        isEnabled: row.isEnabled,
        isConstant: row.isConstant,
        sticky: row.sticky,
        compressedRefIds: row.compressedRefIds ?? null,
        sealed: row.sealed,
        // 0084: every dial, so a revert is a full restore.
        selectiveLogic: row.selectiveLogic,
        scanDepth: row.scanDepth,
        position: row.position,
        insertionOrder: row.insertionOrder,
        probability: row.probability,
        cooldown: row.cooldown,
        delay: row.delay,
        excludeRecursion: row.excludeRecursion,
        preventRecursion: row.preventRecursion,
        delayUntilRecursion: row.delayUntilRecursion,
        matchOptionsJson: row.matchOptionsJson ?? null,
        source: ctx.source,
        pipelineRunId: ctx.pipelineRunId ?? null,
        createdAt: new Date().toISOString(),
      }).run();
      this.prune(row.id);
    }, { behavior: "immediate" });
    return id;
  }

  listForEntry(userId: string, entryId: string, limit = MAX_REVISIONS_PER_ENTRY) {
    return this.db.select().from(lorebookEntryRevisions)
      .where(and(eq(lorebookEntryRevisions.userId, userId), eq(lorebookEntryRevisions.entryId, entryId)))
      .orderBy(desc(lorebookEntryRevisions.revisionNo))
      .limit(limit)
      .all();
  }

  /**
   * The campaign's deleted entries that can be brought back:
   * for every entry id whose row no longer exists, its NEWEST revision (the
   * snapshot remove() captured just before the delete, which revert restores),
   * newest deletion first. Sealed snapshots (Dramatist notes) are never listed.
   */
  listDeletedForCampaign(userId: string, campaignId: string, limit = 50) {
    return this.db.select().from(lorebookEntryRevisions)
      .where(and(
        eq(lorebookEntryRevisions.userId, userId),
        eq(lorebookEntryRevisions.campaignId, campaignId),
        eq(lorebookEntryRevisions.sealed, 0),
        sql`NOT EXISTS (SELECT 1 FROM lorebook_entries le WHERE le.id = ${lorebookEntryRevisions.entryId})`,
        sql`${lorebookEntryRevisions.revisionNo} = (SELECT max(r2.revision_no) FROM lorebook_entry_revisions r2 WHERE r2.entry_id = ${lorebookEntryRevisions.entryId})`,
      ))
      .orderBy(desc(lorebookEntryRevisions.createdAt), desc(lorebookEntryRevisions.id))
      .limit(limit)
      .all();
  }

  findById(userId: string, revisionId: string) {
    return this.db.select().from(lorebookEntryRevisions)
      .where(and(eq(lorebookEntryRevisions.userId, userId), eq(lorebookEntryRevisions.id, revisionId)))
      .get();
  }

  private nextRevisionNo(entryId: string): number {
    // Monotonic per entry, never reused — read the MAX even after a prune.
    const row = this.db.select({ max: sql<number | null>`max(${lorebookEntryRevisions.revisionNo})` })
      .from(lorebookEntryRevisions)
      .where(eq(lorebookEntryRevisions.entryId, entryId))
      .get();
    return (row?.max ?? 0) + 1;
  }

  private prune(entryId: string) {
    // Keep only the newest MAX_REVISIONS_PER_ENTRY by revision_no.
    this.db.run(sql`
      DELETE FROM lorebook_entry_revisions
      WHERE entry_id = ${entryId}
        AND id NOT IN (
          SELECT id FROM lorebook_entry_revisions
          WHERE entry_id = ${entryId}
          ORDER BY revision_no DESC
          LIMIT ${MAX_REVISIONS_PER_ENTRY}
        )
    `);
  }
}
