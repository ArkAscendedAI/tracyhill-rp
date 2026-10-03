import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabaseClient } from "./client";

// `fileURLToPath` (not `new URL(...).pathname`): the pathname form percent-encodes
// spaces and other chars, so a checkout under a path like ".../My Repo/..." yields
// a broken, %20-laden directory that fs can't read.
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

// Every migration is `NNNN_snake_name.sql` with a 4-digit zero-padded prefix, so
// the lexical sort below IS numeric order. The runner enforces the shape rather
// than trusting it: a stray `81_x.sql` or `00811_x.sql` would sort into the wrong
// place silently, and two files sharing a prefix (two branches each adding
// "the next number") would apply in an order nobody chose.
const MIGRATION_FILENAME = /^(\d{4})_[A-Za-z0-9_]+\.sql$/;

/**
 * Lock-wait budget for the migration connection. The app connections use 5 s
 * (client.ts), which is the right answer for a request-path write; it is the
 * WRONG answer here, where the peer holding the lock may be applying a heavy
 * migration (0046 rebuilt the FTS index over every message; 0077 json_patch-ed
 * every session). Under 5 s the second boot-racing container threw
 * SQLITE_BUSY, crashed, and restart-looped until the first finished.
 */
const MIGRATION_BUSY_TIMEOUT_MS = 10 * 60 * 1000;

export interface Migration {
  name: string;
  sql: string;
}

/**
 * Read every `.sql` migration file from the migrations directory, sorted by
 * filename. Throws on a malformed name or a duplicated numeric prefix — both
 * would otherwise apply in an unintended order.
 */
export function readMigrations(): Migration[] {
  const names = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const seenPrefixes = new Map<string, string>();
  for (const name of names) {
    const match = MIGRATION_FILENAME.exec(name);
    if (!match) throw new Error(`Migration filename "${name}" is not of the form NNNN_name.sql`);
    const prefix = match[1]!;
    const other = seenPrefixes.get(prefix);
    if (other) throw new Error(`Migrations "${other}" and "${name}" share the prefix ${prefix}; renumber one of them`);
    seenPrefixes.set(prefix, name);
  }
  return names.map((name) => ({ name, sql: fs.readFileSync(path.join(migrationsDir, name), "utf8") }));
}

function appliedSet(sqlite: ReturnType<typeof createDatabaseClient>["sqlite"]): Set<string> {
  return new Set(
    sqlite
      .prepare("SELECT name FROM __migrations ORDER BY name")
      .all()
      .map((row) => String((row as { name: string }).name)),
  );
}

export function migrateDatabase(filePath: string) {
  // integrityCheck:false — this is the first connection of a boot; the
  // once-per-file check belongs on the first APP connection, after the
  // migrations below have run (see DatabaseClientOptions).
  const { sqlite } = createDatabaseClient(filePath, { integrityCheck: false });
  try {
    sqlite.pragma(`busy_timeout = ${MIGRATION_BUSY_TIMEOUT_MS}`);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        executed_at TEXT NOT NULL
      )
    `);

    const applied = appliedSet(sqlite);
    for (const { name, sql } of readMigrations()) {
      if (applied.has(name)) continue;

      // Foreign-key enforcement is toggled OUTSIDE the transaction. SQLite documents
      // `PRAGMA foreign_keys` as a no-op inside an open transaction, and the
      // table-rebuild migrations (0030/0044) drop+recreate parent tables, which only
      // survives with FK enforcement off. We disable it here, around the whole
      // migration, then restore it after COMMIT. (The embedded `PRAGMA foreign_keys`
      // lines inside those migrations are harmless no-ops once a transaction is open.)
      sqlite.pragma("foreign_keys = OFF");
      try {
        // BEGIN IMMEDIATE takes the write lock up front so two boot-racing processes
        // (the prod topology migrates from both the API and worker containers) can't
        // both decide migration N is unapplied and clobber each other.
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          // Re-check the applied set now that we hold the write lock: a peer process
          // may have applied this exact migration between our read above and here.
          if (!appliedSet(sqlite).has(name)) {
            sqlite.exec(sql);
            sqlite
              .prepare("INSERT INTO __migrations (name, executed_at) VALUES (?, ?)")
              .run(name, new Date().toISOString());
          }
          sqlite.exec("COMMIT");
        } catch (err) {
          // Some failures (SQLITE_FULL, IOERR, a constraint hit mid-statement in
          // certain modes) have already rolled the transaction back by the time
          // we get here; an unconditional ROLLBACK would then throw "no
          // transaction is active" and MASK the real error. Either way the
          // partial migration is gone and the applied-set INSERT never landed,
          // so the next boot re-attempts it from scratch.
          if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
          throw err;
        }
      } catch (err) {
        throw new Error(`Migration "${name}" failed: ${(err as Error).message ?? String(err)}`, { cause: err });
      } finally {
        sqlite.pragma("foreign_keys = ON");
      }
    }
  } finally {
    // Close on the failure path too — the old runner leaked the connection when a
    // migration threw (the process usually exited anyway, but tests didn't).
    sqlite.close();
  }
}
