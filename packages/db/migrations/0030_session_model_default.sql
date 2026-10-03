PRAGMA foreign_keys=off;

CREATE TABLE sessions__new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_type TEXT NOT NULL DEFAULT 'standard',
  campaign_id TEXT,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL DEFAULT 'claude-opus-4-6',
  thinking_mode TEXT NOT NULL DEFAULT 'off',
  thinking_budget INTEGER,
  effort TEXT,
  cache_ttl TEXT NOT NULL DEFAULT 'off',
  auto_scroll INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT,
  deleted_at TEXT
);

INSERT INTO sessions__new (
  id,
  user_id,
  session_type,
  campaign_id,
  folder_id,
  name,
  model_id,
  thinking_mode,
  thinking_budget,
  effort,
  cache_ttl,
  auto_scroll,
  message_count,
  created_at,
  updated_at,
  last_message_at,
  deleted_at
)
SELECT
  id,
  user_id,
  session_type,
  campaign_id,
  folder_id,
  name,
  model_id,
  thinking_mode,
  thinking_budget,
  effort,
  cache_ttl,
  auto_scroll,
  message_count,
  created_at,
  updated_at,
  last_message_at,
  deleted_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions__new RENAME TO sessions;

CREATE INDEX sessions_user_updated_idx ON sessions(user_id, updated_at DESC);
CREATE INDEX sessions_user_folder_idx ON sessions(user_id, folder_id);

PRAGMA foreign_keys=on;
