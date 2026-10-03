import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;

type RawSqlite = Database.Database;

export interface DatabaseClientOptions {
  /**
   * Run the once-per-file boot integrity check on this connection (default
   * true). The migration runner passes `false`: it opens the FIRST connection of
   * a boot, so with the check on that connection the "orphan rows" summary
   * described the PRE-migration state and the first real app connection then
   * skipped it. With the runner opted out, the check lands on the first app
   * connection — after this boot's migrations have applied.
   */
  integrityCheck?: boolean;
}

// Module-private: only `createDatabaseClient` needs it (it was exported with
// zero external callers).
function ensureDatabaseDir(filePath: string) {
  if (filePath === ":memory:") return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Run SQLite's `PRAGMA quick_check` (and `foreign_key_check`, when FK enforcement
 * is on) against an open connection. Returns `{ ok: true }` on a clean database,
 * or `{ ok: false, errors }` listing the problems. Cheap enough to run at boot;
 * the caller decides whether a failure is fatal. Never throws.
 *
 * Module-private: nothing outside this file called it (the health endpoint
 * never did).
 * `foreign_key_check` only sees the seven FK-bearing user/session-tree tables —
 * campaign-owned tables declare no FKs, so their orphans are invisible here.
 */
function runQuickCheck(sqlite: RawSqlite): { ok: boolean; errors: string[]; fkWarnings: string[] } {
  const errors: string[] = [];
  try {
    const rows = sqlite.pragma("quick_check") as Array<{ quick_check: string }>;
    for (const row of rows) {
      const value = String(row.quick_check ?? "").trim();
      if (value && value.toLowerCase() !== "ok") errors.push(value);
    }
  } catch (err) {
    errors.push(`quick_check failed to run: ${(err as Error).message ?? String(err)}`);
  }

  // Foreign-key orphans are NOT corruption — they are pre-existing rows whose
  // parent was deleted while FK enforcement was off (it was never on before).
  // SQLite never enforces FKs retroactively, so these are harmless dead rows; we
  // summarize them (a maintenance signal) rather than flooding the log with one
  // line per orphan (a months-old campaign can have thousands).
  const fkWarnings: string[] = [];
  try {
    const fkOn = (sqlite.pragma("foreign_keys", { simple: true }) as number) === 1;
    if (fkOn) {
      const fkRows = sqlite.pragma("foreign_key_check") as Array<{ table?: string; parent?: string }>;
      if (fkRows.length > 0) {
        const byPair = new Map<string, number>();
        for (const row of fkRows) {
          const pair = `${row.table ?? "?"}→${row.parent ?? "?"}`;
          byPair.set(pair, (byPair.get(pair) ?? 0) + 1);
        }
        const breakdown = [...byPair.entries()].map(([pair, n]) => `${pair}: ${n}`).join(", ");
        fkWarnings.push(`${fkRows.length} orphaned rows (${breakdown})`);
      }
    }
  } catch (err) {
    fkWarnings.push(`foreign_key_check failed to run: ${(err as Error).message ?? String(err)}`);
  }

  return { ok: errors.length === 0, errors, fkWarnings };
}

const integrityCheckedPaths = new Set<string>();

export function createDatabaseClient(filePath: string, options: DatabaseClientOptions = {}) {
  ensureDatabaseDir(filePath);
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  // Block briefly instead of throwing SQLITE_BUSY when a peer holds the write lock
  // (prod runs API + worker against the same file).
  sqlite.pragma("busy_timeout = 5000");
  // Safe under WAL: a power loss can lose the last committed transaction but never
  // corrupts the database, and it removes an fsync from the hot write path.
  sqlite.pragma("synchronous = NORMAL");
  // Enforce ON DELETE CASCADE / SET NULL declared throughout the schema. The
  // migration runner (migrate.ts) deliberately runs each migration with FK
  // enforcement OFF so the table-rebuild migrations work; every connection —
  // the runner's included — starts with it ON here.
  sqlite.pragma("foreign_keys = ON");

  // Boot-time integrity check — once per database file per process, on the first
  // connection that opts in. Prod opens several connections to the same file
  // (migrate + API + each inline worker); re-running the check per connection
  // just repeats the same summary in the log. The migration runner opts out (see
  // DatabaseClientOptions) so the check reflects the post-migration state.
  if (options.integrityCheck !== false && !integrityCheckedPaths.has(filePath)) {
    integrityCheckedPaths.add(filePath);
    const check = runQuickCheck(sqlite);
    if (!check.ok) {
      console.error(`[db] integrity check FAILED for ${filePath}:`, check.errors.join("; "));
    }
    if (check.fkWarnings.length > 0) {
      console.warn(`[db] foreign-key orphans (pre-existing, non-fatal) in ${filePath}: ${check.fkWarnings.join("; ")}`);
    }
  }

  const db = drizzle(sqlite, { schema });
  // Every transaction opens IMMEDIATE unless the call site says otherwise.
  // Drizzle's default is a DEFERRED `BEGIN`: a
  // transaction whose first statement READS pins a WAL snapshot, and when the
  // peer process (API and worker share this file) commits before the first
  // write, SQLite refuses the lock upgrade with SQLITE_BUSY_SNAPSHOT at once —
  // busy_timeout is deliberately not consulted because waiting cannot refresh
  // a stale snapshot (`campaignService.update` died this way: findById, then
  // the archive insert). `BEGIN IMMEDIATE` takes the write lock up front, so
  // the same transaction waits on busy_timeout and the peer's write lands
  // before or after it, never in between. Every transaction in this codebase
  // writes, so no read-only transaction pays for the lock; nested
  // `tx.transaction()` calls are savepoints and unaffected.
  const deferredTransaction: typeof db.transaction = db.transaction.bind(db);
  const immediateTransaction: typeof db.transaction = (transaction, config) =>
    deferredTransaction(transaction, { behavior: "immediate", ...config });
  db.transaction = immediateTransaction;
  return { db, sqlite };
}
