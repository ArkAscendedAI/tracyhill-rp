CREATE TABLE provider_keys (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_keys_user_id ON provider_keys(user_id);
