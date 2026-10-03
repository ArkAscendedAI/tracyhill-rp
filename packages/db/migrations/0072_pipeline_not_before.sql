-- 0072: resume-on-failure cooldown for campaign_audit (and any future kind).
-- A queued run whose not_before is in the future is skipped by the claim query
-- until then. The campaign audit uses this to self-requeue on a transient error
-- (rate-limit / overload / network / hung call) — keeping its checkpoint and the
-- tokens already spent — instead of failing terminally. NULL = eligible now
-- (every existing + normal run).
ALTER TABLE pipeline_runs ADD COLUMN not_before TEXT;
