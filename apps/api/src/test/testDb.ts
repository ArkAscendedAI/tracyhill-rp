import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDatabaseClient, migrateDatabase, userPreferences, users } from "@tracyhill-rp/db";
import { minimalUser } from "@tracyhill-rp/test-fixtures";

import { hashPassword } from "../lib/password";

export async function createSeededTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-v2-"));
  const dbFile = path.join(dir, "test.sqlite");
  const imageDir = path.join(dir, "images");
  fs.mkdirSync(imageDir, { recursive: true });
  migrateDatabase(dbFile);
  const { db, sqlite } = createDatabaseClient(dbFile);
  const now = new Date().toISOString();
  db.insert(users).values({
    id: minimalUser.id,
    username: minimalUser.username,
    email: minimalUser.email,
    emailVerified: 0,
    agreedToTerms: 1,
    role: minimalUser.role,
    passwordHash: await hashPassword(minimalUser.password),
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(userPreferences).values({
    userId: minimalUser.id,
    updatedAt: now,
  }).run();
  sqlite.close();
  return { dbFile, imageDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
