-- Server settings an administrator edits in the app: one JSON value per section
-- ("accounts", "email", "twoFactor", "sessions"). Secrets inside a value are stored encrypted by the API. The API writes
-- the first rows at boot: values that keep today's behavior on a server that had accounts before first-run setup
-- existed, the new defaults on a server set up through it.
CREATE TABLE IF NOT EXISTS server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
