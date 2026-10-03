-- V3: Mark legacy state_seed fields. Columns remain readable for migration;
-- new code does NOT write to them after this timestamp is set.
ALTER TABLE campaigns ADD COLUMN state_seed_legacy_at TEXT;
ALTER TABLE sessions ADD COLUMN state_seed_legacy_at TEXT;
