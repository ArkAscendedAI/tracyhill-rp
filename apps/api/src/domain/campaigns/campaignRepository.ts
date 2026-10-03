import { and, desc, eq, or, sql } from "drizzle-orm";

import {
  activeThreats,
  auditFindings,
  campaignConsequences,
  campaigns,
  campaignVersions,
  characterAttire,
  characterAttireHistory,
  characterDrives,
  characterDrivesHistory,
  lorebookActivationState,
  lorebookEntries,
  lorebookEntryEmbeddings,
  lorebookEntryRevisions,
  pipelineRuns,
  scheduledBeats,
  threatClocks,
  type DatabaseClient,
} from "@tracyhill-rp/db";

export class CampaignRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  transact<T>(fn: () => T): T { return this.db.transaction(fn); }

  listForUser(userId: string) {
    return this.db.select().from(campaigns).where(eq(campaigns.userId, userId)).orderBy(desc(campaigns.updatedAt), desc(campaigns.createdAt)).all();
  }

  findById(userId: string, campaignId: string) {
    return this.db.select().from(campaigns).where(and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId))).get();
  }

  createCampaign(input: typeof campaigns.$inferInsert) {
    this.db.insert(campaigns).values(input).run();
  }

  updateCampaign(userId: string, campaignId: string, input: Partial<typeof campaigns.$inferInsert>) {
    this.db.update(campaigns).set(input).where(and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId))).run();
  }

  /** Living World — advance the in-world simulation watermark (any-owner write:
   * callers have already scoped the campaign). */
  updateWorldClock(campaignId: string, worldClockJson: string) {
    this.db.update(campaigns).set({ worldClockJson, updatedAt: new Date().toISOString() }).where(eq(campaigns.id, campaignId)).run();
  }

  updateDramatistState(campaignId: string, dramatistStateJson: string) {
    this.db.update(campaigns).set({ dramatistStateJson, updatedAt: new Date().toISOString() }).where(eq(campaigns.id, campaignId)).run();
  }

  /**
   * Archive the prior version row AND bump the live campaign in a single
   * transaction. Used by syspromptAuditWorker so we can't end up with an
   * orphan version row pointing at the wrong prompt when the second write
   * fails.
   */
  bumpVersionWithArchive(
    userId: string,
    campaignId: string,
    input: {
      archive: typeof campaignVersions.$inferInsert;
      nextSystemPrompt: string;
      nextVersion: number;
      updatedAt: string;
      // TOCTOU guard: when supplied, the bump only applies if the live
      // campaign is still at expectedVersion (and, if given, expectedPrompt).
      // A concurrent edit changes the version, the guarded UPDATE matches zero
      // rows, and we roll back the archive insert so nothing is written.
      expectedVersion?: number;
      expectedPrompt?: string;
    },
  ): boolean {
    let applied = false;
    this.db.transaction((tx) => {
      tx.insert(campaignVersions).values(input.archive).run();
      const conds = [eq(campaigns.userId, userId), eq(campaigns.id, campaignId)];
      if (input.expectedVersion != null) conds.push(eq(campaigns.version, input.expectedVersion));
      if (input.expectedPrompt != null) conds.push(eq(campaigns.systemPrompt, input.expectedPrompt));
      const result = tx.update(campaigns)
        .set({ systemPrompt: input.nextSystemPrompt, version: input.nextVersion, updatedAt: input.updatedAt })
        .where(and(...conds))
        .run();
      applied = result.changes > 0;
      // Concurrent edit ⇒ the guard matched no rows. Undo the archive row so we
      // don't leave an orphan version pointing at a prompt we never wrote.
      if (!applied) {
        tx.delete(campaignVersions).where(eq(campaignVersions.id, input.archive.id)).run();
      }
    });
    return applied;
  }

  reassignFolder(userId: string, folderId: string, nextFolderId: string | null) {
    this.db.update(campaigns).set({ folderId: nextFolderId }).where(and(eq(campaigns.userId, userId), eq(campaigns.folderId, folderId))).run();
  }

  /**
   * Delete EVERY row the campaign owns, in one transaction. The schema declares
   * no foreign keys for these tables, so `foreign_keys=ON` cascades nothing —
   * this list IS the cascade. It used to stop at runs/versions/entries and left
   * `audit_findings`, `lorebook_entry_revisions` (full content snapshots) and the
   * 0078 adversarial-world tables orphaned forever (the runs' artifacts table
   * itself was dropped by 0083), while attire/drives/beats were swept by separate
   * statements OUTSIDE the transaction. Logs
   * (`audit_events`, `system_events`) deliberately keep their campaign_id.
   * `alsoInside` runs first, inside the same transaction, for the caller's own
   * related writes (session unlinking) — it shares this connection, so its
   * statements commit or roll back with the rest.
   */
  deleteCampaign(userId: string, campaignId: string, alsoInside?: () => void) {
    this.db.transaction((tx) => {
      alsoInside?.();
      const entryIds = sql`(SELECT id FROM lorebook_entries WHERE user_id = ${userId} AND campaign_id = ${campaignId})`;
      // Children before parents: the sub-selects read the parent rows.
      tx.delete(pipelineRuns).where(and(eq(pipelineRuns.userId, userId), eq(pipelineRuns.campaignId, campaignId))).run();
      tx.delete(auditFindings).where(eq(auditFindings.campaignId, campaignId)).run();
      tx.delete(campaignVersions).where(and(eq(campaignVersions.userId, userId), eq(campaignVersions.campaignId, campaignId))).run();
      // Revisions carry campaign_id since 0064 but older rows may only know
      // their entry; match either way.
      tx.delete(lorebookEntryRevisions).where(or(
        eq(lorebookEntryRevisions.campaignId, campaignId),
        sql`${lorebookEntryRevisions.entryId} IN ${entryIds}`,
      )).run();
      tx.delete(lorebookEntryEmbeddings).where(or(
        eq(lorebookEntryEmbeddings.campaignId, campaignId),
        sql`${lorebookEntryEmbeddings.entryId} IN ${entryIds}`,
      )).run();
      tx.delete(lorebookActivationState).where(sql`${lorebookActivationState.entryId} IN ${entryIds}`).run();
      tx.delete(lorebookEntries).where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId))).run();
      tx.delete(characterAttireHistory).where(eq(characterAttireHistory.campaignId, campaignId)).run();
      tx.delete(characterAttire).where(eq(characterAttire.campaignId, campaignId)).run();
      tx.delete(characterDrivesHistory).where(eq(characterDrivesHistory.campaignId, campaignId)).run();
      tx.delete(characterDrives).where(eq(characterDrives.campaignId, campaignId)).run();
      tx.delete(scheduledBeats).where(eq(scheduledBeats.campaignId, campaignId)).run();
      tx.delete(activeThreats).where(eq(activeThreats.campaignId, campaignId)).run();
      tx.delete(campaignConsequences).where(eq(campaignConsequences.campaignId, campaignId)).run();
      tx.delete(threatClocks).where(eq(threatClocks.campaignId, campaignId)).run();
      tx.delete(campaigns).where(and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId))).run();
    });
  }
}
