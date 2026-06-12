-- Both tables are write-never (verified by the 2026-06-10 audits): the only
-- code references were the account-deletion purge. chat_message_embeddings was
-- a planned V3 feature that never shipped (0040); pipeline_approvals_audit was
-- an F2 quick-win whose insert path was removed in the F2 purge (0038).
DROP TABLE IF EXISTS chat_message_embeddings;
DROP TABLE IF EXISTS pipeline_approvals_audit;
