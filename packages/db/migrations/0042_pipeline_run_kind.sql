-- V3: Unify the pipeline queue across job types.
-- kind: campaign_review (legacy + manual deep refresh),
--        wizard_v3 (new wizard producing lorebook corpus),
--        rolling_diff (automatic per-cadence lorebook diffs).
ALTER TABLE pipeline_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'campaign_review';
ALTER TABLE pipeline_runs ADD COLUMN session_id TEXT;
CREATE INDEX idx_pipeline_runs_kind_status ON pipeline_runs(kind, status);
