-- 2026-07-12 OpenAI July shutdown wave: remap retiring model ids to their
-- OFFICIAL OpenAI replacements (developers.openai.com/api/docs/deprecations).
--   gpt-5.1-codex-mini -> gpt-5.4-mini   (API shutdown 2026-07-23)
--   gpt-5              -> gpt-5.5        (dated snapshot removal 2026-12-11)
--   gpt-5-mini         -> gpt-5.4-mini   (dated snapshot removal 2026-12-11)
--   gpt-5-nano         -> gpt-5.4-nano   (dated snapshot removal 2026-12-11)
-- Pairs with the same-day model-catalog removals (GPT-5.6 family wave).
-- Historical messages keep their original model_id on purpose (0060 pattern):
-- they record which model actually produced the turn.

UPDATE sessions SET model_id = CASE model_id WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' ELSE model_id END
WHERE model_id IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pending_assistant_messages SET model_id = CASE model_id WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' ELSE model_id END
WHERE model_id IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE wizard_runs SET model_id = CASE model_id WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' ELSE model_id END
WHERE model_id IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.researcherModel', CASE json_extract(context_defaults_json, '$.researcherModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.researcherModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.hydeModel', CASE json_extract(context_defaults_json, '$.hydeModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.hydeModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.rollingModel', CASE json_extract(context_defaults_json, '$.rollingModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.rollingModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.sceneValidatorModel', CASE json_extract(context_defaults_json, '$.sceneValidatorModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.sceneValidatorModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.driveModel', CASE json_extract(context_defaults_json, '$.driveModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.driveModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.worldTickModel', CASE json_extract(context_defaults_json, '$.worldTickModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.worldTickModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.repetitionModel', CASE json_extract(context_defaults_json, '$.repetitionModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.repetitionModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.syspromptAuditModel', CASE json_extract(context_defaults_json, '$.syspromptAuditModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.syspromptAuditModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.auditModel', CASE json_extract(context_defaults_json, '$.auditModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.auditModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.researcherModel', CASE json_extract(context_overrides_json, '$.researcherModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.researcherModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.hydeModel', CASE json_extract(context_overrides_json, '$.hydeModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.hydeModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.rollingModel', CASE json_extract(context_overrides_json, '$.rollingModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.rollingModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.sceneValidatorModel', CASE json_extract(context_overrides_json, '$.sceneValidatorModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.sceneValidatorModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.driveModel', CASE json_extract(context_overrides_json, '$.driveModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.driveModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.worldTickModel', CASE json_extract(context_overrides_json, '$.worldTickModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.worldTickModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.repetitionModel', CASE json_extract(context_overrides_json, '$.repetitionModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.repetitionModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.syspromptAuditModel', CASE json_extract(context_overrides_json, '$.syspromptAuditModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.syspromptAuditModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.auditModel', CASE json_extract(context_overrides_json, '$.auditModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.auditModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.rollingModel', CASE json_extract(details_json, '$.rollingModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.rollingModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.consolidationModel', CASE json_extract(details_json, '$.consolidationModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.consolidationModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.archivalModel', CASE json_extract(details_json, '$.archivalModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.archivalModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.trackerModel', CASE json_extract(details_json, '$.trackerModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.trackerModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.repetitionModel', CASE json_extract(details_json, '$.repetitionModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.repetitionModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.auditModel', CASE json_extract(details_json, '$.auditModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.auditModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.driveModel', CASE json_extract(details_json, '$.driveModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.driveModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.syspromptAuditModel', CASE json_extract(details_json, '$.syspromptAuditModel') WHEN 'gpt-5.1-codex-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5' THEN 'gpt-5.5' WHEN 'gpt-5-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-5-nano' THEN 'gpt-5.4-nano' END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.syspromptAuditModel') IN ('gpt-5.1-codex-mini','gpt-5','gpt-5-mini','gpt-5-nano');
