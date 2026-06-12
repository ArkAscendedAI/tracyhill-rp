import { and, asc, eq, inArray } from "drizzle-orm";

import { messageAttachments, type DatabaseClient } from "@tracyhill-rp/db";

export class MessageAttachmentRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForSession(userId: string, sessionId: string) {
    return this.db.select().from(messageAttachments).where(and(eq(messageAttachments.userId, userId), eq(messageAttachments.sessionId, sessionId))).orderBy(asc(messageAttachments.createdAt)).all();
  }

  listForMessageIds(userId: string, sessionId: string, messageIds: string[]) {
    if (!messageIds.length) return [];
    return this.db.select().from(messageAttachments)
      .where(and(eq(messageAttachments.userId, userId), eq(messageAttachments.sessionId, sessionId), inArray(messageAttachments.messageId, messageIds)))
      .orderBy(asc(messageAttachments.createdAt))
      .all();
  }

  createAttachment(input: typeof messageAttachments.$inferInsert) {
    this.db.insert(messageAttachments).values(input).run();
  }

  deleteForMessageIds(userId: string, sessionId: string, messageIds: string[]) {
    if (!messageIds.length) return;
    this.db.delete(messageAttachments)
      .where(and(eq(messageAttachments.userId, userId), eq(messageAttachments.sessionId, sessionId), inArray(messageAttachments.messageId, messageIds)))
      .run();
  }

  deleteForSession(userId: string, sessionId: string) {
    this.db.delete(messageAttachments).where(and(eq(messageAttachments.userId, userId), eq(messageAttachments.sessionId, sessionId))).run();
  }
}
