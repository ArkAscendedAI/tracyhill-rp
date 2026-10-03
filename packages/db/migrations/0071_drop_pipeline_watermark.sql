-- 0071: campaign-audit sunset (2026-07-11). The watermark mechanism is retired
-- wholesale: audits read from message 1 every run, nothing is ever "past review", and the requireMutable
-- edit-lock is removed in the same commit — every historical message becomes
-- editable again and the next full audit reconciles the lorebook to the edited
-- story. The campaign_review pipeline kind is retired in the same change;
-- historical campaign_review runs stay readable in pipeline_runs.

ALTER TABLE sessions DROP COLUMN pipeline_watermark;
