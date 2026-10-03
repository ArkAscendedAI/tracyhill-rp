-- The Dramatist: hidden schemes, pacing ledger, and classed beat delivery.
-- Additive by design. Existing campaigns remain opted out because enablement
-- lives in context_defaults_json and the contract default is false.

ALTER TABLE campaigns ADD COLUMN dramatist_state_json TEXT;

ALTER TABLE character_drives ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1));
ALTER TABLE character_drives ADD COLUMN scheme_json TEXT;

ALTER TABLE lorebook_entries ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1));
ALTER TABLE lorebook_entry_revisions ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1));

ALTER TABLE scheduled_beats ADD COLUMN class TEXT NOT NULL DEFAULT 'telegraph' CHECK (class IN ('texture', 'telegraph', 'complication'));
ALTER TABLE scheduled_beats ADD COLUMN severity INTEGER NOT NULL DEFAULT 1 CHECK (severity BETWEEN 0 AND 3);
ALTER TABLE scheduled_beats ADD COLUMN timing TEXT NOT NULL DEFAULT 'when_due' CHECK (timing IN ('when_due', 'fire_during_scene'));
ALTER TABLE scheduled_beats ADD COLUMN citation_type TEXT CHECK (citation_type IS NULL OR citation_type IN ('thread', 'beat', 'scheme', 'concealment', 'none'));
ALTER TABLE scheduled_beats ADD COLUMN citation_id TEXT;
ALTER TABLE scheduled_beats ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1));
ALTER TABLE scheduled_beats ADD COLUMN fired_message_id TEXT;

CREATE INDEX IF NOT EXISTS lorebook_entries_campaign_sealed_idx
  ON lorebook_entries(campaign_id, sealed, is_enabled);
CREATE INDEX IF NOT EXISTS character_drives_campaign_sealed_idx
  ON character_drives(campaign_id, sealed, updated_at);
CREATE INDEX IF NOT EXISTS scheduled_beats_campaign_status_class_idx
  ON scheduled_beats(campaign_id, status, class, severity);
