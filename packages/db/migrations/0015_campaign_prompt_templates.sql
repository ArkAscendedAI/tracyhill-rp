ALTER TABLE campaigns ADD COLUMN update_prompt_template TEXT NOT NULL DEFAULT '';
ALTER TABLE campaigns ADD COLUMN system_prompt_update_template TEXT NOT NULL DEFAULT '';
