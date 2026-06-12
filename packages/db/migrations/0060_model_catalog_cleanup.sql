-- 2026-06-12 provider audit cleanup: remap retired/renamed model ids to their
-- catalog successors. Pairs with the same-day model-catalog changes.
--
-- Removed (provider retired or upstream-redirected):
--   claude-sonnet-4-20250514 -> claude-sonnet-4-6   (Anthropic retires 06-15; real ctx was 200K)
--   grok-4 / grok-4-fast-* / grok-4-1-fast-* / grok-3 / grok-3-mini -> grok-4.3
--                                                    (xAI retired 05-15; slugs silently served grok-4.3)
--   deepseek-chat / deepseek-reasoner -> deepseek-v4-flash (aliases of it; retire 07-24)
--   o3 -> gpt-5.4, o4-mini -> gpt-5.4-mini, gpt-4.1-nano -> gpt-5.4-nano (OpenAI shutdowns)
-- Renamed (same model, corrected id — messages remapped too so history/cost stay intact):
--   gpt-5-5 -> gpt-5.5
--   grok-4.20-beta-0309-(non-)reasoning -> grok-4.20-0309-(non-)reasoning (GA id)
--
-- Removed-model historical messages keep their original model_id on purpose:
-- they record which model actually produced the turn.

-- ── Scalar columns: full remap (removals + renames) ──────────────────────────

UPDATE sessions SET model_id = CASE model_id
  WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN 'grok-4' THEN 'grok-4.3'
  WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-3' THEN 'grok-4.3'
  WHEN 'grok-3-mini' THEN 'grok-4.3'
  WHEN 'deepseek-chat' THEN 'deepseek-v4-flash'
  WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
  WHEN 'o3' THEN 'gpt-5.4'
  WHEN 'o4-mini' THEN 'gpt-5.4-mini'
  WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
  WHEN 'gpt-5-5' THEN 'gpt-5.5'
  WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning'
  WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  ELSE model_id END
WHERE model_id IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE pending_assistant_messages SET model_id = CASE model_id
  WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN 'grok-4' THEN 'grok-4.3'
  WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-3' THEN 'grok-4.3'
  WHEN 'grok-3-mini' THEN 'grok-4.3'
  WHEN 'deepseek-chat' THEN 'deepseek-v4-flash'
  WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
  WHEN 'o3' THEN 'gpt-5.4'
  WHEN 'o4-mini' THEN 'gpt-5.4-mini'
  WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
  WHEN 'gpt-5-5' THEN 'gpt-5.5'
  WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning'
  WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  ELSE model_id END
WHERE model_id IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE campaigns SET pipeline_model_id = CASE pipeline_model_id
  WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN 'grok-4' THEN 'grok-4.3'
  WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-3' THEN 'grok-4.3'
  WHEN 'grok-3-mini' THEN 'grok-4.3'
  WHEN 'deepseek-chat' THEN 'deepseek-v4-flash'
  WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
  WHEN 'o3' THEN 'gpt-5.4'
  WHEN 'o4-mini' THEN 'gpt-5.4-mini'
  WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
  WHEN 'gpt-5-5' THEN 'gpt-5.5'
  WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning'
  WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  ELSE pipeline_model_id END
WHERE pipeline_model_id IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE campaigns SET creative_model_id = CASE creative_model_id
  WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN 'grok-4' THEN 'grok-4.3'
  WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-3' THEN 'grok-4.3'
  WHEN 'grok-3-mini' THEN 'grok-4.3'
  WHEN 'deepseek-chat' THEN 'deepseek-v4-flash'
  WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
  WHEN 'o3' THEN 'gpt-5.4'
  WHEN 'o4-mini' THEN 'gpt-5.4-mini'
  WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
  WHEN 'gpt-5-5' THEN 'gpt-5.5'
  WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning'
  WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  ELSE creative_model_id END
WHERE creative_model_id IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE wizard_runs SET model_id = CASE model_id
  WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
  WHEN 'grok-4' THEN 'grok-4.3'
  WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3'
  WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
  WHEN 'grok-3' THEN 'grok-4.3'
  WHEN 'grok-3-mini' THEN 'grok-4.3'
  WHEN 'deepseek-chat' THEN 'deepseek-v4-flash'
  WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
  WHEN 'o3' THEN 'gpt-5.4'
  WHEN 'o4-mini' THEN 'gpt-5.4-mini'
  WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
  WHEN 'gpt-5-5' THEN 'gpt-5.5'
  WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning'
  WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  ELSE model_id END
