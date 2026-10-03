-- Completes the 0082 catch-up: 0082 remapped
-- the 2026-08-29 retired ids inside `pipeline_runs.details_json` for the nine
-- keys 0073 knew plus `recapModel`, but the world-tick enqueue writes two more —
-- `worldTickModel` and `dramatistModel` (pipelineQueueService, read back by the
-- world-tick worker) — and 0073 had the same omission for `worldTickModel`.
-- Same id map and predicate shape as 0082; idempotent. The queue has drained
-- every run of that window long ago, so this is a no-op on current data and a
-- correct template for the next remap: derive the key list from EVERY
-- `detailsJson: JSON.stringify({...})` in pipelineQueueService + campaignAuditService.
--   kimi-k2.5                 -> kimi-k2.6
--   gpt-5.4-codex-bridge      -> gpt-5.6-terra-codex-bridge
--   gpt-5.4-mini-codex-bridge -> gpt-5.6-luna-codex-bridge

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.worldTickModel', CASE json_extract(details_json, '$.worldTickModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.worldTickModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.dramatistModel', CASE json_extract(details_json, '$.dramatistModel') WHEN 'kimi-k2.5' THEN 'kimi-k2.6' WHEN 'gpt-5.4-codex-bridge' THEN 'gpt-5.6-terra-codex-bridge' WHEN 'gpt-5.4-mini-codex-bridge' THEN 'gpt-5.6-luna-codex-bridge' END)
WHERE details_json IS NOT NULL AND json_valid(details_json) AND json_extract(details_json, '$.dramatistModel') IN ('kimi-k2.5','gpt-5.4-codex-bridge','gpt-5.4-mini-codex-bridge');
