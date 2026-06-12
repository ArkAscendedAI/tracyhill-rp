import session from "express-session";
import Database from "better-sqlite3";

/**
 * SQLite-backed session store for express-session.
 * Uses the same database file as the application (separate table: http_sessions).
 * Prunes expired sessions periodically.
 */
export class SqliteSessionStore extends session.Store {
  private readonly db: Database.Database;
  private readonly pruneInterval: ReturnType<typeof setInterval>;

  constructor(dbFile: string, pruneIntervalMs = 15 * 60 * 1000) {
    super();
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");

    // Ensure the table exists (migration should handle this, but belt-and-suspenders)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS http_sessions (
        sid TEXT PRIMARY KEY NOT NULL,
        sess TEXT NOT NULL,
        expired_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_http_sessions_expired ON http_sessions(expired_at);
    `);

    this.pruneInterval = setInterval(() => this.prune(), pruneIntervalMs);
    this.prune();
  }

  get(sid: string, callback: (err?: Error | null, session?: session.SessionData | null) => void) {
    try {
      const row = this.db.prepare("SELECT sess FROM http_sessions WHERE sid = ? AND expired_at > ?").get(sid, Date.now()) as { sess: string } | undefined;
      if (!row) return callback(null, null);
      callback(null, JSON.parse(row.sess) as session.SessionData);
    } catch (err) {
      callback(err instanceof Error ? err : new Error("session get failed"));
    }
  }

  set(sid: string, sessionData: session.SessionData, callback?: (err?: Error | null) => void) {
    try {
      const maxAge = sessionData.cookie?.maxAge ?? 1000 * 60 * 60 * 24 * 7; // default 7 days
      const expiredAt = Date.now() + maxAge;
      const sess = JSON.stringify(sessionData);
      this.db.prepare(
        "INSERT INTO http_sessions (sid, sess, expired_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired_at = excluded.expired_at"
      ).run(sid, sess, expiredAt);
      callback?.();
    } catch (err) {
      callback?.(err instanceof Error ? err : new Error("session set failed"));
    }
  }

  destroy(sid: string, callback?: (err?: Error | null) => void) {
    try {
      this.db.prepare("DELETE FROM http_sessions WHERE sid = ?").run(sid);
      callback?.();
    } catch (err) {
      callback?.(err instanceof Error ? err : new Error("session destroy failed"));
    }
  }

  touch(sid: string, sessionData: session.SessionData, callback?: (err?: Error | null) => void) {
    try {
      const maxAge = sessionData.cookie?.maxAge ?? 1000 * 60 * 60 * 24 * 7;
      const expiredAt = Date.now() + maxAge;
      this.db.prepare("UPDATE http_sessions SET expired_at = ? WHERE sid = ?").run(expiredAt, sid);
      callback?.();
    } catch (err) {
      callback?.(err instanceof Error ? err : new Error("session touch failed"));
    }
  }

  /**
   * Destroy all sessions for a given userId.
   * Scans session data JSON — not indexed, but user count is small.
   */
  destroyByUserId(userId: string, exceptSid?: string) {
    const rows = this.db.prepare("SELECT sid, sess FROM http_sessions").all() as Array<{ sid: string; sess: string }>;
    const sidsToDelete: string[] = [];
    for (const row of rows) {
      if (exceptSid && row.sid === exceptSid) continue;
      try {
        const data = JSON.parse(row.sess) as { userId?: string };
        if (data.userId === userId) sidsToDelete.push(row.sid);
      } catch { /* skip corrupt rows */ }
    }
    if (sidsToDelete.length > 0) {
      const placeholders = sidsToDelete.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM http_sessions WHERE sid IN (${placeholders})`).run(...sidsToDelete);
    }
    return sidsToDelete.length;
  }

  private prune() {
    try {
      this.db.prepare("DELETE FROM http_sessions WHERE expired_at <= ?").run(Date.now());
    } catch { /* ignore prune errors */ }
  }

  close() {
    clearInterval(this.pruneInterval);
    this.db.close();
  }
}
