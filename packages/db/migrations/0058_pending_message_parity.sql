-- Pending assistant messages (disconnected-client recovery) were a lossy shadow
-- of the real message path: refusal categorization (0055), the fast-mode billing
-- flag, served-model transparency (0056), the scene block, and overhead
-- accounting were all silently dropped on recovery.
ALTER TABLE pending_assistant_messages ADD COLUMN stop_reason TEXT;
ALTER TABLE pending_assistant_messages ADD COLUMN stop_details_json TEXT;
ALTER TABLE pending_assistant_messages ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_assistant_messages ADD COLUMN served_model TEXT;
ALTER TABLE pending_assistant_messages ADD COLUMN scene_data TEXT;
ALTER TABLE pending_assistant_messages ADD COLUMN overhead_json TEXT;
