import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { contextSettingsSchema } from "@tracyhill-rp/contracts";

import { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import type { ProviderRuntimeDefaults } from "../../../api/src/domain/providerKeys/providerKeyService";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import { RollingDiffWorker } from "../context/rollingDiffWorker";
import { LorebookConsolidationWorker } from "../context/lorebookConsolidationWorker";
import { LorebookArchivalWorker } from "../context/lorebookArchivalWorker";
import { ThreadTrackerWorker } from "../context/threadTrackerWorker";
import { DriveUpdateWorker } from "../context/driveUpdateWorker";
import { WorldTickWorker } from "../context/worldTickWorker";
import { CampaignAuditWorker } from "../context/campaignAuditWorker";
import { RepetitionDetectionWorker } from "./repetitionDetectionWorker";
import { SyspromptAuditWorker } from "./syspromptAuditWorker";
import { RecapWorker } from "./recapWorker";
import { isResumableError } from "./retryHelper";
import { SessionRepository } from "../../../api/src/domain/workspace/sessionRepository";

export type PipelineWorkerOptions = {
  runtime?: ChatRuntime | null;
  runtimeDefaults?: ProviderRuntimeDefaults;
};

// The three auto kinds whose enqueue is driven by a per-session char counter
// (pipelineQueueService.evaluateAndEnqueue). The counter is what this runner
// settles after each run.
const COUNTER_KINDS = new Set(["rolling_diff", "repetition_detection", "sysprompt_audit"]);
type CounterKind = "rolling_diff" | "repetition_detection" | "sysprompt_audit";

/**
 * Should the kind's char counter be settled (decremented by its threshold)
 * after a run ended in `status` with `error`? Exported for the runner test.
 *
 * - completed → yes (the run consumed the accumulated content).
 * - canceled → no: a user cancel is not a verdict on the content; the next
 *   turn may re-enqueue (the pre-2026-09-02 behavior for every non-success).
 * - failed, transient class (rate limit / overload / network / hung deadline /
 *   quota — `isResumableError`) → no: the content is still un-ingested and the
 *   condition clears on its own, so the next turn's re-enqueue is the retry.
 * - failed, anything else → yes. A deterministic failer (no provider key, an
 *   adversarial-reviewer rejection, a parse failure) re-enqueued on EVERY turn
 *   because the counter never moved — the sysprompt audit's "default to
 *   rejection" reviewer alone could occupy the serial fast lane every turn.
 *   Settling the counter turns that into one attempt per threshold
 *   of new content: a natural backoff with no new state.
 */
export function shouldSettleCounter(status: string | undefined, error: string | null | undefined): boolean {
  if (status === "completed") return true;
  if (status !== "failed") return false;
  return !isResumableError(new Error(error ?? ""));
}

export class PipelineWorker {
  private readonly logger = createLogger("tracyhill-rp-v2-worker");
  private readonly sessions;
  private readonly runs;
  private readonly rollingDiffWorker;
  private readonly lorebookConsolidationWorker;
  private readonly lorebookArchivalWorker;
  private readonly threadTrackerWorker;
  private readonly driveUpdateWorker;
  private readonly worldTickWorker;
  private readonly repetitionDetectionWorker;
  private readonly syspromptAuditWorker;
  private readonly recapWorker;
  private readonly campaignAuditWorker;
  private readonly activeRuns = new Map<string, AbortController>();
  private drainCount = 0;
  // One drainer per campaign lane, keyed "fast:<campaignId>" / "slow:<campaignId>" (per-campaign lanes, 2026-10-02).
  private readonly drainingLanes = new Set<string>();
  private stopped = false;

  constructor(dbFile: string, options?: PipelineWorkerOptions) {
    migrateDatabase(dbFile);
    const { db } = createDatabaseClient(dbFile);
    this.sessions = new SessionRepository(db);
    this.runs = new PipelineRunRepository(db);
    // Split-topology orphan recovery: the queue's OWNER recovers runs
    // left `running` by a previous process. createApp only does this for the
    // inline topology — an API-side recovery would requeue rows a live
    // dedicated worker still holds. Without this call, every dedicated-worker
    // restart zombied its in-flight runs until the 60-min stale sweep reaped
    // them as failures.
    // Non-fatal, but never silent: a SQLITE_BUSY here leaves zombie
    // rows holding the audit↔ruling lock until the 60-min sweep.
    try { this.runs.recoverOrphanedRunningJobs(); } catch (err) {
      this.logger.error({ err }, "boot orphan recovery failed — running rows from a previous process were NOT requeued");
      recordSystemEvent({
        userId: "__system__", source: "pipeline", severity: "error",
        message: `boot orphan recovery failed — in-flight runs from the previous process were not requeued: ${err instanceof Error ? err.message : String(err)}`,
        details: { pid: process.pid },
      });
    }
    this.rollingDiffWorker = new RollingDiffWorker(dbFile, options);
    this.lorebookConsolidationWorker = new LorebookConsolidationWorker(dbFile, options);
    this.lorebookArchivalWorker = new LorebookArchivalWorker(dbFile, options);
    this.threadTrackerWorker = new ThreadTrackerWorker(dbFile, options);
    this.driveUpdateWorker = new DriveUpdateWorker(dbFile, options);
    this.worldTickWorker = new WorldTickWorker(dbFile, options);
    this.repetitionDetectionWorker = new RepetitionDetectionWorker(dbFile, options);
    this.syspromptAuditWorker = new SyspromptAuditWorker(dbFile, options);
    this.recapWorker = new RecapWorker(dbFile, options);
    this.campaignAuditWorker = new CampaignAuditWorker(dbFile, options);
  }

  /** Graceful-shutdown hook: stop picking up queued work. In-flight
   *  runs finish (or are cut by the container's stop grace — their rows stay
   *  `running` and the next boot's orphan recovery requeues them, checkpoint
   *  intact). Deliberately NOT an abort: aborting marks runs canceled, which is
   *  terminal and discards an audit's resumable checkpoint. */
  stop() {
    this.stopped = true;
  }

  /** Number of runs this process is executing right now. */
  get activeRunCount() {
    return this.activeRuns.size;
  }

  /** Refresh `updated_at` on every run this process is executing (called from
   *  the main loop's heartbeat). A run this worker holds is alive by definition;
   *  only a run no live worker holds may age into the stale sweep. Throws on a
   *  database error — the caller logs it (never silent). */
  touchActiveRuns(nowIso?: string): number {
    return this.runs.touchRunning([...this.activeRuns.keys()], nowIso);
  }

  kick() {
    // Every campaign has its own two lanes (2026-10-02; until then one fast and one slow lane served every campaign,
    // so one campaign's rolling diffs starved another's tracker, drive and tick runs for hours). The slow lane runs
    // only campaign_audit (hours at max effort); the fast lane keeps the campaign's freshness backbone (tracker/rolling
    // diff/ticks) flowing beside it. Per-lane guards: a 3-hour audit must never leave kicks dropped for its campaign's
    // fast lane.
    if (this.stopped) return; // shutting down — no new work
    for (const lane of ["fast", "slow"] as const) {
      let campaignIds: string[];
      try {
        campaignIds = this.runs.listCampaignsWithEligibleQueued(lane);
      } catch (err) {
        // Never silent; the next kick retries.
        this.logger.error({ err, lane }, "pipeline kick could not list the campaigns with queued work");
        recordSystemEvent({
          userId: "__system__", source: "pipeline", severity: "error",
          message: `pipeline kick could not list the campaigns with queued work on the ${lane} lanes — the next kick retries: ${err instanceof Error ? err.message : String(err)}`,
          details: { lane },
        });
        continue;
      }
      for (const campaignId of campaignIds) this.kickLane(lane, campaignId);
    }
  }

  private kickLane(lane: "fast" | "slow", campaignId: string) {
    if (this.drainingLanes.has(laneKey(lane, campaignId))) return; // the live loop picks up queued work
    queueMicrotask(async () => {
      try {
        await this.drainLane(lane, campaignId);
      } catch (err) {
        // Last-resort guard: an unhandled rejection here under INLINE_WORKERS=1
        // would crash the API process. Log and survive; the next kick() will
        // retry. Never silent: the failure is recorded as a pipeline
        // event so a lane that keeps dying is visible in the feed.
        this.logger.error({ err, lane, campaignId }, "pipeline drain failed");
        recordSystemEvent({
          userId: "__system__", source: "pipeline", severity: "error", campaignId,
          message: `pipeline drain failed on the campaign's ${lane} lane — the next kick retries: ${err instanceof Error ? err.message : String(err)}`,
          details: { lane },
        });
      }
    });
  }

  /** Runs everything runnable, every campaign lane at once, until a pass finds nothing (tests, the inline topology). */
  async drain() {
    for (;;) {
      const lanes = (["fast", "slow"] as const).flatMap((lane) => this.runs.listCampaignsWithEligibleQueued(lane)
        .filter((campaignId) => !this.drainingLanes.has(laneKey(lane, campaignId)))
        .map((campaignId) => [lane, campaignId] as const));
      if (lanes.length === 0) return;
      const ran = await Promise.all(lanes.map(([lane, campaignId]) => this.drainLane(lane, campaignId)));
      if (ran.every((count) => count === 0)) return;
    }
  }

  private async drainLane(lane: "fast" | "slow", campaignId: string): Promise<number> {
    const key = laneKey(lane, campaignId);
    if (this.drainingLanes.has(key)) return 0;
    this.drainingLanes.add(key);
    let ran = 0;
    try {
      while (!this.stopped && await this.runNext(lane, campaignId)) {
        ran++;
        this.drainCount++;
        if (this.drainCount % 10 === 0) {
          try { this.sweepStaleLocks(); } catch (err) {
            // Never silent: a failed sweep leaves dead `running`
            // rows holding their campaign locks.
            this.logger.error({ err, lane }, "stale-lock sweep failed");
            recordSystemEvent({
              userId: "__system__", source: "pipeline", severity: "error",
              message: `stale-lock sweep failed: ${err instanceof Error ? err.message : String(err)}`,
              details: { lane },
            });
          }
        }
      }
    } finally {
      this.drainingLanes.delete(key);
    }
    return ran;
  }

  private sweepStaleLocks() {
    const cutoffMs = 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - cutoffMs).toISOString();
    const stale = this.runs.findStaleRunningJobs(cutoff);
    for (const run of stale) {
      this.logger.warn({ runId: run.id, kind: run.kind, startedAt: run.startedAt }, "stale lock timeout");
      this.runs.markFailed(run.id, new Date().toISOString(), "stale lock timeout (60 min)", null);
    }
  }

  cancelRun(runId: string) {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Runs the next eligible run of one campaign's lane, or of any campaign's when `campaignId` is omitted (tests). */
  async runNext(lane: "fast" | "slow" = "fast", campaignId?: string) {
    const next = this.runs.findNextQueuedRespectingCampaignLock(lane, campaignId);
    if (!next) return false;
    const startedAt = new Date().toISOString();
    if (!this.runs.markRunning(next.id, startedAt)) return true;

    // A single abort-aware envelope for ALL auto kinds. Previously only
    // campaign_review registered an AbortController + cancellation watcher, so
    // cancel was a no-op for the six auto kinds. Every kind now creates the
    // controller + watcher BEFORE dispatch and threads the signal in.
    const autoKinds = new Set(["rolling_diff", "repetition_detection", "sysprompt_audit", "lorebook_consolidation", "lorebook_archival", "thread_tracker", "drive_update", "world_tick", "recap", "campaign_audit", "audit_ruling"]);
    if (autoKinds.has(next.kind)) {
      const controller = new AbortController();
      this.activeRuns.set(next.id, controller);
      const stopWatching = this.watchForCancellation(next.userId, next.id, controller);
      try {
        const baseRun = { id: next.id, userId: next.userId, campaignId: next.campaignId, sessionId: next.sessionId, detailsJson: next.detailsJson };
        try {
          await this.dispatch(next.kind, baseRun, controller.signal);
        } catch (err) {
          // A worker's own catch handles model/parse/apply failures; what
          // escapes here is a terminal write that threw (SQLITE_BUSY past
          // busy_timeout on markCompleted/markFailed, the lock-contention
          // class). Left alone, the row stays `running` for the 60-min stale
          // sweep, which then names the wrong cause ("stale lock timeout"),
          // the campaign's lane stays held and no event says why.
          // Mark the row with the real message (markFailed records the run's
          // error event when the transition lands) and record a pipeline
          // event either way so the failure is never silent.
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error({ err, runId: next.id, kind: next.kind }, "worker dispatch escaped its handler");
          let marked = false;
          try { marked = this.runs.markFailed(next.id, new Date().toISOString(), `worker dispatch failed: ${message}`, null); } catch (markErr) {
            this.logger.error({ err: markErr, runId: next.id }, "could not mark the escaped run failed");
          }
          recordSystemEvent({
            userId: next.userId, source: "pipeline", severity: "error",
            campaignId: next.campaignId, sessionId: next.sessionId,
            message: `${next.kind} run ${next.id.slice(0, 8)} failed outside its handler${marked ? "" : " and could NOT be marked failed — its row may sit running until the stale-lock sweep"}: ${message}`,
            details: { runId: next.id, kind: next.kind, marked },
          });
        }
        // F (counters): settle the char counter on completion AND on a
        // deterministic failure; keep it only for a cancel or a transient
        // failure (see shouldSettleCounter). The counter is
        // decremented by the threshold, never zeroed, so content that arrived
        // DURING the run still counts toward the next enqueue. The threshold
        // is the SESSION's dial: the queue stamps it into the run's
        // details at enqueue; a run without the stamp (enqueued before the
        // stamp existed, or a manual fixture) resolves it from the session's
        // Engine settings. The repository's hard-coded default is never used
        // for a session that dialed something else.
        if (next.sessionId && COUNTER_KINDS.has(next.kind)) {
          try {
            const final = this.runs.findById(next.userId, next.id);
            if (shouldSettleCounter(final?.status, final?.error)) {
              const threshold = this.counterThresholdFor(next.userId, next.sessionId, next.kind as CounterKind, next.detailsJson);
              this.sessions.resetPipelineCounter(next.sessionId, next.kind as CounterKind, threshold);
            }
          } catch (err) {
            // Never silent: an unsettled counter re-enqueues the
            // kind on the very next turn.
            this.logger.error({ err, runId: next.id, kind: next.kind }, "pipeline char counter settle failed");
            recordSystemEvent({
              userId: next.userId, source: "pipeline", severity: "error",
              campaignId: next.campaignId, sessionId: next.sessionId,
              message: `${next.kind} char counter could not be settled after the run — it will re-enqueue next turn: ${err instanceof Error ? err.message : String(err)}`,
              details: { runId: next.id },
            });
          }
        }
      } finally {
        stopWatching();
        this.activeRuns.delete(next.id);
      }
      return true;
    }

    // Every live kind dispatches through the autoKinds branch above. The
    // campaign_review monolith (the old fall-through here) was sunset in the
    // campaign-audit redesign — a queued run
    // of a retired/unknown kind fails loudly instead of hanging the queue.
    this.runs.markFailed(next.id, startedAt, `unknown pipeline kind "${next.kind}"`, null);
    return true;
  }

  private async dispatch(kind: string, run: { id: string; userId: string; campaignId: string; sessionId: string | null; detailsJson: string | null }, signal: AbortSignal): Promise<void> {
    if (kind === "rolling_diff") await this.rollingDiffWorker.execute(run, signal);
    else if (kind === "repetition_detection") await this.repetitionDetectionWorker.execute(run, signal);
    else if (kind === "sysprompt_audit") await this.syspromptAuditWorker.execute(run, signal);
    else if (kind === "lorebook_consolidation") await this.lorebookConsolidationWorker.execute(run, signal);
    else if (kind === "lorebook_archival") await this.lorebookArchivalWorker.execute(run, signal);
    else if (kind === "thread_tracker") await this.threadTrackerWorker.execute(run, signal);
    else if (kind === "drive_update") await this.driveUpdateWorker.execute(run, signal);
    else if (kind === "world_tick") await this.worldTickWorker.execute(run, signal);
    else if (kind === "campaign_audit") await this.campaignAuditWorker.execute(run, signal);
    else if (kind === "audit_ruling") await this.campaignAuditWorker.runRuling(run, signal);
    else if (kind === "recap") await this.recapWorker.execute(run, signal);
  }

  /** The char threshold a counter kind settles by: the value the
   *  queue stamped at enqueue (`counterThreshold`), else the session's
   *  resolved Engine dial (per-session overrides over the contract defaults —
   *  the same resolution the API's ContextEngine.resolveSettings performs). */
  private counterThresholdFor(userId: string, sessionId: string, kind: CounterKind, detailsJson: string | null): number {
    try {
      const stamped = (detailsJson ? JSON.parse(detailsJson) : {}) as { counterThreshold?: unknown };
      if (typeof stamped.counterThreshold === "number" && Number.isFinite(stamped.counterThreshold) && stamped.counterThreshold > 0) return stamped.counterThreshold;
    } catch { /* unreadable details — resolve from the session */ }
    const session = this.sessions.findById(userId, sessionId);
    let overrides: Record<string, unknown> = {};
    try {
      const parsed: unknown = session?.contextOverridesJson ? JSON.parse(session.contextOverridesJson) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed as Record<string, unknown>;
    } catch { /* malformed overrides — contract defaults */ }
    const settings = contextSettingsSchema.parse(overrides);
    return kind === "rolling_diff" ? settings.rollingDiffCharThreshold
      : kind === "repetition_detection" ? settings.repetitionCharThreshold
      : settings.syspromptAuditCharThreshold;
  }

  private watchForCancellation(userId: string, runId: string, controller: AbortController) {
    const interval = setInterval(() => {
      try {
        const current = this.runs.findById(userId, runId);
        if (current?.status === "canceled") controller.abort();
      } catch (err) {
        // DB lookup glitch shouldn't kill the process. The next tick will retry.
        this.logger.warn({ err, runId }, "cancellation poll failed");
      }
    }, 250);
    return () => clearInterval(interval);
  }


}

function laneKey(lane: "fast" | "slow", campaignId: string) {
  return `${lane}:${campaignId}`;
}
