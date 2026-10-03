-- Campaign-scoped SETTINGS are retired. The Engine (context) panel is the single
-- source of truth for every dial, and every dial is per-session.
--
-- The 2026-06-28 single-source change (831e273) removed the campaign editor's
-- Context tab but left two settings behind on the campaign side, and nothing
-- surfaced the inconsistency:
--   * `playerCharacterKeys` was readable ONLY from campaign contextDefaults
--     (driveUpdateWorker) with its only UI in the campaign editor — structurally
--     invisible to the Engine panel. Consequence: it stayed at its `[]` default,
--     the PC-exclusion guard never fired once, and the player's own protagonist
--     accumulated a worker-maintained drive sheet that was injected as an agenda
--     to service every turn (a sycophancy vector aimed at the PC).
--   * `npcAgendaEnabled` existed at BOTH scopes with different values on one campaign
--     (campaign 0, session 1) — a live split brain on one flag.
--
-- This migration makes the subsequent code change (dropping the campaign-defaults
-- merge from contextEngine.resolveSettings) behaviorally a NO-OP rather than a
-- silent settings reset: campaign settings are folded down into every session
-- FIRST, preserving the old precedence exactly.
--
-- Settings that were live at campaign scope when this was written (they would
-- otherwise have been silently lost): embeddingModel (9 campaigns), rollingModel,
-- researcherModel, retrievalBudgetTokens, mode (2 each), driveModel,
-- worldTickModel, npcAgendaEnabled (1 each), and playerCharacterKeys (2,
-- already set on two campaigns).
--
-- `context_defaults_json` is deliberately NOT cleared here. The fold is the
-- preservation step, and leaving the original values as inert fossil data means a
-- corrected re-fold is possible if this migration proves wrong on a live campaign.
-- Regrowth is prevented structurally instead — `contextDefaults` is removed from
-- the campaign contracts and `resolveSettings` no longer accepts a campaign
-- argument, so no code can read a setting from campaign scope without a
-- deliberate new addition. A follow-up migration clears the fossil once this has
-- been verified in production.
--
-- ⚠ BLOCKER ON CLEARING THE FOSSIL: four surfaces still resolve `embeddingModel`
-- from campaign scope — contextRoutes.resolveCampaignEmbedModel,
-- embeddingCoverageMonitor, lorebookService, and an offline re-embed maintenance script.
-- They read correctly TODAY only because the fossil is intact (9 campaigns carried
-- an embeddingModel here). Clearing it before they are migrated to
-- campaignService.resolveFromNewestSession would silently drop them to the default
-- embedding model — i.e. reporting and rebuilding against the WRONG vector
-- namespace, and spending paid embedding calls to do it. Migrate those four first.

-- 1. Anti-repetition rules are STATE, not settings: the repetition-detection
--    worker WRITES them back every run. They were the only genuinely
--    campaign-scoped thing in the settings blob, which is exactly why the blob
--    kept looking load-bearing. Give them their own column.
ALTER TABLE campaigns ADD COLUMN anti_repetition_json TEXT;

UPDATE campaigns
SET anti_repetition_json = json_object(
      'antiRepetitionRules',
      json(COALESCE(json_extract(context_defaults_json, '$.antiRepetitionRules'), '[]')),
      'archivedAntiRepetitionRules',
      json(COALESCE(json_extract(context_defaults_json, '$.archivedAntiRepetitionRules'), '[]'))
    )
WHERE context_defaults_json IS NOT NULL
  AND json_valid(context_defaults_json)
  AND (
    json_extract(context_defaults_json, '$.antiRepetitionRules') IS NOT NULL
    OR json_extract(context_defaults_json, '$.archivedAntiRepetitionRules') IS NOT NULL
  );

-- 2. Fold campaign settings down into every live session of that campaign.
--    json_patch(base, overlay) merges overlay over base with overlay winning —
--    identical precedence to the retired
--    `{...buildDefaults(), ...campaignDefaults, ...sessionOverrides}`. A session
--    that already set a key keeps its own value; a session that never set it
--    inherits what the campaign was supplying, so nothing changes behaviorally.
--    The two state keys are stripped from the base so they don't leak into
--    session settings.
UPDATE sessions
SET context_overrides_json = json_patch(
      (
        SELECT json_remove(
                 COALESCE(NULLIF(c.context_defaults_json, ''), '{}'),
                 '$.antiRepetitionRules',
                 '$.archivedAntiRepetitionRules'
               )
        FROM campaigns c
        WHERE c.id = sessions.campaign_id
      ),
      COALESCE(NULLIF(context_overrides_json, ''), '{}')
    )
WHERE campaign_id IS NOT NULL
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = sessions.campaign_id
      AND c.context_defaults_json IS NOT NULL
      AND json_valid(c.context_defaults_json)
      AND c.context_defaults_json <> '{}'
  );

-- Note on campaigns with zero live sessions: their campaign settings have no
-- fold target and are dropped. This is a no-op in practice — a campaign with no
-- session already resolved to code defaults on its next new session (new
-- sessions clone the most-recent session's dials, and there is none), so no
-- behavior changes. Verified zero affected campaigns carried settings at write
-- time.
