import { and, desc, eq, isNull, not, sql } from "drizzle-orm";

import { sessions, type DatabaseClient } from "@tracyhill-rp/db";

export class SessionRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForUser(userId: string) {
    return this.db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.updatedAt), desc(sessions.createdAt)).all();
  }

  listActiveForUser(userId: string) {
    return this.db.select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.deletedAt))).orderBy(desc(sessions.updatedAt), desc(sessions.createdAt)).all();
  }

  listDeletedForUser(userId: string) {
    return this.db.select().from(sessions).where(and(eq(sessions.userId, userId), not(isNull(sessions.deletedAt)))).orderBy(desc(sql`coalesce(${sessions.deletedAt}, ${sessions.updatedAt})`), desc(sessions.updatedAt)).all();
  }

  listForCampaign(userId: string, campaignId: string) {
    return this.db.select().from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)))
      .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt))
      .all();
  }

  /** The campaign's most recently touched live session — the post-0077
   *  authority for campaign-scoped reads of per-session dials (embedding model
   *  for manual lorebook writes, the coverage monitor, the reembed tool). Same
   *  "newest by updated_at" rule workspaceService uses to clone dials onto a
   *  new session. Deleted sessions are excluded. */
  findNewestForCampaign(userId: string, campaignId: string) {
    return this.db.select({ id: sessions.id, contextOverridesJson: sessions.contextOverridesJson, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.campaignId, campaignId), isNull(sessions.deletedAt)))
      .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt))
      .get();
  }

  findById(userId: string, sessionId: string) {
    return this.db.select().from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId))).get();
  }

  findActiveById(userId: string, sessionId: string) {
    return this.db.select().from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId), isNull(sessions.deletedAt))).get();
  }

  findActiveWizardForUser(userId: string) {
    return this.db.select().from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.sessionType, "wizard"), isNull(sessions.deletedAt)))
      .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt))
      .get();
  }

  createSession(input: typeof sessions.$inferInsert) {
    this.db.insert(sessions).values(input).run();
  }

  updateSession(userId: string, sessionId: string, input: Partial<typeof sessions.$inferInsert>) {
    this.db.update(sessions).set(input).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId))).run();
  }

  reassignFolder(userId: string, folderId: string, nextFolderId: string | null, updatedAt: string) {
    this.db.update(sessions).set({ folderId: nextFolderId, updatedAt }).where(and(eq(sessions.userId, userId), eq(sessions.folderId, folderId))).run();
  }

  softDeleteSession(userId: string, sessionId: string, deletedAt: string) {
    this.db.update(sessions).set({ deletedAt, updatedAt: deletedAt }).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId))).run();
  }

  restoreSession(userId: string, sessionId: string, restoredAt: string) {
    this.db.update(sessions).set({ deletedAt: null, updatedAt: restoredAt }).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId))).run();
  }

  deleteSession(userId: string, sessionId: string) {
    this.db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId))).run();
  }

  /** Detach every session linked to a deleted campaign (dangling campaignId
   *  made chatService take the campaign-flavored path with campaign=null). */
  clearCampaignForSessions(userId: string, campaignId: string) {
    this.db.update(sessions)
      .set({ campaignId: null, updatedAt: new Date().toISOString() })
      .where(and(eq(sessions.userId, userId), eq(sessions.campaignId, campaignId)))
      .run();
  }

  // Default char thresholds per kind (mirror contextEngine DEFAULTS). Used when
  // a caller doesn't supply a campaign-resolved threshold.
  private static readonly DEFAULT_THRESHOLD = {
    rolling_diff: 17000,
    repetition_detection: 50000,
    sysprompt_audit: 100000,
  } as const;

  /**
   * F (counters): decrement the kind's char counter by its threshold instead of
   * zeroing it. Zeroing discarded the content that accumulated DURING the run
   * (the run only audited up to its start watermark), so a busy session could
   * starve the next enqueue. `MAX(0, chars - threshold)` preserves the overflow
   * so the next threshold crossing fires on schedule.
   */
  resetPipelineCounter(sessionId: string, kind: "rolling_diff" | "repetition_detection" | "sysprompt_audit", threshold?: number) {
    const t = threshold ?? SessionRepository.DEFAULT_THRESHOLD[kind];
    const column = kind === "rolling_diff" ? sessions.pipelineCharsSinceRollingDiff
      : kind === "repetition_detection" ? sessions.pipelineCharsSinceRepetition
      : sessions.pipelineCharsSinceSysprompt;
    const update = kind === "rolling_diff" ? { pipelineCharsSinceRollingDiff: sql`MAX(0, ${column} - ${t})` }
      : kind === "repetition_detection" ? { pipelineCharsSinceRepetition: sql`MAX(0, ${column} - ${t})` }
      : { pipelineCharsSinceSysprompt: sql`MAX(0, ${column} - ${t})` };
    this.db.update(sessions).set(update).where(eq(sessions.id, sessionId)).run();
  }
}
