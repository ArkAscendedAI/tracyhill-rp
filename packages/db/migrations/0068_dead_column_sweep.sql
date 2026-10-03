-- 0068: dead-column sweep. Drops the physical columns retired across the V1
-- state-seed era and the 2026-06-28 Engine-panel single-source change
-- (campaigns.pipeline_model_id). All verified unreferenced by any index,
-- trigger, or view in the live schema; the pipeline_model_id Drizzle mapping
-- and its write paths are removed in the same commit.

ALTER TABLE campaigns DROP COLUMN state_seed;
ALTER TABLE campaigns DROP COLUMN update_prompt_template;
ALTER TABLE campaigns DROP COLUMN system_prompt_update_template;
ALTER TABLE campaigns DROP COLUMN pipeline_version;
ALTER TABLE campaigns DROP COLUMN validation_model_id;
ALTER TABLE campaigns DROP COLUMN state_seed_legacy_at;
ALTER TABLE campaigns DROP COLUMN kind_registry;
ALTER TABLE campaigns DROP COLUMN pipeline_model_id;

ALTER TABLE sessions DROP COLUMN state_seed;
ALTER TABLE sessions DROP COLUMN state_seed_legacy_at;

ALTER TABLE campaign_versions DROP COLUMN state_seed;

ALTER TABLE wizard_templates DROP COLUMN example_state_seed;
ALTER TABLE wizard_templates DROP COLUMN seed_update_template;
ALTER TABLE wizard_templates DROP COLUMN system_prompt_update_template;
