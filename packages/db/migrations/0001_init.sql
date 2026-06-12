CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_session_id TEXT,
  font_size INTEGER NOT NULL DEFAULT 14,
  sidebar_open INTEGER NOT NULL DEFAULT 1,
  status_bar_open INTEGER NOT NULL DEFAULT 1,
  ctrl_bar_open INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
