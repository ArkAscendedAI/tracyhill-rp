-- Catch-up for the 2026-08-29 model remap (0080), which stopped at
-- sessions and never touched `pipeline_runs.details_json` the way 0060 and
-- 0073 did. A run that was queued (or `not_before`-cooled) at that deploy with
-- a retired id in its details is claimed later and fails on an unknown model
-- instead of being retargeted like every other stored reference. Same id map
-- as 0080; same key list as 0073 plus `recapModel` (the recap kind postdates
-- 0073). Historical terminal rows are remapped too, matching 0060/0073 — the
-- `WHERE … IN (…)` predicate makes every statement idempotent.
--   kimi-k2.5                 -> kimi-k2.6
--   gpt-5.4-codex-bridge      -> gpt-5.6-terra-codex-bridge
--   gpt-5.4-mini-codex-bridge -> gpt-5.6-luna-codex-bridge

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.rollingModel', CASE json_extract(details_json, '$.rollingModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.rollingModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.consolidationModel', CASE json_extract(details_json, '$.consolidationModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.consolidationModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.archivalModel', CASE json_extract(details_json, '$.archivalModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.archivalModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.trackerModel', CASE json_extract(details_json, '$.trackerModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.trackerModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.repetitionModel', CASE json_extract(details_json, '$.repetitionModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.repetitionModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.auditModel', CASE json_extract(details_json, '$.auditModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.auditModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.driveModel', CASE json_extract(details_json, '$.driveModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.driveModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.syspromptAuditModel', CASE json_extract(details_json, '$.syspromptAuditModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.syspromptAuditModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.recapModel', CASE json_extract(details_json, '$.recapModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.recapModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');
