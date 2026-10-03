-- The per-session defaults become the values tuned on a long-running campaign, models excepted
-- (packages/contracts/src/context.ts). No running session may change, so every session that did not set
-- one of the twelve changed dials itself gets the OLD default written into its overrides; a session with no overrides
-- (NULL or blank) gets an object holding them. Overrides that are not valid JSON are left alone. Each statement only
-- fills an absent key, so it is idempotent.
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.mode', 'keyword')
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.mode') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.retrievalBudgetTokens', 16000)
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.retrievalBudgetTokens') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.contextBudgetTokens', 200000)
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.contextBudgetTokens') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.guaranteedMessageCount', 20)
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.guaranteedMessageCount') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.dramatistEnabled', json('false'))
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.dramatistEnabled') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.dramatistIntensity', 'restrained')
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.dramatistIntensity') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.tickEveryNthRollingDiff', 2)
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.tickEveryNthRollingDiff') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.worldTickAutoApply', json('false'))
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.worldTickAutoApply') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.sceneValidatorAutoRegen', json('true'))
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.sceneValidatorAutoRegen') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.openaiFastModeEnabled', json('false'))
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.openaiFastModeEnabled') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.worldStance', 1)
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.worldStance') IS NULL;
UPDATE sessions SET context_overrides_json = json_set(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.depictionTier', 0)
  WHERE json_valid(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}')) AND json_type(COALESCE(NULLIF(trim(context_overrides_json), ''), '{}'), '$.depictionTier') IS NULL;
