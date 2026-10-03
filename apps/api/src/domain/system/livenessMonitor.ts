import { and, desc, gt, inArray, isNotNull, isNull, or, eq, sql } from "drizzle-orm";

import { campaigns, characterDrives, pipelineRuns, readHeartbeat, sessions, WORKER_SERVICE } from "@tracyhill-rp/db";
import { contextSettingsSchema } from "@tracyhill-rp/contracts";

import { recordSystemEvent, SYSTEM_EVENT_USER } from "./systemEvents";

import type { DatabaseClient } from "@tracyhill-rp/db";

type Db = DatabaseClient["db"];

// API-side liveness invariants. The
// worker checks the queue from its side; the API checks the two things the
// worker cannot see about itself:
//   1. Worker heartbeat staleness — a dead worker container in the split
//      topology. State-transition reporting: one error when it goes stale,
//      one info when it recovers, never a per-interval drumbeat.
//   2. Wedged enqueue — a session accruing far past its rolling-diff threshold
//      with recent play and NO queued/running run for its campaign. This is
//      the exact signature of a silently dead pipeline: play
//      happening, pipeline not.
// Report-once per campaign per process; the set clears when the condition
// clears so a relapse re-alerts.

export const WORKER_STALE_MS = 3 * 60 * 1000;
// evaluateAndEnqueue fires at the session's rollingDiffCharThreshold (default
// 17k, user-tunable). Keep the historical 60k minimum alert margin, but larger
// configured thresholds must be overdue by multiple cycles too.
const WEDGED_ENQUEUE_CHARS = 60_000;
const RECENT_PLAY_MS = 2 * 60 * 60 * 1000;

let workerStaleReported = false;
const wedgedEnqueueReported = new Set<string>();
const dramatistLivenessReported = new Set<string>();

/** For tests — the transition-once state is module-level (it must survive
 *  across interval ticks), so cases that share a process reset it here. */
export function resetLivenessStateForTest(): void {
  workerStaleReported = false;
  wedgedEnqueueReported.clear();
  dramatistLivenessReported.clear();
}

export interface WorkerStatus {
  ok: boolean;
  beatAt: string | null;
  staleSeconds: number | null;
}

export function getWorkerStatus(db: Db, now = Date.now()): WorkerStatus {
  try {
    const row = readHeartbeat(db, WORKER_SERVICE);
    if (!row) return { ok: false, beatAt: null, staleSeconds: null };
    const staleSeconds = Math.max(0, Math.round((now - Date.parse(row.beatAt)) / 1000));
    return { ok: staleSeconds * 1000 < WORKER_STALE_MS, beatAt: row.beatAt, staleSeconds };
  } catch {
    return { ok: false, beatAt: null, staleSeconds: null };
  }
}

