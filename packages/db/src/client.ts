import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;

export function ensureDatabaseDir(filePath: string) {
  if (filePath === ":memory:") return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function createDatabaseClient(filePath: string) {
  ensureDatabaseDir(filePath);
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
