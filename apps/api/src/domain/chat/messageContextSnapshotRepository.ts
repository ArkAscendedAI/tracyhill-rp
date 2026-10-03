import { and, desc, eq, sql } from "drizzle-orm";

import { MESSAGE_CONTEXT_SNAPSHOTS_PER_SESSION, messageContextSnapshotSchema, type MessageContextSnapshot } from "@tracyhill-rp/contracts";
import { messageContextSnapshots, messages, type DatabaseClient } from "@tracyhill-rp/db";

/**
 * Per-reply context snapshots (migration 0089). A chat turn's
 * `response.context` payload used to exist only in the browser's stream state;
 * the chat turn now stores it against the assistant reply it produced, and
 * GET /api/chat/sessions/:sessionId/messages/:messageId/context reads it back.
 * Every read and write is scoped to the owning user and session.
 */
export class MessageContextSnapshotRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  /**
   * Stores `snapshot` for the assistant reply `messageId`, replacing an earlier
   * snapshot of that reply (a continue rewrites its target's), then deletes the
   * session's rows beyond the newest MESSAGE_CONTEXT_SNAPSHOTS_PER_SESSION by
   * created_at (ties by message id), all in one transaction. The snapshot is
   * parsed through the contract first, so a stored row always reads back.
   *
   * The `created_at` column holds the snapshot's `createdAt` as an ISO 8601 UTC
   * instant, because the prune compares it as text: "12:00+02:00" would sort
   * after "11:00Z" although it is earlier. The JSON keeps the caller's string.
   *
   * Throws, and writes nothing, when the snapshot fails the contract, when its
   * `createdAt` is not a date, or when `messageId` is not an assistant reply of
   * this user's session (including a reply that is still a pending row: the
   * table's foreign key needs the `messages` row). The chat turn records a throw
   * as a warn event and carries on.
   */
  save(userId: string, sessionId: string, messageId: string, snapshot: MessageContextSnapshot): void {
    const parsed = messageContextSnapshotSchema.parse(snapshot);
    const instant = new Date(parsed.createdAt);
    if (!Number.isFinite(instant.getTime())) {
      throw new Error(`context snapshot not stored: createdAt "${parsed.createdAt}" is not a date`);
    }
    const createdAt = instant.toISOString();
    const snapshotJson = JSON.stringify(parsed);
    this.db.transaction((tx) => {
      const reply = tx.select({ role: messages.role }).from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId), eq(messages.userId, userId)))
        .get();
      if (reply?.role !== "assistant") {
        throw new Error(`context snapshot not stored: ${messageId} is not an assistant reply in session ${sessionId}`);
      }
      tx.insert(messageContextSnapshots)
        .values({ messageId, userId, sessionId, createdAt, snapshotJson })
        .onConflictDoUpdate({ target: messageContextSnapshots.messageId, set: { createdAt, snapshotJson } })
        .run();
      tx.run(sql`
        DELETE FROM message_context_snapshots
        WHERE session_id = ${sessionId}
          AND message_id NOT IN (
            SELECT message_id FROM message_context_snapshots
            WHERE session_id = ${sessionId}
            ORDER BY created_at DESC, message_id DESC
            LIMIT ${MESSAGE_CONTEXT_SNAPSHOTS_PER_SESSION}
          )
      `);
    });
  }

  /** The reply's snapshot, or null when it has none. A stored row that fails the
   *  contract throws (the route answers 500) rather than reading as "none". */
  get(userId: string, sessionId: string, messageId: string): MessageContextSnapshot | null {
    const row = this.db.select({ snapshotJson: messageContextSnapshots.snapshotJson })
      .from(messageContextSnapshots)
      .where(and(
        eq(messageContextSnapshots.messageId, messageId),
        eq(messageContextSnapshots.sessionId, sessionId),
        eq(messageContextSnapshots.userId, userId),
      ))
      .get();
    return row ? messageContextSnapshotSchema.parse(JSON.parse(row.snapshotJson)) : null;
  }

  /** Ids of the session's replies that have a snapshot, newest first (for the
   *  message DTOs' `hasContextSnapshot`). At most MESSAGE_CONTEXT_SNAPSHOTS_PER_SESSION. */
  listMessageIdsForSession(userId: string, sessionId: string): string[] {
    return this.db.select({ messageId: messageContextSnapshots.messageId })
      .from(messageContextSnapshots)
      .where(and(eq(messageContextSnapshots.userId, userId), eq(messageContextSnapshots.sessionId, sessionId)))
      .orderBy(desc(messageContextSnapshots.createdAt), desc(messageContextSnapshots.messageId))
      .all()
      .map((row) => row.messageId);
  }
}
