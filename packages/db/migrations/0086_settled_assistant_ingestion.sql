ALTER TABLE messages ADD COLUMN source_user_message_id TEXT;
ALTER TABLE messages ADD COLUMN ingestion_eligible INTEGER NOT NULL DEFAULT 0;

-- Historical producers ran on EVERY completion, including the latest reply and
-- disconnected pending output. Do not replay any of those turns after upgrade.
UPDATE messages SET source_user_message_id = (
  SELECT u.id FROM messages u
  WHERE u.session_id = messages.session_id AND u.user_id = messages.user_id
    AND u.role = 'user' AND u.sort_order < messages.sort_order
  ORDER BY u.sort_order DESC LIMIT 1
) WHERE role = 'assistant';

CREATE TABLE settled_assistant_ingestions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_user_message_id TEXT NOT NULL,
  source_user_content_hash TEXT,
  assistant_message_id TEXT NOT NULL,
  content_hash TEXT,
  settled_by_message_id TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (session_id, source_user_message_id)
);
INSERT OR IGNORE INTO settled_assistant_ingestions
  (session_id, user_id, source_user_message_id, assistant_message_id, ingested_at)
SELECT session_id, user_id, source_user_message_id, id, updated_at FROM messages
WHERE role = 'assistant' AND source_user_message_id IS NOT NULL
-- The active sibling is the accepted historical transcript boundary. Inactive
-- variants only fill receipts for a legacy turn with no active row remaining.
ORDER BY variant_active DESC, sort_order DESC, updated_at DESC, id;
INSERT OR IGNORE INTO settled_assistant_ingestions
  (session_id, user_id, source_user_message_id, assistant_message_id, ingested_at)
SELECT session_id, user_id, source_user_message_id, id, updated_at FROM pending_assistant_messages;

-- SQLite has no built-in SHA256. Legacy receipts start with NULL hashes and
-- remain valid until content changes. Invalidate those receipts in-place on
-- actual content edits, preserving their logical-turn key against re-ingestion.
-- Metadata-only writes and no-op content saves must keep the accepted window.
CREATE TRIGGER settled_assistant_legacy_content_changed
AFTER UPDATE OF content ON messages
WHEN OLD.content IS NOT NEW.content
BEGIN
  UPDATE settled_assistant_ingestions SET content_hash = ''
    WHERE assistant_message_id = NEW.id AND content_hash IS NULL;
  UPDATE settled_assistant_ingestions SET source_user_content_hash = ''
    WHERE source_user_message_id = NEW.id AND source_user_content_hash IS NULL;
END;
