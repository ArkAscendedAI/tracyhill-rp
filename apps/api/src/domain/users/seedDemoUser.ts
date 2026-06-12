import { createDatabaseClient, userPreferences } from "@tracyhill-rp/db";

import { createId } from "../../lib/ids";
import { hashPassword } from "../../lib/password";
import { UserRepository } from "./userRepository";

export async function seedDemoUser(dbFile: string, username: string, password: string) {
  const { db, sqlite } = createDatabaseClient(dbFile);
  const repo = new UserRepository(db);
  if (repo.countUsers() > 0) {
    sqlite.close();
    return;
  }
  const now = new Date().toISOString();
  const id = createId();
  repo.createUser({
    id,
    username,
    email: `${username}@example.com`,
    emailVerified: 0,
    agreedToTerms: 1,
    role: "admin",
    passwordHash: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  });
  db.insert(userPreferences).values({
    userId: id,
    updatedAt: now,
  }).run();
  sqlite.close();
}
