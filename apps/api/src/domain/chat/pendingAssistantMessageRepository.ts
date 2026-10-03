import { and, asc, eq } from "drizzle-orm";

import { pendingAssistantMessages, type DatabaseClient } from "@tracyhill-rp/db";

export class PendingAssistantMessageRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForSession(userId: string, sessionId: string) {
    return this.db.select().from(pendingAssistantMessages)
      .where(and(eq(pendingAssistantMessages.userId, userId), eq(pendingAssistantMessages.sessionId, sessionId)))
      .orderBy(asc(pendingAssistantMessages.createdAt), asc(pendingAssistantMessages.id))
      .all();
  }

  createPendingMessage(input: typeof pendingAssistantMessages.$inferInsert) {
    this.db.insert(pendingAssistantMessages).values(input).run();
  }

  deletePendingMessage(userId: string, sessionId: string, messageId: string) {
    this.db.delete(pendingAssistantMessages)
      .where(and(eq(pendingAssistantMessages.userId, userId), eq(pendingAssistantMessages.sessionId, sessionId), eq(pendingAssistantMessages.id, messageId)))
      .run();
  }

  deleteForSession(userId: string, sessionId: string) {
    this.db.delete(pendingAssistantMessages)
      .where(and(eq(pendingAssistantMessages.userId, userId), eq(pendingAssistantMessages.sessionId, sessionId)))
      .run();
  }

  transact(fn: () => void) {
    this.db.transaction(() => { fn(); });
  }
}
