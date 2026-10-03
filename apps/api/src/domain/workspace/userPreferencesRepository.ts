import { eq } from "drizzle-orm";

import { userPreferences, type DatabaseClient } from "@tracyhill-rp/db";

export class UserPreferencesRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  getForUser(userId: string) {
    return this.db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).get();
  }

  ensureForUser(userId: string, now: string) {
    const existing = this.getForUser(userId);
    if (existing) return existing;
    this.db.insert(userPreferences).values({ userId, updatedAt: now }).run();
    return this.getForUser(userId)!;
  }

  updateForUser(userId: string, input: Partial<typeof userPreferences.$inferInsert>) {
    this.db.update(userPreferences).set(input).where(eq(userPreferences.userId, userId)).run();
  }
}