WHERE model_id IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

-- ── messages: pure renames only (same model, corrected id) ───────────────────

UPDATE messages SET model_id = 'gpt-5.5' WHERE model_id = 'gpt-5-5';
UPDATE messages SET model_id = 'grok-4.20-0309-reasoning' WHERE model_id = 'grok-4.20-beta-0309-reasoning';
UPDATE messages SET model_id = 'grok-4.20-0309-non-reasoning' WHERE model_id = 'grok-4.20-beta-0309-non-reasoning';

-- ── JSON blob fields: per-key remap via json_set ─────────────────────────────
-- campaigns.context_defaults_json + sessions.context_overrides_json hold
-- rollingModel / researcherModel / hydeModel / sceneValidatorModel;
-- pipeline_runs.details_json holds rollingModel / consolidationModel /
-- archivalModel / trackerModel. embeddingModel keys untouched (no embedding
-- catalog changes).

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.rollingModel',
  CASE json_extract(context_defaults_json, '$.rollingModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.rollingModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.researcherModel',
  CASE json_extract(context_defaults_json, '$.researcherModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.researcherModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.hydeModel',
  CASE json_extract(context_defaults_json, '$.hydeModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.hydeModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE campaigns SET context_defaults_json = json_set(context_defaults_json, '$.sceneValidatorModel',
  CASE json_extract(context_defaults_json, '$.sceneValidatorModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE context_defaults_json IS NOT NULL AND json_extract(context_defaults_json, '$.sceneValidatorModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.rollingModel',
  CASE json_extract(context_overrides_json, '$.rollingModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.rollingModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.researcherModel',
  CASE json_extract(context_overrides_json, '$.researcherModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.researcherModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.hydeModel',
  CASE json_extract(context_overrides_json, '$.hydeModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.hydeModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE sessions SET context_overrides_json = json_set(context_overrides_json, '$.sceneValidatorModel',
  CASE json_extract(context_overrides_json, '$.sceneValidatorModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE context_overrides_json IS NOT NULL AND json_extract(context_overrides_json, '$.sceneValidatorModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.rollingModel',
  CASE json_extract(details_json, '$.rollingModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.rollingModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.consolidationModel',
  CASE json_extract(details_json, '$.consolidationModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.consolidationModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.archivalModel',
  CASE json_extract(details_json, '$.archivalModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.archivalModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');

UPDATE pipeline_runs SET details_json = json_set(details_json, '$.trackerModel',
  CASE json_extract(details_json, '$.trackerModel')
    WHEN 'claude-sonnet-4-20250514' THEN 'claude-sonnet-4-6'
    WHEN 'grok-4' THEN 'grok-4.3' WHEN 'grok-4-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-4-1-fast-reasoning' THEN 'grok-4.3' WHEN 'grok-4-1-fast-non-reasoning' THEN 'grok-4.3'
    WHEN 'grok-3' THEN 'grok-4.3' WHEN 'grok-3-mini' THEN 'grok-4.3'
    WHEN 'deepseek-chat' THEN 'deepseek-v4-flash' WHEN 'deepseek-reasoner' THEN 'deepseek-v4-flash'
    WHEN 'o3' THEN 'gpt-5.4' WHEN 'o4-mini' THEN 'gpt-5.4-mini' WHEN 'gpt-4.1-nano' THEN 'gpt-5.4-nano'
    WHEN 'gpt-5-5' THEN 'gpt-5.5'
    WHEN 'grok-4.20-beta-0309-reasoning' THEN 'grok-4.20-0309-reasoning' WHEN 'grok-4.20-beta-0309-non-reasoning' THEN 'grok-4.20-0309-non-reasoning'
  END)
WHERE details_json IS NOT NULL AND json_extract(details_json, '$.trackerModel') IN ('claude-sonnet-4-20250514','grok-4','grok-4-fast-reasoning','grok-4-fast-non-reasoning','grok-4-1-fast-reasoning','grok-4-1-fast-non-reasoning','grok-3','grok-3-mini','deepseek-chat','deepseek-reasoner','o3','o4-mini','gpt-4.1-nano','gpt-5-5','grok-4.20-beta-0309-reasoning','grok-4.20-beta-0309-non-reasoning');
