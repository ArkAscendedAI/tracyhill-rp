import { and, eq, lt } from "drizzle-orm";

import { pipelineRuns } from "@tracyhill-rp/db";

import type { DatabaseClient } from "@tracyhill-rp/db";

type Db = DatabaseClient["db"];

// Worker-side queue-health check:
// detect runs sitting `queued` too long from the worker's own vantage.
// The worker is single-flight PER CAMPAIGN LANE (slow = campaign_audit
// only, fast = everything else; per campaign since 2026-10-02, when every
// campaign got its own pair: pipelineWorker.drainLane runs one job at a time in
// each), so a queued run behind a live `running` run in its campaign's lane is
// legitimate. The short window therefore fires only when the run's own lane is
// idle; the long window fires regardless (nothing should wait an hour). Until
// 2026-10-02 the lanes were shared, and a run waiting behind another campaign's
// jobs tripped the long window daily.
// Heartbeat write/read helpers live in @tracyhill-rp/db (shared with the API).
//
// Per-campaign serialization: the picker
// (pipelineRunRepository.findNextQueuedRespectingCampaignLock) refuses an
// `audit_ruling` while ITS campaign has any running run, and a `campaign_audit`
// while its campaign's audit or ruling runs.
// Those queued runs are waiting BY DESIGN for as long as their blocker is
// alive (heartbeating within the stale-lock window) — an audit runs 40–90 min
// documented, hours at max effort — so neither window fires for them. A stale
// blocker is the sweep's problem; once it stops beating the normal windows
// apply and the run is reported like any other.

const QUEUED_IDLE_WEDGE_MS = 15 * 60 * 1000;
const QUEUED_HARD_WEDGE_MS = 60 * 60 * 1000;
// Mirrors the stale-lock sweep (pipelineQueueService / pipelineWorker): a
// running row with a heartbeat older than this is being reaped, not waited on.
const BLOCKER_LIVE_MS = 60 * 60 * 1000;

export type WorkerLane = "fast" | "slow";

/** The lane a kind runs in — mirrors pipelineRunRepository's lane SQL. */
export function laneOf(kind: string): WorkerLane {
  return kind === "campaign_audit" ? "slow" : "fast";
}

export interface WedgedRun {
  id: string;
  userId: string;
  campaignId: string;
  kind: string;
  requestedAt: string;
  reason: "queued-while-lane-idle" | "queued-past-hard-limit";
}

export function findWedgedQueuedRuns(db: Db, now = Date.now()): WedgedRun[] {
  const idleCutoff = new Date(now - QUEUED_IDLE_WEDGE_MS).toISOString();
  const hardCutoff = new Date(now - QUEUED_HARD_WEDGE_MS).toISOString();

  const queued = db
    .select({
      id: pipelineRuns.id,
      userId: pipelineRuns.userId,
      campaignId: pipelineRuns.campaignId,
      kind: pipelineRuns.kind,
      requestedAt: pipelineRuns.requestedAt,
      notBefore: pipelineRuns.notBefore,
    })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.status, "queued"), lt(pipelineRuns.requestedAt, idleCutoff)))
    .all();
  if (queued.length === 0) return [];

  // Resume-cooldown runs (not_before in the future) are waiting by design.
  const nowIso = new Date(now).toISOString();
  const eligible = queued.filter((r) => !r.notBefore || r.notBefore <= nowIso);
  if (eligible.length === 0) return [];

  // Lane occupancy is per campaign since 2026-10-02: each campaign has its own fast and slow lane.
  const runningRows = db
    .select({ kind: pipelineRuns.kind, campaignId: pipelineRuns.campaignId, updatedAt: pipelineRuns.updatedAt })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.status, "running"))
    .all();
  const busyLanes = new Set<string>(runningRows.map((r) => `${laneOf(r.kind)}:${r.campaignId}`));
  const liveCutoff = new Date(now - BLOCKER_LIVE_MS).toISOString();
  const liveRunning = runningRows.filter((r) => r.updatedAt >= liveCutoff);

  const wedged: WedgedRun[] = [];
  for (const run of eligible) {
    if (waitingByDesign(run, liveRunning)) continue;
    if (run.requestedAt < hardCutoff) {
      wedged.push({ ...base(run), reason: "queued-past-hard-limit" });
    } else if (!busyLanes.has(`${laneOf(run.kind)}:${run.campaignId}`)) {
      wedged.push({ ...base(run), reason: "queued-while-lane-idle" });
    }
  }
  return wedged;

  function base(run: (typeof eligible)[number]) {
    return {
      id: run.id,
      userId: run.userId,
      campaignId: run.campaignId ?? "",
      kind: run.kind,
      requestedAt: run.requestedAt,
    };
  }
}

/** The picker's own serialization rules, applied to LIVE blockers only:
 *  a queued run the picker would refuse right now because a heartbeating run
 *  holds it back is not wedged, however long it has waited. Exported for tests. */
export function waitingByDesign(
  run: { kind: string; campaignId: string | null },
  liveRunning: Array<{ kind: string; campaignId: string | null }>,
): boolean {
  if (run.kind === "audit_ruling") {
    return liveRunning.some((r) => r.campaignId === run.campaignId);
  }
  if (run.kind === "campaign_audit") {
    // Its own campaign's audit or ruling only: another campaign's audit runs in that campaign's lane (2026-10-02).
    return liveRunning.some((r) => r.campaignId === run.campaignId && (r.kind === "campaign_audit" || r.kind === "audit_ruling"));
  }
  return false;
}
