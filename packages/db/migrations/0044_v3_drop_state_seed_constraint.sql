-- V3: Add DEFAULT '' to state_seed columns so Drizzle can omit them.
-- SQLite requires table recreation to change column constraints.

PRAGMA foreign_keys=off;

-- campaigns: original state_seed was NOT NULL without DEFAULT
CREATE TABLE campaigns_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  state_seed TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pipeline_model_id TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  update_prompt_template TEXT NOT NULL DEFAULT '',
  system_prompt_update_template TEXT NOT NULL DEFAULT '',
  folder_id TEXT,
  character_roster TEXT DEFAULT '[]',
  kind_registry TEXT NOT NULL DEFAULT '{"kinds":{}}',
  pipeline_version TEXT NOT NULL DEFAULT 'v2',
  creative_model_id TEXT,
  validation_model_id TEXT,
  context_defaults_json TEXT,
  state_seed_legacy_at TEXT
);
INSERT INTO campaigns_v3 SELECT
  id, user_id, name, system_prompt, state_seed, version, created_at, updated_at,
  pipeline_model_id, update_prompt_template, system_prompt_update_template, folder_id,
  character_roster, kind_registry, pipeline_version, creative_model_id, validation_model_id,
  context_defaults_json, state_seed_legacy_at
FROM campaigns;
DROP TABLE campaigns;
ALTER TABLE campaigns_v3 RENAME TO campaigns;

-- campaign_versions: original state_seed was NOT NULL without DEFAULT
CREATE TABLE campaign_versions_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  state_seed TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  label TEXT
);
INSERT INTO campaign_versions_v3 SELECT
  id, campaign_id, user_id, version, system_prompt, state_seed, created_at, label
FROM campaign_versions;
DROP TABLE campaign_versions;
ALTER TABLE campaign_versions_v3 RENAME TO campaign_versions;

PRAGMA foreign_keys=on;
