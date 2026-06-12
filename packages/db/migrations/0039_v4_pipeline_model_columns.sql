-- V4 pipeline: per-run model selection. Two model slots replace the single
-- pipelineModelId for the new 4-pass pipeline (creative + validation).
ALTER TABLE campaigns ADD COLUMN creative_model_id TEXT;
ALTER TABLE campaigns ADD COLUMN validation_model_id TEXT;
