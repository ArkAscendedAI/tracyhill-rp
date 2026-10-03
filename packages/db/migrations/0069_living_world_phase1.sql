-- Living World Phase 1: character drive sheets (NPC autonomy) + spotlight marker.
-- Additive only. Mirrors the character_attire pattern (dedicated per-character
-- state injected deterministically per turn, plus a full-snapshot history table).

CREATE TABLE character_drives (
  campaign_id       TEXT NOT NULL,
  character_name    TEXT NOT NULL,
  wants_json        TEXT NOT NULL DEFAULT '[]',   -- [{id,text,pressure,sinceTurn}] cap 5
  goals_json        TEXT NOT NULL DEFAULT '[]',   -- [{id,text,status}] cap 3
  red_lines_json    TEXT NOT NULL DEFAULT '[]',   -- string[]
  leverage_json     TEXT NOT NULL DEFAULT '[]',   -- string[]
  offpage_project   TEXT,
  concealment_json  TEXT NOT NULL DEFAULT '[]',   -- [{secret,behavior}] cap 4
  dispositions_json TEXT NOT NULL DEFAULT '{}',   -- {target:line} cap 6
  last_updated_turn INTEGER,
  last_updated_message_id TEXT,
  source            TEXT NOT NULL,                -- wizard | backfill | worker | user
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (campaign_id, character_name)
);

CREATE INDEX idx_character_drives_campaign ON character_drives(campaign_id);

CREATE TABLE character_drives_history (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL,
  character_name    TEXT NOT NULL,
  before_json       TEXT NOT NULL,   -- whole-sheet snapshot before the write ('{}' on create)
  after_json        TEXT NOT NULL,   -- whole-sheet snapshot after the write
  changed_at_turn   INTEGER,
  changed_at_message_id TEXT,
  source            TEXT NOT NULL,
  reason            TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_character_drives_history_campaign_char
  ON character_drives_history(campaign_id, character_name, created_at);

-- Spotlight turns ("hand the scene to an NPC"): the GM-directive marker is a real
-- message (role='user', directive_kind='gm_spotlight') so provider user/assistant
-- alternation, variants, and disconnect recovery all work unchanged; the UI renders
-- it as a divider, never a user bubble. NULL for every ordinary message.
ALTER TABLE messages ADD COLUMN directive_kind TEXT;
