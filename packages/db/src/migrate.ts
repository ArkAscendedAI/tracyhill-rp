import fs from "node:fs";
import path from "node:path";

import { createDatabaseClient } from "./client";

const migrationsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../migrations");

export interface Migration {
  name: string;
  sql: string;
}

/** Read every `.sql` migration file from the migrations directory, sorted by filename. */
export function readMigrations(): Migration[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(migrationsDir, name), "utf8") }));
}

export function migrateDatabase(filePath: string) {
  const { sqlite } = createDatabaseClient(filePath);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      executed_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    sqlite.prepare("SELECT name FROM __migrations ORDER BY name").all().map((row) => String((row as { name: string }).name)),
  );
  for (const { name, sql } of readMigrations()) {
    if (applied.has(name)) continue;
    const tx = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare("INSERT INTO __migrations (name, executed_at) VALUES (?, ?)").run(name, new Date().toISOString());
    });
    tx();
  }
  sqlite.close();
}
