-- 0074: service liveness heartbeats.
-- The dedicated worker upserts its row every poll window; the API health
-- endpoint and the liveness watchdogs read it. Absence-of-activity failures
-- (a dead or wedged background loop) become visible instead of looking like
-- a quiet day.
CREATE TABLE IF NOT EXISTS service_heartbeats (
  service TEXT PRIMARY KEY,
  beat_at TEXT NOT NULL,
  details_json TEXT
);
