ALTER TABLE messages ADD COLUMN cache_read_tokens integer;
ALTER TABLE messages ADD COLUMN cache_write_tokens integer;
ALTER TABLE pending_assistant_messages ADD COLUMN cache_read_tokens integer;
ALTER TABLE pending_assistant_messages ADD COLUMN cache_write_tokens integer;
