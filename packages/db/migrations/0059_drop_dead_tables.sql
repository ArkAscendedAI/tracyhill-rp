-- Both tables are write-never: the only code references were the
-- account-deletion purge. chat_message_embeddings was
-- a planned V3 feature that never shipped (0040); pipeline_approvals_audit was
-- a quick win of the diff-based pipeline (0038) whose insert path was later removed.
DROP TABLE IF EXISTS chat_message_embeddings;
DROP TABLE IF EXISTS pipeline_approvals_audit;
