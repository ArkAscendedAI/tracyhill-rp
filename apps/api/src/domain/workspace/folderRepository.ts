import { and, asc, eq } from "drizzle-orm";

import { folders, type DatabaseClient } from "@tracyhill-rp/db";

export class FolderRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForUser(userId: string) {
    return this.db.select().from(folders).where(eq(folders.userId, userId)).orderBy(asc(folders.position), asc(folders.name)).all();
  }

  findById(userId: string, folderId: string) {
    return this.db.select().from(folders).where(and(eq(folders.userId, userId), eq(folders.id, folderId))).get();
  }

  createFolder(input: typeof folders.$inferInsert) {
    this.db.insert(folders).values(input).run();
  }

  updateFolder(userId: string, folderId: string, input: Partial<typeof folders.$inferInsert>) {
    this.db.update(folders).set(input).where(and(eq(folders.userId, userId), eq(folders.id, folderId))).run();
  }

  reassignParent(userId: string, folderId: string, parentId: string | null, updatedAt: string) {
    this.db.update(folders)
      .set({ parentId, updatedAt })
      .where(and(eq(folders.userId, userId), eq(folders.parentId, folderId)))
      .run();
  }

  deleteFolder(userId: string, folderId: string) {
    this.db.delete(folders).where(and(eq(folders.userId, userId), eq(folders.id, folderId))).run();
  }

  nextPosition(userId: string) {
    const all = this.listForUser(userId);
    return all.reduce((max, folder) => Math.max(max, folder.position), -1) + 1;
  }

  transact(fn: () => void) {
    this.db.transaction(() => { fn(); });
  }
}
