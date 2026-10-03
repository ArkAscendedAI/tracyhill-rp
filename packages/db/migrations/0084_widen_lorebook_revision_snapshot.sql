-- 0084: widen the lorebook revision snapshot to every entry dial
-- (2026-09-02). Revert used to be a
-- PARTIAL restore: 0064 captured only the worker-written subset, so a reverted
-- entry kept whatever scan depth / position / order / probability / cooldown /
-- delay / recursion flags / match options the later write had left. All new
-- columns are NULLABLE on purpose — a revision captured before this migration
-- holds NULL there and revert leaves the entry's CURRENT value in place for it.

ALTER TABLE lorebook_entry_revisions ADD COLUMN selective_logic TEXT;
ALTER TABLE lorebook_entry_revisions ADD COLUMN scan_depth INTEGER;
ALTER TABLE lorebook_entry_revisions ADD COLUMN position TEXT;
ALTER TABLE lorebook_entry_revisions ADD COLUMN insertion_order INTEGER;
ALTER TABLE lorebook_entry_revisions ADD COLUMN probability INTEGER;
ALTER TABLE lorebook_entry_revisions ADD COLUMN cooldown INTEGER;
ALTER TABLE lorebook_entry_revisions ADD COLUMN delay INTEGER;
ALTER TABLE lorebook_entry_revisions ADD COLUMN exclude_recursion INTEGER;
ALTER TABLE lorebook_entry_revisions ADD COLUMN prevent_recursion INTEGER;
ALTER TABLE lorebook_entry_revisions ADD COLUMN delay_until_recursion INTEGER;
ALTER TABLE lorebook_entry_revisions ADD COLUMN match_options_json TEXT;
