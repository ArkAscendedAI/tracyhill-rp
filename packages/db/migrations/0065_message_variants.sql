-- 0065: message branching / swipes — variant groups on the append-only message log.
--
-- A regenerate no longer destroys the prior assistant reply. Instead the original
-- and each regeneration become SIBLINGS of one variant group, sharing the original
-- message's sort_order so the append-only log is never re-sequenced. Exactly one
-- sibling per group is active at a time.
--
-- variant_group_id: NULL for singletons (every existing row maps cleanly — a NULL
--   group is a lone active message). Minted on the first regenerate of a slot and
--   stamped onto the original message too.
-- variant_active: 1 for the sibling currently shown in the transcript, 0 for the
--   hidden alternatives. Existing rows default to 1 (all currently-visible).
--
-- Siblings SHARE sort_order (NOT tail-allocated): the transcript builder, cost/
-- stats, search, scene-rollback, and the windowing all filter on variant_active=1,
-- so the active sibling occupies the slot and the inactive ones are invisible
-- everywhere without re-sequencing the log.
ALTER TABLE messages ADD COLUMN variant_group_id TEXT;
ALTER TABLE messages ADD COLUMN variant_active INTEGER NOT NULL DEFAULT 1;

-- Lookups by group are per (session, user) scoped; this index serves the
-- variant-count join in getSessionDetail and the listVariantGroup / setActiveVariant
-- flips. NULL group_ids are sparse-skippable by SQLite on the group predicates.
CREATE INDEX IF NOT EXISTS idx_messages_variant_group
  ON messages(session_id, user_id, variant_group_id);
