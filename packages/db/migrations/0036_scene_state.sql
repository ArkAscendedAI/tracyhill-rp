-- Scene state tracking for in-session knowledge boundary enforcement.
-- sceneData on messages stores parsed scene metadata per assistant response.
-- Session-level columns track the current scene state for system prompt injection.
-- Campaign character_roster tracks all named characters for NOT PRESENT computation.

ALTER TABLE messages ADD COLUMN scene_data TEXT;

ALTER TABLE sessions ADD COLUMN scene_location TEXT;
ALTER TABLE sessions ADD COLUMN scene_present TEXT DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN scene_present_unaware TEXT DEFAULT '[]';

ALTER TABLE campaigns ADD COLUMN character_roster TEXT DEFAULT '[]';
