CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  actor_role TEXT,
  request_id TEXT,
  job_id TEXT,
  session_id TEXT,
  campaign_id TEXT,
  run_id TEXT,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_events_created_at ON audit_events(created_at DESC);
CREATE INDEX idx_audit_events_actor_user_id ON audit_events(actor_user_id);
CREATE INDEX idx_audit_events_action ON audit_events(action);
CREATE INDEX idx_audit_events_campaign_id ON audit_events(campaign_id);
CREATE INDEX idx_audit_events_run_id ON audit_events(run_id);
