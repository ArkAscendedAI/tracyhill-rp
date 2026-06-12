import { and, desc, eq, sql } from "drizzle-orm";

import { campaigns, pipelineRuns, campaignVersions, lorebookEntries, lorebookEntryEmbeddings, lorebookActivationState, type DatabaseClient } from "@tracyhill-rp/db";

export class CampaignRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

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
    },
  ) {
    this.db.transaction((tx) => {
      tx.insert(campaignVersions).values(input.archive).run();
      tx.update(campaigns)
        .set({ systemPrompt: input.nextSystemPrompt, version: input.nextVersion, updatedAt: input.updatedAt })
        .where(and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId)))
        .run();
    });
  }

  reassignFolder(userId: string, folderId: string, nextFolderId: string | null) {
    this.db.update(campaigns).set({ folderId: nextFolderId }).where(and(eq(campaigns.userId, userId), eq(campaigns.folderId, folderId))).run();
  }

  deleteCampaign(userId: string, campaignId: string) {
    this.db.transaction((tx) => {
      tx.delete(pipelineRuns).where(and(eq(pipelineRuns.userId, userId), eq(pipelineRuns.campaignId, campaignId))).run();
      tx.delete(campaignVersions).where(and(eq(campaignVersions.userId, userId), eq(campaignVersions.campaignId, campaignId))).run();
      tx.delete(lorebookEntryEmbeddings).where(
        sql`${lorebookEntryEmbeddings.entryId} IN (SELECT id FROM lorebook_entries WHERE user_id = ${userId} AND campaign_id = ${campaignId})`
      ).run();
      tx.delete(lorebookActivationState).where(
        sql`${lorebookActivationState.entryId} IN (SELECT id FROM lorebook_entries WHERE user_id = ${userId} AND campaign_id = ${campaignId})`
      ).run();
      tx.delete(lorebookEntries).where(and(eq(lorebookEntries.userId, userId), eq(lorebookEntries.campaignId, campaignId))).run();
      tx.delete(campaigns).where(and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId))).run();
    });
  }
}
