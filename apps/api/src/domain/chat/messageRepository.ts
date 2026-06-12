import { and, asc, eq, gt, max, sql } from "drizzle-orm";

import { messages, type DatabaseClient } from "@tracyhill-rp/db";

export class MessageRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForSession(userId: string, sessionId: string) {
    return this.db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId))).orderBy(asc(messages.sortOrder)).all();
  }

  findById(userId: string, sessionId: string, messageId: string) {
    return this.db.select().from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
      .get();
  }


  listAfterSortOrder(userId: string, sessionId: string, sortOrder: number) {
    return this.db.select().from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), gt(messages.sortOrder, sortOrder)))
      .orderBy(asc(messages.sortOrder))
      .all();
  }

  createMessage(input: typeof messages.$inferInsert) {
    this.db.insert(messages).values(input).run();
  }

  /**
   * Insert at the session tail with the sortOrder allocated ATOMICALLY inside
   * the statement. Computing sortOrder from a pre-await snapshot let two
   * concurrent sends (or image-gen racing a stream, or a pending-merge racing
   * a GET) collide on the same sortOrder — breaking ordering, truncate, and
   * watermark locking. Returns the allocated sortOrder.
   */
  createMessageAtTail(input: Omit<typeof messages.$inferInsert, "sortOrder">): number {
    this.db.run(sql`
      INSERT INTO messages (id, session_id, user_id, role, content, thinking, model_id,
        input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
        stop_reason, stop_details_json, fast_mode, served_model, scene_data,
        scene_validator_json, scene_resolution_choice, overhead_json, sort_order, created_at, updated_at)
      VALUES (${input.id}, ${input.sessionId}, ${input.userId}, ${input.role}, ${input.content},
        ${input.thinking ?? null}, ${input.modelId ?? null},
        ${input.inputTokens ?? null}, ${input.outputTokens ?? null}, ${input.totalTokens ?? null},
        ${input.cacheReadTokens ?? null}, ${input.cacheWriteTokens ?? null},
        ${input.stopReason ?? null}, ${input.stopDetailsJson ?? null}, ${input.fastMode ? 1 : 0},
        ${input.servedModel ?? null}, ${input.sceneData ?? null}, ${input.sceneValidatorJson ?? null},
        ${input.sceneResolutionChoice ?? null}, ${input.overheadJson ?? null},
        (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM messages WHERE session_id = ${input.sessionId} AND user_id = ${input.userId}),
        ${input.createdAt}, ${input.updatedAt})
    `);
    const row = this.db.select({ sortOrder: messages.sortOrder }).from(messages)
      .where(and(eq(messages.id, input.id), eq(messages.userId, input.userId))).get();
    return row?.sortOrder ?? 0;
  }

  createMessageIfMissing(input: typeof messages.$inferInsert) {
    this.db.insert(messages).values(input).onConflictDoNothing().run();
  }

  updateMessage(userId: string, sessionId: string, messageId: string, input: Partial<typeof messages.$inferInsert>) {
    this.db.update(messages)
      .set(input)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
      .run();
  }

  deleteMessage(userId: string, sessionId: string, messageId: string) {
    this.db.delete(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
      .run();
  }

  deleteAfterSortOrder(userId: string, sessionId: string, sortOrder: number) {
    this.db.delete(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId), gt(messages.sortOrder, sortOrder)))
      .run();
  }

  deleteForSession(userId: string, sessionId: string) {
    this.db.delete(messages).where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId))).run();
  }

  countForSession(userId: string, sessionId: string): number {
    const row = this.db.select({ count: sql<number>`count(*)` }).from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId))).get();
    return row?.count ?? 0;
  }

  nextSortOrder(userId: string, sessionId: string) {
    const row = this.db.select({ maxSort: max(messages.sortOrder) }).from(messages).where(and(eq(messages.userId, userId), eq(messages.sessionId, sessionId))).get();
    return (row?.maxSort ?? -1) + 1;
  }

  searchFts(userId: string, query: string, limit = 25) {
        // Replace punctuation with SPACE (not ""): FTS5's unicode61 tokenizer
    // indexes "self-aware" as self+aware, so collapsing to "selfaware" matched
    // nothing; \p{L}\p{N} keeps non-ASCII queries (Cyrillic/CJK/accents) alive.
    const ftsQuery = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(" ");
    if (!ftsQuery) return [];
    return this.db.all<{
      id: string;
      sessionId: string;
      userId: string;
      role: string;
      content: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    }>(sql`
      SELECT m.id, m.session_id as "sessionId", m.user_id as "userId", m.role, m.content,
             m.sort_order as "sortOrder", m.created_at as "createdAt", m.updated_at as "updatedAt"
      FROM messages m
      JOIN messages_fts ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ${ftsQuery}
        AND m.user_id = ${userId}
      ORDER BY rank
      LIMIT ${limit}
    `);
  }
}
