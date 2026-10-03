-- Lorebook entry version-history + undo.
-- Every destructive rewrite of a lorebook entry (manual edit, rolling-diff,
-- consolidation, archival, thread-tracker) snapshots the PRE-WRITE row here
-- before the mutation lands, so any change is auditable and revertible. Reverts
-- are themselves captured (a revert first snapshots current state), making undo
-- itself undoable. isConstant entries are intentionally NOT captured (the
-- thread-tracker index is rewritten every run — capturing it would be wasteful
-- churn). Capture is capped to the newest ~20 revisions per entry; revision_no
-- is monotonic per entry and never reused after a prune.
CREATE TABLE lorebook_entry_revisions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  campaign_id TEXT,
  revision_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  tag TEXT,
  content TEXT NOT NULL,
  comment TEXT,
  keys TEXT NOT NULL DEFAULT '[]',
  keys_secondary TEXT NOT NULL DEFAULT '[]',
  known_by TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  is_constant INTEGER NOT NULL DEFAULT 0,
  sticky INTEGER NOT NULL DEFAULT 0,
  compressed_ref_ids TEXT,
  source TEXT NOT NULL,
  pipeline_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ler_entry_rev ON lorebook_entry_revisions(entry_id, revision_no DESC);
CREATE INDEX idx_ler_run ON lorebook_entry_revisions(pipeline_run_id);
CREATE INDEX idx_ler_user_created ON lorebook_entry_revisions(user_id, created_at DESC);
