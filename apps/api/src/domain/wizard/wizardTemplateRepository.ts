import { eq } from "drizzle-orm";

import { wizardTemplates, type DatabaseClient } from "@tracyhill-rp/db";

import { getWizardTemplateDefaults } from "./wizardDefaults";

export class WizardTemplateRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  findByUser(userId: string) {
    return this.db.select().from(wizardTemplates).where(eq(wizardTemplates.userId, userId)).get();
  }

  ensureForUser(userId: string, now: string) {
    const existing = this.findByUser(userId);
    if (existing) {
      if (!existing.exampleSystemPrompt) {
        const defaults = getWizardTemplateDefaults();
        this.updateForUser(userId, { ...defaults, updatedAt: now });
        return this.findByUser(userId)!;
      }
      return existing;
    }
    const defaults = getWizardTemplateDefaults();
    this.db.insert(wizardTemplates).values({
      userId,
      ...defaults,
      updatedAt: now,
    }).run();
    return this.findByUser(userId)!;
  }

  updateForUser(userId: string, input: Partial<typeof wizardTemplates.$inferInsert>) {
    this.db.update(wizardTemplates).set(input).where(eq(wizardTemplates.userId, userId)).run();
  }
}
