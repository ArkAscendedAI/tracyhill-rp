-- Serving-model transparency (Fable 5 launch, 2026-06-09).
-- served_model records the model that actually produced an assistant message, as
-- reported by the upstream (message_start.message.model on direct Anthropic;
-- served_model on the bridge's final message_delta). NULL for user messages,
-- providers that don't report it, and all pre-existing rows. The UI shows a
-- "Served by" badge whenever this differs from the requested model's wire ID —
-- Fable 5 safeguard fallbacks can silently serve a turn from another model.
ALTER TABLE messages ADD COLUMN served_model TEXT;
