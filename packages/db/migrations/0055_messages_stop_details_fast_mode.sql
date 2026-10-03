-- 0055: stop_reason + stop_details + fast_mode on messages
--
-- stop_reason: every assistant message records what the provider reported
--   (end_turn, max_tokens, stop_sequence, refusal, pause_turn, ...).
-- stop_details_json: Anthropic-only, non-null only on refusal turns (Opus 4.7+).
--   Shape: {"type":"refusal","category":"cyber"|"bio"|null,"explanation":string|null}.
-- fast_mode: 1 iff the API actually applied fast mode on this turn (verified
--   from usage.speed === "fast"). Used for accurate historical cost overlay.

ALTER TABLE messages ADD COLUMN stop_reason TEXT;
ALTER TABLE messages ADD COLUMN stop_details_json TEXT;
ALTER TABLE messages ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;