export function checkPipelineLiveness(
  db: Db,
  opts: { inlineWorkers: boolean; bootedAtMs: number },
  now = Date.now(),
): void {
  // 1. Worker heartbeat (split topology only; give a fresh boot time to beat).
  if (!opts.inlineWorkers && now - opts.bootedAtMs > WORKER_STALE_MS + 60_000) {
    const status = getWorkerStatus(db, now);
    if (!status.ok && !workerStaleReported) {
      workerStaleReported = true;
      recordSystemEvent({
        userId: SYSTEM_EVENT_USER, source: "pipeline", severity: "error",
        message: status.beatAt
          ? `worker heartbeat is stale (last beat ${status.beatAt}, ${status.staleSeconds}s ago) — the dedicated worker loop appears DEAD; queued pipeline work will not run`
          : "worker heartbeat has never been recorded — the dedicated worker may have failed to boot; queued pipeline work will not run",
        details: status,
      });
    } else if (status.ok && workerStaleReported) {
      workerStaleReported = false;
      recordSystemEvent({
        userId: SYSTEM_EVENT_USER, source: "pipeline", severity: "info",
        message: `worker heartbeat recovered (last beat ${status.beatAt})`,
        details: status,
      });
    }
  }

  // 2. Wedged enqueue: recent play + counters far past threshold + no run
  //    queued/running for the campaign.
  const recentCutoff = new Date(now - RECENT_PLAY_MS).toISOString();
  const candidates = db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      campaignId: sessions.campaignId,
      chars: sessions.pipelineCharsSinceRollingDiff,
      overrides: sessions.contextOverridesJson,
      lastMessageAt: sessions.lastMessageAt,
    })
    .from(sessions)
    .where(and(
      isNull(sessions.deletedAt),
      isNotNull(sessions.campaignId),
      gt(sessions.pipelineCharsSinceRollingDiff, WEDGED_ENQUEUE_CHARS),
      gt(sessions.lastMessageAt, recentCutoff),
    ))
    .all();

  const activeCampaigns = new Set<string>();
  const candidateCampaigns = [...new Set(candidates.map((c) => c.campaignId).filter((c): c is string => Boolean(c)))];
  if (candidateCampaigns.length > 0) {
    const rows = db
      .select({ campaignId: pipelineRuns.campaignId })
      .from(pipelineRuns)
      .where(and(
        inArray(pipelineRuns.campaignId, candidateCampaigns),
        or(eq(pipelineRuns.status, "queued"), eq(pipelineRuns.status, "running")),
      ))
      .all();
    for (const r of rows) if (r.campaignId) activeCampaigns.add(r.campaignId);
  }

  const stillWedged = new Set<string>();
  for (const c of candidates) {
    if (!c.campaignId || activeCampaigns.has(c.campaignId)) continue;
    const resolved = contextSettingsSchema.safeParse(parseJsonObject(c.overrides));
    if (!resolved.success || !resolved.data.pipelineAutoEnabled) continue;
    const threshold = resolved.data.rollingDiffCharThreshold;
    if (c.chars <= Math.max(WEDGED_ENQUEUE_CHARS, threshold * 3)) continue;
    stillWedged.add(c.campaignId);
    if (wedgedEnqueueReported.has(c.campaignId)) continue;
    wedgedEnqueueReported.add(c.campaignId);
    recordSystemEvent({
      userId: c.userId, source: "pipeline", severity: "error",
      campaignId: c.campaignId, sessionId: c.sessionId,
      message: `auto-pipeline appears WEDGED: session has ${c.chars} unprocessed chars (configured threshold ${threshold}) with recent play and no queued/running run — enqueue may be dead`,
      details: { chars: c.chars, threshold, lastMessageAt: c.lastMessageAt },
    });
  }
  // Clear resolved campaigns so a relapse re-alerts.
  for (const id of [...wedgedEnqueueReported]) if (!stillWedged.has(id)) wedgedEnqueueReported.delete(id);

  // 3. Dramatist cadence: enabled campaigns with sheets must not silently stop
  // ticking while rolling diffs continue. Resolve each live session's dials
  // exactly as the enqueue path does (per-session only since migration 0077 —
  // the campaign `context_defaults_json` fossil is not consulted); the smallest
  // enabled cadence is the strictest promise made by any active session.
  const campaignRows = db.select({ id: campaigns.id, userId: campaigns.userId }).from(campaigns).all();
  const sessionRows = db.select({ id: sessions.id, campaignId: sessions.campaignId, overrides: sessions.contextOverridesJson })
    .from(sessions).where(and(isNull(sessions.deletedAt), isNotNull(sessions.campaignId))).all();
  const stillDead = new Set<string>();
  for (const campaign of campaignRows) {
    const activeSessions = sessionRows.filter((session) => session.campaignId === campaign.id);
    let cadence: number | null = null;
    for (const session of activeSessions) {
      const resolved = contextSettingsSchema.safeParse(parseJsonObject(session.overrides));
      if (!resolved.success || !resolved.data.dramatistEnabled) continue;
      cadence = cadence == null ? resolved.data.tickEveryNthRollingDiff : Math.min(cadence, resolved.data.tickEveryNthRollingDiff);
    }
    if (cadence == null) continue;
    const sheetCount = db.select({ count: sql<number>`count(*)` }).from(characterDrives)
      .where(eq(characterDrives.campaignId, campaign.id)).get()?.count ?? 0;
    if (sheetCount === 0) continue;
    // A tick the cadence DID enqueue but that still waits in the fast lane
    // behind priority-10 diffs (the queue ran 75 min behind on 2026-09-18), or
    // that is running while further diffs complete, is a quiet Dramatist, not
    // a dead one: the same rule the wedged-enqueue check applies. Skip the
    // campaign; a prior report clears with it so a real death
    // afterwards re-alerts. A FAILED tick has no queued/running row (the
    // enqueue dedupe lets the next diff queue a fresh one), so it still alerts.
    const tickPending = db.select({ id: pipelineRuns.id }).from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.campaignId, campaign.id),
        eq(pipelineRuns.kind, "world_tick"),
        or(eq(pipelineRuns.status, "queued"), eq(pipelineRuns.status, "running")),
      )).get();
    if (tickPending) continue;
    const lastTick = db.select({ completedAt: pipelineRuns.completedAt }).from(pipelineRuns)
      .where(and(eq(pipelineRuns.campaignId, campaign.id), eq(pipelineRuns.kind, "world_tick"), eq(pipelineRuns.status, "completed")))
      .orderBy(desc(pipelineRuns.completedAt)).get();
    const rdConditions = [
      eq(pipelineRuns.campaignId, campaign.id),
      eq(pipelineRuns.kind, "rolling_diff"),
      eq(pipelineRuns.status, "completed"),
    ];
    if (lastTick?.completedAt) rdConditions.push(gt(pipelineRuns.completedAt, lastTick.completedAt));
    const rollingDiffsSinceTick = db.select({ count: sql<number>`count(*)` }).from(pipelineRuns)
      .where(and(...rdConditions)).get()?.count ?? 0;
    if (rollingDiffsSinceTick <= cadence * 2) continue;
    stillDead.add(campaign.id);
    if (dramatistLivenessReported.has(campaign.id)) continue;
    dramatistLivenessReported.add(campaign.id);
    recordSystemEvent({
      userId: campaign.userId, source: "world_tick", severity: "warn", campaignId: campaign.id,
      message: `Dramatist is enabled but has not completed a world tick in ${rollingDiffsSinceTick} rolling diffs (cadence ${cadence}, liveness limit ${cadence * 2}) — automatic world pressure may be DEAD rather than quiet`,
      details: { rollingDiffsSinceTick, cadence, lastTickAt: lastTick?.completedAt ?? null },
    });
  }
  for (const id of [...dramatistLivenessReported]) if (!stillDead.has(id)) dramatistLivenessReported.delete(id);
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
