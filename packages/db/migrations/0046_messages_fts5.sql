-- FTS5 full-text search index on message content.
-- Uses external-content mode synced to the messages table via triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

-- Populate from existing messages
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');

-- Keep FTS index in sync with messages table
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete BEFORE DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
  INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;
