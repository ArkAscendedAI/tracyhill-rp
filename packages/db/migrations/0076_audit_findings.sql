-- Audit findings review queue: ambiguous campaign-audit findings persist
-- structurally (instead of flattening to report strings) so the owner can rule
-- on them from the composer; an audit_ruling run executes the rulings. Durable
-- state lives here and in the lorebook itself (canon-notes) — never as
-- cross-run audit progress, so the no-watermarks axiom is untouched.
CREATE TABLE IF NOT EXISTS audit_findings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  reason TEXT,
  entry_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'ruled')),
  ruling TEXT,
  executor_question TEXT,
  outcome TEXT,
  ruling_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ruled_at TEXT
);

CREATE INDEX IF NOT EXISTS audit_findings_campaign_status_idx
  ON audit_findings(campaign_id, status, updated_at);

-- One ACTIVE row per distinct finding per campaign: a re-derived duplicate from
-- the next audit refreshes the existing open row instead of stacking copies.
CREATE UNIQUE INDEX IF NOT EXISTS audit_findings_campaign_fingerprint_active_uq
  ON audit_findings(campaign_id, fingerprint) WHERE status IN ('open', 'processing');
