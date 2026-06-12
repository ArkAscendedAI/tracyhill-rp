ALTER TABLE sessions ADD COLUMN thinking_mode text NOT NULL DEFAULT 'off';
ALTER TABLE sessions ADD COLUMN thinking_budget integer;
ALTER TABLE sessions ADD COLUMN effort text;
ALTER TABLE sessions ADD COLUMN auto_scroll integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN input_tokens integer;
ALTER TABLE messages ADD COLUMN output_tokens integer;
ALTER TABLE messages ADD COLUMN total_tokens integer;
