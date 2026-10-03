import type { UserRepository } from "../users/userRepository";
import type { CampaignRepository } from "../campaigns/campaignRepository";
import type { LorebookEmbeddingRepository } from "./lorebookEmbeddingRepository";
import { hasRecentSystemEvent, recordSystemEvent } from "../system/systemEvents";
import { resolveCampaignEmbedModel, type EmbedModelSessionSource } from "./embedModelResolver";

// Surface a coverage gap only when it's both proportionally and absolutely
// meaningful — tiny campaigns and a couple of in-flight entries aren't worth a row.
const GAP_RATIO_THRESHOLD = 0.15;
const GAP_ABSOLUTE_MIN = 10;

export interface EmbeddingCoverageDeps {
  users: Pick<UserRepository, "listAll">;
  campaigns: Pick<CampaignRepository, "listForUser">;
  embeddings: Pick<LorebookEmbeddingRepository, "countStatus">;
  // The campaign's ACTIVE model is its newest session's dial; the
  // monitor used to read the retired campaign fossil and so watched the wrong
  // namespace (0 missing under gemini while the session ran openai). Optional
  // only so createApp compiles until it is wired; unwired = default model.
  sessions?: EmbedModelSessionSource | null;
}

// Change-driven dedupe: a KNOWN, unchanged gap (e.g. a deliberately keyless
// campaign) must not re-warn every interval; that steady drumbeat once buried
// real thread_tracker errors.
// Re-emit only when the numbers change, or weekly as a standing reminder.
// Process-lifetime memory: one re-emit per deploy is acceptable.
const REMIND_MS = 7 * 24 * 60 * 60 * 1000;
const lastReported = new Map<string, { missing: number; stale: number; total: number; at: number }>();

// A campaign nobody has played for two weeks is dormant (2026-09-27): its gap
// degrades nothing until someone opens it again, and then the next check
// reports it. Two dormant campaigns of one account re-warned after every API
// restart (the in-process memory above resets per deploy), a drumbeat that
// became alert fatigue. The persistent check against system_events below
// keeps a known gap quiet across restarts too.
export const COVERAGE_ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Periodic watchdog: records a system_event when a campaign's lorebook has a
 * significant share of missing or stale embeddings under its active model. This
 * is how the stale-vector drift class (the kind that previously needed ad-hoc
 * backfill scripts) becomes visible instead of silently degrading retrieval.
 * Fully defensive — never throws (it runs on a timer).
 */
export function checkEmbeddingCoverage(deps: EmbeddingCoverageDeps): void {
  let users: { id: string }[] = [];
  try { users = deps.users.listAll(); } catch { return; }
  for (const user of users) {
    let campaigns: { id: string }[] = [];
    try { campaigns = deps.campaigns.listForUser(user.id); } catch { continue; }
    for (const campaign of campaigns) {
      try {
        const newest = deps.sessions?.findNewestForCampaign(user.id, campaign.id);
        const lastActive = newest?.updatedAt ? Date.parse(newest.updatedAt) : Number.NaN;
        if (deps.sessions && Number.isFinite(lastActive) && Date.now() - lastActive > COVERAGE_ACTIVE_WINDOW_MS) continue;
        const model = resolveCampaignEmbedModel(deps.sessions, user.id, campaign.id);
        const { total, indexed, stale, missing } = deps.embeddings.countStatus(user.id, campaign.id, model);
        const gap = missing + stale;
        if (total > 0 && gap >= GAP_ABSOLUTE_MIN && gap / total > GAP_RATIO_THRESHOLD) {
          const key = `${user.id}:${campaign.id}:${model}`;
          const prev = lastReported.get(key);
          const changed = !prev || prev.missing !== missing || prev.stale !== stale || prev.total !== total;
          if (!changed && Date.now() - (prev?.at ?? 0) < REMIND_MS) continue;
          lastReported.set(key, { missing, stale, total, at: Date.now() });
          const message = `embedding coverage gap: ${missing} missing + ${stale} stale of ${total} entries (${model}) — semantic retrieval incomplete`;
          // The same gap already reported this week (before a restart) stays quiet.
          if (hasRecentSystemEvent({ userId: user.id, source: "embed_coverage", campaignId: campaign.id, message, sinceIso: new Date(Date.now() - REMIND_MS).toISOString() })) continue;
          recordSystemEvent({
            userId: user.id, source: "embed_coverage", severity: "warn", campaignId: campaign.id,
            message,
            details: { total, indexed, stale, missing, model },
          });
        }
      } catch { /* per-campaign failure is non-fatal */ }
    }
  }
}
