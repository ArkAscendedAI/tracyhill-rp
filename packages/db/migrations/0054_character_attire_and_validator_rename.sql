-- Character attire tracking + rename presenceValidator* -> sceneValidator*

CREATE TABLE character_attire (
  campaign_id TEXT NOT NULL,
  character_name TEXT NOT NULL,
  attire_description TEXT NOT NULL,
  last_updated_turn INTEGER NOT NULL DEFAULT 0,
  last_updated_message_id TEXT,
  last_seen_in_present_turn INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'verifier',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, character_name)
);

CREATE INDEX idx_character_attire_campaign ON character_attire(campaign_id);

CREATE TABLE character_attire_history (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  character_name TEXT NOT NULL,
  previous_attire TEXT,
  new_attire TEXT NOT NULL,
  changed_at_turn INTEGER NOT NULL,
  changed_at_message_id TEXT,
  source TEXT NOT NULL,
  reason TEXT,
  changed_at TEXT NOT NULL
);

CREATE INDEX idx_character_attire_history_campaign ON character_attire_history(campaign_id, character_name, changed_at);

-- Rename JSON keys: presenceValidator* -> sceneValidator*.
-- IMPORTANT: use the `->` operator (JSON-preserving) for the copied value, NOT
-- json_extract(). json_extract() coerces a JSON boolean to a SQLite integer
-- (0/1), and json_set() would then store it back as a JSON *number* — which
-- fails the `z.boolean()` contract on sceneValidatorEnabled/AutoRegen.
-- `->` preserves the original JSON type (boolean, string, number) intact.
UPDATE campaigns
SET context_defaults_json = json_remove(
  json_set(context_defaults_json, '$.sceneValidatorEnabled', context_defaults_json -> '$.presenceValidatorEnabled'),
  '$.presenceValidatorEnabled'
)
WHERE context_defaults_json IS NOT NULL
  AND json_extract(context_defaults_json, '$.presenceValidatorEnabled') IS NOT NULL;

UPDATE campaigns
SET context_defaults_json = json_remove(
  json_set(context_defaults_json, '$.sceneValidatorModel', context_defaults_json -> '$.presenceValidatorModel'),
  '$.presenceValidatorModel'
)
WHERE context_defaults_json IS NOT NULL
  AND json_extract(context_defaults_json, '$.presenceValidatorModel') IS NOT NULL;

UPDATE campaigns
SET context_defaults_json = json_remove(
  json_set(context_defaults_json, '$.sceneValidatorAutoRegen', context_defaults_json -> '$.presenceValidatorAutoRegen'),
  '$.presenceValidatorAutoRegen'
)
WHERE context_defaults_json IS NOT NULL
  AND json_extract(context_defaults_json, '$.presenceValidatorAutoRegen') IS NOT NULL;

UPDATE sessions
SET context_overrides_json = json_remove(
  json_set(context_overrides_json, '$.sceneValidatorEnabled', context_overrides_json -> '$.presenceValidatorEnabled'),
  '$.presenceValidatorEnabled'
)
WHERE context_overrides_json IS NOT NULL
  AND json_extract(context_overrides_json, '$.presenceValidatorEnabled') IS NOT NULL;

UPDATE sessions
SET context_overrides_json = json_remove(
  json_set(context_overrides_json, '$.sceneValidatorModel', context_overrides_json -> '$.presenceValidatorModel'),
  '$.presenceValidatorModel'
)
WHERE context_overrides_json IS NOT NULL
  AND json_extract(context_overrides_json, '$.presenceValidatorModel') IS NOT NULL;

UPDATE sessions
SET context_overrides_json = json_remove(
  json_set(context_overrides_json, '$.sceneValidatorAutoRegen', context_overrides_json -> '$.presenceValidatorAutoRegen'),
  '$.presenceValidatorAutoRegen'
)
WHERE context_overrides_json IS NOT NULL
  AND json_extract(context_overrides_json, '$.presenceValidatorAutoRegen') IS NOT NULL;
