-- Corrected re-fold of campaign-scoped settings into RECYCLE-BIN sessions.
--
-- 0077 folded each campaign's `context_defaults_json` down into its sessions
-- (json_patch, session overrides winning) and then retired the campaign tier
-- from contextEngine.resolveSettings. Its fold predicate carried
-- `deleted_at IS NULL`, so a session sitting in the 30-day recycle bin at fold
-- time never received the campaign-inherited dials — and restoreSession only
-- clears deleted_at, it re-folds nothing. Such a session, once restored,
-- resolves embeddingModel / playerCharacterKeys / npcAgendaEnabled / the worker
-- model dials to the CODE defaults: wrong vector namespace for semantic
-- retrieval, PC-exclusion guard off, silently and with no system_event.
--
-- 0077 deliberately left `context_defaults_json` intact as inert fossil data
-- "so a corrected re-fold is possible" — this is that re-fold. Same statement
-- as 0077's fold, three differences:
--   * `deleted_at IS NOT NULL` — only the sessions 0077 skipped;
--   * a "lacks at least one campaign key" predicate, so a session that was
--     already folded (or set every key itself) is untouched — which also makes
--     the statement a no-op on re-run;
--   * json_valid guards on BOTH sides, because a malformed blob would abort the
--     whole migration (0077 had none on the session side; it happened to hold).
-- Sessions purged from the bin before this ran are gone — nothing to repair.
-- The fossil column stays (its clearing remains gated on migrating the
-- embeddingModel readers off it — see the 0077 header).

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
  AND deleted_at IS NOT NULL
  AND (context_overrides_json IS NULL OR context_overrides_json = '' OR json_valid(context_overrides_json))
  AND EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = sessions.campaign_id
      AND c.context_defaults_json IS NOT NULL
      AND json_valid(c.context_defaults_json)
      AND c.context_defaults_json <> '{}'
  )
  -- At least one campaign-carried setting key is absent from the session's
  -- own overrides. json_each over an empty object yields no rows, so a
  -- campaign whose blob held only the two state keys never matches.
  AND EXISTS (
    SELECT 1
    FROM campaigns c
    JOIN json_each(
           CASE WHEN json_valid(c.context_defaults_json)
                THEN json_remove(c.context_defaults_json, '$.antiRepetitionRules', '$.archivedAntiRepetitionRules')
                ELSE '{}' END
         ) AS k
    WHERE c.id = sessions.campaign_id
      AND json_type(COALESCE(NULLIF(sessions.context_overrides_json, ''), '{}'), '$.' || k.key) IS NULL
  );
