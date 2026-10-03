-- Add indexes on frequently queried foreign key columns
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_lorebook_entries_campaign_id ON lorebook_entries(campaign_id);
CREATE INDEX IF NOT EXISTS idx_lorebook_entries_user_id ON lorebook_entries(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lorebook_activation_state_pk ON lorebook_activation_state(session_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_embeddings_session ON chat_message_embeddings(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_embeddings_message ON chat_message_embeddings(message_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_campaign ON pipeline_runs(campaign_id);
