-- Per-user subscription connections for the composer (2026-09-25). One row per
-- (user, provider) where provider is 'claude' or 'chatgpt'. The credential itself lives in the runner
-- service's per-user home, written only by the official Claude Code / Codex
-- binaries; this table records state and the account identity the binaries
-- report (email, organization, plan) so pickers can gate the bridge models and
-- the Providers dialog can show who is signed in. No token is ever stored here.
CREATE TABLE IF NOT EXISTS provider_connections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  account_email TEXT,
  account_org TEXT,
  plan TEXT,
  connected_at TEXT,
  verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
