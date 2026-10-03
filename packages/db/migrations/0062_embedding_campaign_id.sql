-- The semantic candidate pool was campaign-blind. lorebook_entry_embeddings
-- had no campaign_id, so listForUserAndModel(userId, model) returned EVERY
-- embedding the user owns across ALL campaigns; the top-K slice ran BEFORE the
-- engine filtered to the current campaign, starving in-campaign hits whenever a
-- user has two+ campaigns under one embedding model. Add campaign_id, backfill
-- it from the owning entry, and index (user_id, campaign_id, model) so the new
-- campaign-scoped query is cheap.
ALTER TABLE lorebook_entry_embeddings ADD COLUMN campaign_id TEXT;
UPDATE lorebook_entry_embeddings
  SET campaign_id = (
    SELECT campaign_id FROM lorebook_entries
    WHERE lorebook_entries.id = lorebook_entry_embeddings.entry_id
  );
CREATE INDEX idx_lee_campaign_model ON lorebook_entry_embeddings(user_id, campaign_id, model);
