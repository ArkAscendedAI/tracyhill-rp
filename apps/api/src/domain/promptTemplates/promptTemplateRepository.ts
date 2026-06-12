import { and, desc, eq } from "drizzle-orm";

import { promptTemplates, type DatabaseClient } from "@tracyhill-rp/db";

export class PromptTemplateRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listByUser(userId: string) {
    return this.db.select().from(promptTemplates).where(eq(promptTemplates.userId, userId)).orderBy(desc(promptTemplates.updatedAt)).all();
  }

  findByUser(userId: string, templateId: string) {
    return this.db.select().from(promptTemplates).where(and(eq(promptTemplates.userId, userId), eq(promptTemplates.id, templateId))).get();
  }

  create(input: typeof promptTemplates.$inferInsert) {
    this.db.insert(promptTemplates).values(input).run();
    return this.findByUser(input.userId, input.id)!;
  }

  updateForUser(userId: string, templateId: string, input: Partial<typeof promptTemplates.$inferInsert>) {
    this.db.update(promptTemplates).set(input).where(and(eq(promptTemplates.userId, userId), eq(promptTemplates.id, templateId))).run();
    return this.findByUser(userId, templateId) ?? null;
  }

  deleteForUser(userId: string, templateId: string) {
    this.db.delete(promptTemplates).where(and(eq(promptTemplates.userId, userId), eq(promptTemplates.id, templateId))).run();
  }
}
