import { and, eq, inArray } from "drizzle-orm";

import { generatedImages, type DatabaseClient } from "@tracyhill-rp/db";

export class GeneratedImageRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForUser(userId: string) {
    return this.db.select().from(generatedImages).where(eq(generatedImages.userId, userId)).all();
  }

  listAll() {
    return this.db.select().from(generatedImages).all();
  }

  listForSession(userId: string, sessionId: string) {
    return this.db.select().from(generatedImages).where(and(eq(generatedImages.userId, userId), eq(generatedImages.sessionId, sessionId))).all();
  }

  listForMessageIds(userId: string, sessionId: string, messageIds: string[]) {
    if (!messageIds.length) return [];
    return this.db.select().from(generatedImages)
      .where(and(eq(generatedImages.userId, userId), eq(generatedImages.sessionId, sessionId), inArray(generatedImages.messageId, messageIds)))
      .all();
  }

  findById(userId: string, imageId: string) {
    return this.db.select().from(generatedImages).where(and(eq(generatedImages.userId, userId), eq(generatedImages.id, imageId))).get();
  }

  createImage(input: typeof generatedImages.$inferInsert) {
    this.db.insert(generatedImages).values(input).run();
  }

  deleteForMessageIds(userId: string, sessionId: string, messageIds: string[]) {
    if (!messageIds.length) return;
    this.db.delete(generatedImages)
      .where(and(eq(generatedImages.userId, userId), eq(generatedImages.sessionId, sessionId), inArray(generatedImages.messageId, messageIds)))
      .run();
  }

  deleteForSession(userId: string, sessionId: string) {
    this.db.delete(generatedImages).where(and(eq(generatedImages.userId, userId), eq(generatedImages.sessionId, sessionId))).run();
  }

  deleteAll() {
    this.db.delete(generatedImages).run();
  }
}
