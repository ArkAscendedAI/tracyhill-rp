-- Fix: messages_session_sort_idx (0003) was UNIQUE on
-- (session_id, sort_order), which made the variant design impossible — siblings
-- of a variant group deliberately SHARE their slot's sort_order, so the first
-- regenerate hit SQLITE_CONSTRAINT_UNIQUE. Replace it with:
--   1. the same-named NON-unique index (keeps the ordering/range-scan plans and
--      the 0063 redundancy analysis intact), and
--   2. a partial UNIQUE index over ACTIVE rows only — a STRONGER invariant than
--      before: exactly one visible message per slot, while inactive siblings
--      coexist underneath it.
DROP INDEX IF EXISTS messages_session_sort_idx;
CREATE INDEX messages_session_sort_idx ON messages(session_id, sort_order);
CREATE UNIQUE INDEX messages_session_sort_active_uq ON messages(session_id, sort_order) WHERE variant_active = 1;
