CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
