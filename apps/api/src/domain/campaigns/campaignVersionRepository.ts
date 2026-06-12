import { and, desc, eq, isNull } from "drizzle-orm";

import { campaignVersions, type DatabaseClient } from "@tracyhill-rp/db";

export class CampaignVersionRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForCampaign(userId: string, campaignId: string) {
    return this.db.select().from(campaignVersions)
      .where(and(eq(campaignVersions.userId, userId), eq(campaignVersions.campaignId, campaignId)))
      .orderBy(desc(campaignVersions.createdAt), desc(campaignVersions.version))
      .all();
  }

  /**
   * Looks up the canonical archived copy for a given version. Only unlabeled rows
   * count as canonical — labeled rows (e.g. pre-restore snapshots) share the same
   * version number as the live state they captured but are not restore targets.
   */
  findByVersion(userId: string, campaignId: string, version: number) {
    return this.db.select().from(campaignVersions)
      .where(and(
        eq(campaignVersions.userId, userId),
        eq(campaignVersions.campaignId, campaignId),
        eq(campaignVersions.version, version),
        isNull(campaignVersions.label),
      ))
      .orderBy(desc(campaignVersions.createdAt))
      .get();
  }

  createVersion(input: typeof campaignVersions.$inferInsert) {
    this.db.insert(campaignVersions).values(input).run();
  }

  deleteForCampaign(userId: string, campaignId: string) {
    this.db.delete(campaignVersions)
      .where(and(eq(campaignVersions.userId, userId), eq(campaignVersions.campaignId, campaignId)))
      .run();
  }
}
