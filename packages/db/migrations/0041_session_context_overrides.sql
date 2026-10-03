-- V3: Per-session context overrides and per-campaign context defaults.
-- Both columns hold JSON with the same shape (mode, retrievalBudgetTokens,
-- semanticTopK, scanDepth, researcherEnabled, rollingEnabled, etc.).
-- Resolution order: session overrides -> campaign defaults -> hard-coded defaults.
ALTER TABLE sessions ADD COLUMN context_overrides_json TEXT;
ALTER TABLE campaigns ADD COLUMN context_defaults_json TEXT;
