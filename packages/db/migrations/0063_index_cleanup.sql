-- Index hygiene.
--
-- Drop five redundant indexes added by migration 0049. Each one duplicates a
-- left-prefix of an existing (often UNIQUE) index, so it earns nothing on reads
-- but taxes every write to the hottest tables (messages, sessions, lorebook):
--   idx_messages_session_id            ⊂ messages_session_sort_idx(session_id, sort_order)  [0003]
--   idx_messages_user_id               ⊂ messages_user_session_idx(user_id, session_id)     [0003]
--   idx_sessions_user_id               ⊂ sessions_user_updated_idx(user_id, updated_at DESC) [0002/0030]
--   idx_lorebook_entries_user_id       ⊂ idx_lorebook_entries_campaign(user_id, campaign_id) [0040]
--   idx_lorebook_activation_state_pk     duplicates PRIMARY KEY (session_id, entry_id)       [0040]
DROP INDEX IF EXISTS idx_messages_session_id;
DROP INDEX IF EXISTS idx_messages_user_id;
DROP INDEX IF EXISTS idx_sessions_user_id;
DROP INDEX IF EXISTS idx_lorebook_entries_user_id;
DROP INDEX IF EXISTS idx_lorebook_activation_state_pk;

-- Add indexes for real query shapes that currently full-scan.
--   pipeline_run_artifacts(created_at): artifactRepository.sweepExpired() runs
--     `DELETE WHERE created_at < cutoff` at every boot over the largest-blob table.
--   campaign_versions(campaign_id): version history is listed per campaign.
--   wizard_runs(user_id): wizard runs are listed per user.
--   generated_images(user_id): image library + per-user FK cascade deletes.
CREATE INDEX IF NOT EXISTS idx_pipeline_run_artifacts_created_at ON pipeline_run_artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_campaign_versions_campaign ON campaign_versions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wizard_runs_user ON wizard_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_user ON generated_images(user_id);
