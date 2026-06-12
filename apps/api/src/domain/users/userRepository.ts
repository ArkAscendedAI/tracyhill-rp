import { eq, sql } from "drizzle-orm";

import {
  campaignVersions,
  campaigns,
  characterAttire,
  characterAttireHistory,
  customEndpoints,
  folders,
  generatedImages,
  lorebookEntries,
  lorebookEntryEmbeddings,
  lorebookActivationState,
  messageAttachments,
  messages,
  pendingAssistantMessages,
  pipelineRunArtifacts,
  pipelineRuns,
  providerKeys,
  promptTemplates,
  sessions,
  userPreferences,
  users,
  type DatabaseClient,
  wizardRuns,
  wizardTemplates,
  systemEvents,
} from "@tracyhill-rp/db";

export class UserRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  findByUsername(username: string) {
    // Case-insensitive: "James" and "james" must resolve to the same account —
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

  updateRole(userId: string, role: "admin" | "user", updatedAt: string) {
    this.db.update(users).set({
      role,
      updatedAt,
    }).where(eq(users.id, userId)).run();
  }

  deleteAccount(userId: string) {
    this.db.transaction((tx) => {
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
      tx.delete(campaignVersions).where(eq(campaignVersions.userId, userId)).run();
      tx.delete(characterAttireHistory).where(
        sql`${characterAttireHistory.campaignId} IN (SELECT id FROM campaigns WHERE user_id = ${userId})`
      ).run();
      tx.delete(characterAttire).where(
        sql`${characterAttire.campaignId} IN (SELECT id FROM campaigns WHERE user_id = ${userId})`
      ).run();
      tx.delete(campaigns).where(eq(campaigns.userId, userId)).run();
      tx.delete(customEndpoints).where(eq(customEndpoints.userId, userId)).run();
      // pipeline_run_artifacts has no user_id column; delete via subquery BEFORE pipeline_runs
      tx.delete(pipelineRunArtifacts).where(
        sql`${pipelineRunArtifacts.runId} IN (SELECT id FROM pipeline_runs WHERE user_id = ${userId})`
      ).run();
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
