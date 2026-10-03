-- Per-reply context snapshots.
-- The context assembly of a chat turn (the `response.context` event: preview
-- rows, notes, budget) used to live only in the browser's stream state, so a
-- reload or an older reply showed nothing. One row per assistant reply holds
-- the snapshot JSON (contract `messageContextSnapshotSchema`, version 1). The
-- API upserts a reply's row and then deletes the session's rows beyond the
-- newest 50 by created_at, in one transaction. A row goes with its message,
-- its session and its user (ON DELETE CASCADE on all three). Additive: no
-- existing row is read or changed, and replies written before this migration
-- simply have no snapshot.
CREATE TABLE IF NOT EXISTS message_context_snapshots (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

-- The prune (newest 50 per session) and the per-session id list read by session.
CREATE INDEX IF NOT EXISTS message_context_snapshots_session_created_idx
  ON message_context_snapshots (session_id, created_at);
