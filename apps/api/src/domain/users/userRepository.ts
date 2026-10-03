import { eq, sql } from "drizzle-orm";

import {
  activeThreats,
  auditFindings,
  campaignConsequences,
  campaignVersions,
  campaigns,
  characterAttire,
  characterAttireHistory,
  characterDrives,
  characterDrivesHistory,
  customEndpoints,
  folders,
  generatedImages,
  lorebookEntries,
  lorebookEntryEmbeddings,
  lorebookEntryRevisions,
  lorebookActivationState,
  messageAttachments,
  messages,
  pendingAssistantMessages,
  pipelineRuns,
  providerKeys,
  promptTemplates,
  scheduledBeats,
  sessions,
  threatClocks,
  userPreferences,
  users,
  type DatabaseClient,
  wizardRuns,
  wizardTemplates,
  systemEvents,
} from "@tracyhill-rp/db";

/**
 * Deletes every campaign the user owns through the campaign SERVICE path
 * (createApp wires `campaignService.delete` per campaign). Runs INSIDE the
 * account-deletion transaction, so anything that path grows to cascade (the
 * adversarial-world tables, audit findings, revisions, artifacts) is inherited
 * here for free instead of being re-listed by hand.
 */
export type UserCampaignCascade = (userId: string) => void;

export class UserRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  findByUsername(username: string) {
    // Case-insensitive: "Corin" and "corin" must resolve to the same account —
    // the BINARY-collated unique index allowed lookalike duplicates and
    // "can't log in" confusion. Exact match wins if (legacy) duplicates exist.
    const exact = this.db.select().from(users).where(eq(users.username, username)).get();
    if (exact) return exact;
    return this.db.select().from(users).where(sql`${users.username} = ${username} COLLATE NOCASE`).get();
  }

  findByEmail(email: string) {
    return this.db.select().from(users).where(eq(users.email, email)).get();
  }

  findById(id: string) {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  listAll() {
    return this.db.select().from(users).all();
  }

  countUsers() {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(users).get();
    return row?.count ?? 0;
  }

  countAdmins() {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.role, "admin")).get();
    return row?.count ?? 0;
  }

  createUser(input: typeof users.$inferInsert) {
    this.db.insert(users).values(input).run();
  }

  /** First-run setup: inserts the account only while the table is empty, in one transaction. False when one exists. */
  createFirstUser(input: typeof users.$inferInsert) {
    return this.db.transaction((tx) => {
      const row = tx.select({ count: sql<number>`count(*)` }).from(users).get();
      if ((row?.count ?? 0) > 0) return false;
      tx.insert(users).values(input).run();
      return true;
    });
  }

  updatePasswordHash(userId: string, passwordHash: string, updatedAt: string) {
    this.db.update(users).set({
      passwordHash,
      updatedAt,
    }).where(eq(users.id, userId)).run();
  }

  updateTrustedDevices(userId: string, trustedDevices: string, updatedAt: string) {
    this.db.update(users).set({
      trustedDevices,
      updatedAt,
    }).where(eq(users.id, userId)).run();
  }

  updateEmail(userId: string, email: string, emailVerified: 0 | 1, updatedAt: string) {
    this.db.update(users).set({
      email,
      emailVerified,
      updatedAt,
    }).where(eq(users.id, userId)).run();
  }

  updateRole(userId: string, role: "admin" | "user", updatedAt: string) {
    this.db.update(users).set({
      role,
      updatedAt,
    }).where(eq(users.id, userId)).run();
  }

  deleteAccount(userId: string, cascadeCampaigns?: UserCampaignCascade) {
    this.db.transaction((tx) => {
      // Campaign-scoped tables first, by subquery, while the campaigns rows
      // still exist. The Drizzle schema declares no foreign keys and the raw
      // migrations for these tables carry no REFERENCES clause, so nothing
      // fails when they are skipped: the rows just outlive the user (eight
      // tables were orphaned this way, two of them keyed by user_id).
      const ownedCampaigns = sql`(SELECT id FROM campaigns WHERE user_id = ${userId})`;
      tx.delete(activeThreats).where(sql`${activeThreats.campaignId} IN ${ownedCampaigns}`).run();
      tx.delete(threatClocks).where(sql`${threatClocks.campaignId} IN ${ownedCampaigns}`).run();
      tx.delete(campaignConsequences).where(sql`${campaignConsequences.campaignId} IN ${ownedCampaigns}`).run();
      tx.delete(scheduledBeats).where(sql`${scheduledBeats.campaignId} IN ${ownedCampaigns}`).run();
      tx.delete(characterDrivesHistory).where(sql`${characterDrivesHistory.campaignId} IN ${ownedCampaigns}`).run();
      tx.delete(characterDrives).where(sql`${characterDrives.campaignId} IN ${ownedCampaigns}`).run();
      tx.delete(characterAttireHistory).where(sql`${characterAttireHistory.campaignId} IN ${ownedCampaigns}`).run();
      tx.delete(characterAttire).where(sql`${characterAttire.campaignId} IN ${ownedCampaigns}`).run();
      // Then the campaign service's own delete path per campaign (same SQLite
      // connection, so it joins this transaction as a savepoint). Anything it
      // learns to cascade later (as it once learned the adversarial-world,
      // findings, revisions and artifacts tables) lands in the account path
      // automatically.
      cascadeCampaigns?.(userId);
      tx.delete(generatedImages).where(eq(generatedImages.userId, userId)).run();
      tx.delete(systemEvents).where(eq(systemEvents.userId, userId)).run();
      tx.delete(messageAttachments).where(eq(messageAttachments.userId, userId)).run();
      tx.delete(messages).where(eq(messages.userId, userId)).run();
      tx.delete(pendingAssistantMessages).where(eq(pendingAssistantMessages.userId, userId)).run();
      tx.delete(lorebookActivationState).where(
        sql`${lorebookActivationState.sessionId} IN (SELECT id FROM sessions WHERE user_id = ${userId})`
      ).run();
      tx.delete(sessions).where(eq(sessions.userId, userId)).run();
      tx.delete(lorebookEntryEmbeddings).where(eq(lorebookEntryEmbeddings.userId, userId)).run();
      tx.delete(lorebookEntries).where(eq(lorebookEntries.userId, userId)).run();
      // Revision snapshots hold full lorebook content and are user_id-keyed;
      // deleted AFTER the campaign path because lorebook deletes there may
      // snapshot a pre-write row into this table first.
      tx.delete(lorebookEntryRevisions).where(eq(lorebookEntryRevisions.userId, userId)).run();
      tx.delete(auditFindings).where(eq(auditFindings.userId, userId)).run();
      tx.delete(campaignVersions).where(eq(campaignVersions.userId, userId)).run();
      tx.delete(campaigns).where(eq(campaigns.userId, userId)).run();
      tx.delete(customEndpoints).where(eq(customEndpoints.userId, userId)).run();
      tx.delete(pipelineRuns).where(eq(pipelineRuns.userId, userId)).run();
      tx.delete(providerKeys).where(eq(providerKeys.userId, userId)).run();
      tx.delete(promptTemplates).where(eq(promptTemplates.userId, userId)).run();
      tx.delete(wizardRuns).where(eq(wizardRuns.userId, userId)).run();
      tx.delete(wizardTemplates).where(eq(wizardTemplates.userId, userId)).run();
      tx.delete(folders).where(eq(folders.userId, userId)).run();
      tx.delete(userPreferences).where(eq(userPreferences.userId, userId)).run();
      tx.delete(users).where(eq(users.id, userId)).run();
      // Note: audit_events.actor_user_id is intentionally NOT cascaded -- audit log
      // retention outlives the actor. The auditRepository.listRecent leftJoin
      // already handles null actorUsername after deletion.
      // Note: http_sessions cleanup happens at the controller layer via
      // sessionStore.destroyByUserId() (authController.executeAccountDeletion and
      // adminService.deleteUser), because the session store owns its own connection
      // and stores userId inside a JSON blob that can't be queried efficiently here.
    });
  }
}
