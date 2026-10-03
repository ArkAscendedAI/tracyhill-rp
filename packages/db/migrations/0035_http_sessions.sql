CREATE TABLE IF NOT EXISTS http_sessions (
  sid TEXT PRIMARY KEY NOT NULL,
  sess TEXT NOT NULL,
  expired_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_http_sessions_expired ON http_sessions(expired_at);
