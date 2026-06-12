-- V3: Lorebook — canonical fact store replacing state_seed.
CREATE TABLE lorebook_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  campaign_id TEXT,
  name TEXT NOT NULL,
  tag TEXT,
  content TEXT NOT NULL,
  comment TEXT,
  keys TEXT NOT NULL DEFAULT '[]',
  keys_secondary TEXT NOT NULL DEFAULT '[]',
  selective_logic TEXT NOT NULL DEFAULT 'and_any',
  scan_depth INTEGER NOT NULL DEFAULT 4,
  position TEXT NOT NULL DEFAULT 'before_main',
  insertion_order INTEGER NOT NULL DEFAULT 100,
  probability INTEGER NOT NULL DEFAULT 100,
  is_constant INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  sticky INTEGER NOT NULL DEFAULT 0,
  cooldown INTEGER NOT NULL DEFAULT 0,
  delay INTEGER NOT NULL DEFAULT 0,
  exclude_recursion INTEGER NOT NULL DEFAULT 0,
  prevent_recursion INTEGER NOT NULL DEFAULT 0,
  delay_until_recursion INTEGER NOT NULL DEFAULT 0,
  tokens_estimate INTEGER NOT NULL DEFAULT 0,
  match_options_json TEXT,
  legacy_source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_lorebook_entries_campaign ON lorebook_entries(user_id, campaign_id);
CREATE INDEX idx_lorebook_entries_enabled ON lorebook_entries(user_id, campaign_id, is_enabled);
CREATE INDEX idx_lorebook_entries_constant ON lorebook_entries(user_id, campaign_id, is_constant);

-- Per-session sticky/cooldown state. Reset when session deleted.
CREATE TABLE lorebook_activation_state (
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  sticky_remaining INTEGER NOT NULL DEFAULT 0,
  cooldown_remaining INTEGER NOT NULL DEFAULT 0,
  last_activated_turn INTEGER,
  PRIMARY KEY (session_id, entry_id)
);

-- Embeddings split off so re-embedding doesn't churn entry updated_at.
CREATE TABLE lorebook_entry_embeddings (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_lorebook_entry_embeddings_unique ON lorebook_entry_embeddings(entry_id, model);
CREATE INDEX idx_lorebook_entry_embeddings_user_model ON lorebook_entry_embeddings(user_id, model);

-- Optional: chat-message embeddings (VectHare mode). Off by default.
CREATE TABLE chat_message_embeddings (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_chat_message_embeddings_unique ON chat_message_embeddings(message_id, model);
CREATE INDEX idx_chat_message_embeddings_session ON chat_message_embeddings(session_id, model);
