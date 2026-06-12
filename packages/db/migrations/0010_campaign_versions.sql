CREATE TABLE IF NOT EXISTS campaign_versions (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  state_seed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
