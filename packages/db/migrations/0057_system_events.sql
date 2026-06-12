-- System events: persistent record of passive-subsystem failures (embeddings,
-- HyDE, researcher, scene validator, workers). Born from the 2026-06-10 incident
-- where a DNS outage silently killed context assembly for 14 turns.
CREATE TABLE system_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  message TEXT NOT NULL,
  campaign_id TEXT,
  session_id TEXT,
  details_json TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_system_events_user_created ON system_events(user_id, created_at DESC);
CREATE INDEX idx_system_events_user_unacked ON system_events(user_id, acknowledged_at) WHERE acknowledged_at IS NULL;
