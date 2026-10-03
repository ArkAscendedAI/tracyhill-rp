-- 0083: dead-column sweep (2026-09-02 evening; 0068 pattern).
-- Every item below was verified read-only against a live database the same
-- evening: no reader AND no writer left in api / worker / web / android.
--
--   pipeline_run_artifacts        write-never since b420e71 (2026-07-10); its read
--                                 plumbing was dropped in 66ef31d; 25 stale rows.
--   campaigns.context_defaults_json  retired IN PLACE by 0077, re-folded by 0081;
--                                 11 fossil blobs, zero readers (the embedding-model
--                                 readers resolve off the newest session).
--   campaigns.creative_model_id   no reader/writer; 0 rows set.
--   user_preferences.font_size / status_bar_open / ctrl_bar_open
--                                 defaults only; never in the workspace contract.
--   lorebook_entries.merged_into_id  write-only consolidation provenance (59 rows);
--                                 the same information is kept in the entry's
--                                 comment ("merged_into:<id>:at:<ts>"), which is
--                                 what curators actually see.
--
-- NOT dropped (measured alive): pipeline_runs.approved_at (three workers write it
-- as their "applied" marker; cancel reads it) and sessions.system_prompt (15 live
-- standalone V1-era sessions carry one; the fallback reader is restored in the
-- same commit).

DROP TABLE IF EXISTS pipeline_run_artifacts;

ALTER TABLE campaigns DROP COLUMN context_defaults_json;
ALTER TABLE campaigns DROP COLUMN creative_model_id;

ALTER TABLE user_preferences DROP COLUMN font_size;
ALTER TABLE user_preferences DROP COLUMN status_bar_open;
ALTER TABLE user_preferences DROP COLUMN ctrl_bar_open;

ALTER TABLE lorebook_entries DROP COLUMN merged_into_id;
