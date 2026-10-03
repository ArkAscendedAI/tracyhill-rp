-- Living World Phase 2: world tick (offscreen simulation). Additive only.
-- world_clock_json = the campaign's in-world simulation watermark:
--   {"simulatedThrough": "<raw in-world label>", "simulatedThroughEpoch": <ms|null>, "updatedAt": "<iso>"}
-- Advanced when a tick run's events are APPLIED (not when proposed).
ALTER TABLE campaigns ADD COLUMN world_clock_json TEXT;

-- Scheduled beats: future consequences armed by applied offscreen events (or a
-- deliberate timeskip). after_epoch NULL = due immediately; otherwise due once
-- the story's in-world clock reaches it. Status: pending | surfaced | dismissed.
CREATE TABLE scheduled_beats (
  id                    TEXT PRIMARY KEY,
  campaign_id           TEXT NOT NULL,
  description           TEXT NOT NULL,
  after_inworld         TEXT,
  after_epoch           INTEGER,
  source_event_entry_id TEXT,
  source_tick_run_id    TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_scheduled_beats_campaign_status ON scheduled_beats(campaign_id, status);
