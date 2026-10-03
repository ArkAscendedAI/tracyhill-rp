-- Reasoning/thinking token itemization (display-only; reasoning is already
-- inside output_tokens for billing on every provider).
ALTER TABLE messages ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE pending_assistant_messages ADD COLUMN reasoning_tokens INTEGER;
