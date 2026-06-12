-- Automated pipeline queue: per-campaign serial execution with priority ordering
ALTER TABLE sessions ADD COLUMN pipeline_chars_since_rolling_diff INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pipeline_chars_since_repetition INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pipeline_chars_since_sysprompt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
