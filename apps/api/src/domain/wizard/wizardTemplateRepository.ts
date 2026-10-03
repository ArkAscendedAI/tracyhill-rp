import { eq } from "drizzle-orm";

import { wizardTemplates, type DatabaseClient } from "@tracyhill-rp/db";

import { getWizardTemplateDefaults } from "./wizardDefaults";

export class WizardTemplateRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  findByUser(userId: string) {
    return this.db.select().from(wizardTemplates).where(eq(wizardTemplates.userId, userId)).get();
  }

  /** Seed the shipped defaults the first time a user's row is needed. An
   *  EXISTING row is returned as-is — including an empty example. The column is
   *  NOT NULL DEFAULT '' so "" is what an explicit clear writes; this used to
   *  treat it as "unset" and wrote the sample template back in the same
   *  PUT, making the wizard's no-example path (`buildWizardSessionPrompt`)
   *  unreachable through the UI/API. */
  ensureForUser(userId: string, now: string) {
    const existing = this.findByUser(userId);
    if (existing) return existing;
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
