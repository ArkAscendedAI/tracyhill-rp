-- 2026-08-29 model removals: remap retiring ids to successors.
--   kimi-k2.5                 -> kimi-k2.6                  (Moonshot sunset 2026-08-31)
--   gpt-5.4-codex-bridge      -> gpt-5.6-terra-codex-bridge (ChatGPT-side Codex retires 5.4 2026-08-31)
--   gpt-5.4-mini-codex-bridge -> gpt-5.6-luna-codex-bridge  (same)
-- Pairs with the same-day model-catalog removals. Historical messages keep
-- their original model_id on purpose (0060/0073 pattern). Post-0077, dials
-- live in sessions.context_overrides_json (not campaign defaults).

UPDATE sessions SET model_id = CASE model_id WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' ELSE model_id END
WHERE model_id IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pending_assistant_messages SET model_id = CASE model_id WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' ELSE model_id END
WHERE model_id IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE wizard_runs SET model_id = CASE model_id WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' ELSE model_id END
WHERE model_id IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE campaigns SET creative_model_id = CASE creative_model_id WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' ELSE creative_model_id END
WHERE creative_model_id IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.researcherModel', CASE json_extract(context_overrides_json, '$.researcherModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.researcherModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.hydeModel', CASE json_extract(context_overrides_json, '$.hydeModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.hydeModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.rollingModel', CASE json_extract(context_overrides_json, '$.rollingModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.rollingModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.sceneValidatorModel', CASE json_extract(context_overrides_json, '$.sceneValidatorModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.sceneValidatorModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.repetitionModel', CASE json_extract(context_overrides_json, '$.repetitionModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.repetitionModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.syspromptAuditModel', CASE json_extract(context_overrides_json, '$.syspromptAuditModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.syspromptAuditModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.auditModel', CASE json_extract(context_overrides_json, '$.auditModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.auditModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.driveModel', CASE json_extract(context_overrides_json, '$.driveModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.driveModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.worldTickModel', CASE json_extract(context_overrides_json, '$.worldTickModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.worldTickModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.dramatistModel', CASE json_extract(context_overrides_json, '$.dramatistModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.dramatistModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.antagonistModel', CASE json_extract(context_overrides_json, '$.antagonistModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.antagonistModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.worldStateModel', CASE json_extract(context_overrides_json, '$.worldStateModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.worldStateModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');
