-- Invite links and the server-wide subscription sign-ins.
--
-- Invite links: an administrator makes a one-time link that lets a person create their own account, with registration
-- off and without email. The token is stored as a SHA-256 hash; the link shows it once.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  username TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT
);

-- The server-wide Claude and ChatGPT sign-ins (offered behind a warning that sharing a subscription may get it
-- banned): the same state and identity the per-user provider_connections rows hold, one row per provider,
-- with no account behind it. The credential lives in the runner's shared home; no token is stored here.
CREATE TABLE IF NOT EXISTS server_subscription_connections (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  account_email TEXT,
  account_org TEXT,
  plan TEXT,
  connected_at TEXT,
  verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
