-- Authenticator-app two-factor. One row per account that has set one
-- up or is setting one up. Secrets are encrypted by the API with the provider-key cipher; recovery codes are stored as
-- SHA-256 hashes with the time each was used. `totp_last_step` is the last 30-second step a code was accepted at, so a
-- code works once. A pending secret replaces the active one only when a code from it is confirmed.
CREATE TABLE IF NOT EXISTS user_two_factor (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret TEXT,
  totp_enabled_at TEXT,
  totp_last_step INTEGER,
  pending_secret TEXT,
  pending_created_at TEXT,
  recovery_codes_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
