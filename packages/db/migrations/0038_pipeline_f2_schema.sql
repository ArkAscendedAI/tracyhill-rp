-- F2 pipeline schema: Kind Registry, pipeline version flag, raw LLM I/O artifact table.
-- Companion to packages/pipeline-core. See docs/pipeline-f2.md.

-- Per-campaign Kind Registry (starts empty for every campaign).
ALTER TABLE campaigns ADD COLUMN kind_registry TEXT NOT NULL DEFAULT '{"kinds":{}}';

-- Pipeline version flag: "v2" = legacy full-rewrite path (default); "v3" = F2 diff-based path.
ALTER TABLE campaigns ADD COLUMN pipeline_version TEXT NOT NULL DEFAULT 'v2';

-- Raw LLM I/O persistence (quick-win D4). Retains the prompt + response + stream events
-- per pipeline stage for forensic review. 90-day retention is a separate cleanup job.
CREATE TABLE IF NOT EXISTS pipeline_run_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_run_artifacts_run_idx ON pipeline_run_artifacts(run_id);

-- Pipeline approvals audit (quick-win D1). Stores the structural diff persisted at approval time.
CREATE TABLE IF NOT EXISTS pipeline_approvals_audit (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seed_diff TEXT NOT NULL DEFAULT '',
  system_prompt_diff TEXT NOT NULL DEFAULT '',
  size_alert INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pipeline_approvals_audit_campaign_idx ON pipeline_approvals_audit(campaign_id);
