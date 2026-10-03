import { HELD_INPUT_MARK } from "../chat/pipelineTranscriptInput";
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { pipelineRuns, type DatabaseClient } from "@tracyhill-rp/db";

import { recordSystemEvent } from "../system/systemEvents";
import { AuditFindingRepository } from "./auditFindingRepository";

import type { SystemEventSource } from "../system/systemEvents";

// The retired campaign_review detailsJson shape (`steps`/`review`, watermark
// keys, `models`) is gone from the wire (2026-09-02): no live kind ever wrote
// it, and its last reader (the Android PipelineModels) dropped it. Run details
// are per-kind JSON owned by the workers; the API passes `details_json` through
// opaquely (cancel keeps it, the audit/recap status routes parse their own).
export class PipelineRunRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  /** Newest first. `filter.runId` narrows to that one run; `filter.limit` keeps the newest N (both optional). */
  listForCampaign(userId: string, campaignId: string, filter: { limit?: number; runId?: string } = {}) {
    const scope = and(eq(pipelineRuns.userId, userId), eq(pipelineRuns.campaignId, campaignId),
      filter.runId != null ? eq(pipelineRuns.id, filter.runId) : undefined);
    const query = this.db.select().from(pipelineRuns)
      .where(scope)
      .orderBy(desc(pipelineRuns.requestedAt), desc(pipelineRuns.updatedAt));
    return filter.limit != null ? query.limit(filter.limit).all() : query.all();
  }

  findLatestByKindAndCampaign(kind: string, campaignId: string) {
    return this.db.select().from(pipelineRuns)
      .where(and(eq(pipelineRuns.kind, kind), eq(pipelineRuns.campaignId, campaignId)))
      .orderBy(desc(pipelineRuns.requestedAt))
      .get();
  }

  findById(userId: string, runId: string) {
    return this.db.select().from(pipelineRuns)
      .where(and(eq(pipelineRuns.userId, userId), eq(pipelineRuns.id, runId)))
      .get();
  }

  /** Details JSON for a run the caller already owns (worker-internal
   *  read-modify-write of progress/checkpoint state). */
  getDetailsJson(runId: string): string | null {
    const row = this.db.select({ detailsJson: pipelineRuns.detailsJson }).from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .get();
    return row?.detailsJson ?? null;
  }

  /** Latest COMPLETED run of a kind for a campaign, optionally filtered by a
   *  json_extract match on details_json (e.g. audit mode) — drives the
   *  entries-changed-since-last-audit auto-trigger. */
  findLatestCompletedByKindAndCampaign(kind: string, campaignId: string, detailsField?: { path: string; value: string }) {
    const conditions = [eq(pipelineRuns.kind, kind), eq(pipelineRuns.campaignId, campaignId), eq(pipelineRuns.status, "completed")];
    if (detailsField) {
      conditions.push(sql`json_extract(${pipelineRuns.detailsJson}, ${detailsField.path}) = ${detailsField.value}`);
    }
    return this.db.select().from(pipelineRuns)
      .where(and(...conditions))
      .orderBy(desc(pipelineRuns.completedAt))
      .get();
  }

  listActiveForUser(userId: string) {
    // "Active" = queued/running only. The old completed-unapproved clause was
    // the campaign-review approve-nudge; with the approval surface sunset those
    // rows (including historical ones still in prod) would linger in the
    // activity bar forever with no possible action. (The `approved_at IS NULL`
    // guard went with it — a queued/running row is never approved.)
    return this.db.select().from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.userId, userId),
        or(
          eq(pipelineRuns.status, "queued"),
          eq(pipelineRuns.status, "running"),
        ),
      ))
      .orderBy(desc(pipelineRuns.updatedAt), desc(pipelineRuns.requestedAt))
      .all();
  }

  /** Requeue a run for a later resume attempt (transient self-requeue): back to
   *  queued, cleared started_at, cooldown set, its checkpointed detailsJson kept. */
  requeueForResume(runId: string, notBefore: string, detailsJson: string) {
    const now = new Date().toISOString();
    return this.db.update(pipelineRuns)
      .set({ status: "queued", startedAt: null, notBefore, detailsJson, updatedAt: now, error: null })
      .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "running")))
      .run().changes > 0;
  }

  /** Lane-partitioned pick (per campaign since 2026-10-02). Every campaign has its own two
   *  lanes, and the worker drains each (campaign, lane) pair on its own, so one campaign's jobs never wait behind
   *  another's. The SLOW lane runs only `campaign_audit`, the rarest and (at max effort) hours-long job, so it never
   *  starves its campaign's fast
   *  lane, the freshness backbone (tracker/rolling diff). Cross-lane safety is version-checked apply (the audit's CAS
   *  collision control), NOT locking; the only cross-lane lock kept is the audit family itself: a ruling never starts
   *  while its campaign's audit runs and vice versa (rulings are minutes, cheap to serialize against their audit).
   *  `campaignId` narrows the pick to one campaign's lane; without it the pick spans every campaign (tests, tools). */
  findNextQueuedRespectingCampaignLock(lane: "fast" | "slow" = "fast", campaignId?: string) {
    return this.db.select().from(pipelineRuns)
      .where(and(
        this.eligibleQueued(lane),
        campaignId === undefined ? undefined : eq(pipelineRuns.campaignId, campaignId),
      ))
      .orderBy(asc(pipelineRuns.priority), asc(pipelineRuns.requestedAt))
      .get();
  }

  /** The campaigns whose lane has a run the picker would take now: the worker starts one drainer for each. */
  listCampaignsWithEligibleQueued(lane: "fast" | "slow"): string[] {
    return this.db.selectDistinct({ campaignId: pipelineRuns.campaignId }).from(pipelineRuns)
      .where(this.eligibleQueued(lane))
      .all()
      .map((row) => row.campaignId);
  }

  private eligibleQueued(lane: "fast" | "slow") {
    // This condition decides ELIGIBILITY, not concurrency.
    // Execution is serial per campaign lane: PipelineWorker.drainLane awaits one
    // runNext(lane, campaignId) at a time behind its drainingLanes guard, one
    // worker per process, and production runs a single worker process. What the
    // CASE below waives is the per-campaign lock: the fast auto kinds listed first
    // are eligible even while another run of their campaign is `running` (the
    // slow-lane audit, or a run held by another process); the retired
    // campaign_review kind was the only thing they ever serialized against
    // (its guard was dropped 2026-09-02). audit_ruling waits for any
    // running run of its campaign; archival and recap wait for any running
    // non-audit run of theirs. No fast job waits on a slow-lane audit.
    const nowIso = new Date().toISOString();
    const laneCondition = lane === "slow"
      ? sql`${pipelineRuns.kind} = 'campaign_audit' AND ${pipelineRuns.campaignId} NOT IN (
          SELECT campaign_id FROM ${pipelineRuns} WHERE status = 'running' AND kind IN ('campaign_audit','audit_ruling')
        )`
      : sql`${pipelineRuns.kind} != 'campaign_audit' AND CASE
          WHEN ${pipelineRuns.kind} IN ('rolling_diff','repetition_detection','sysprompt_audit','lorebook_consolidation','thread_tracker','drive_update','world_tick')
          THEN 1
          WHEN ${pipelineRuns.kind} = 'audit_ruling'
          THEN ${pipelineRuns.campaignId} NOT IN (
            SELECT campaign_id FROM ${pipelineRuns} WHERE status = 'running'
          )
          ELSE ${pipelineRuns.campaignId} NOT IN (
            SELECT campaign_id FROM ${pipelineRuns} WHERE status = 'running' AND kind != 'campaign_audit'
          )
        END`;
    return and(
      eq(pipelineRuns.status, "queued"),
      // Resume cooldown: skip a self-requeued run until its not_before passes.
      or(isNull(pipelineRuns.notBefore), lt(pipelineRuns.notBefore, nowIso)),
      laneCondition,
    );
  }

  hasQueuedOrRunningByKindAndCampaign(kind: string, campaignId: string): boolean {
    return !!this.db.select({ id: pipelineRuns.id }).from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.kind, kind),
        eq(pipelineRuns.campaignId, campaignId),
        or(eq(pipelineRuns.status, "queued"), eq(pipelineRuns.status, "running")),
      ))
      .get();
  }

  listQueuedOrRunningForCampaign(campaignId: string) {
    return this.db.select().from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.campaignId, campaignId),
        or(eq(pipelineRuns.status, "queued"), eq(pipelineRuns.status, "running")),
      ))
      .orderBy(asc(pipelineRuns.priority), asc(pipelineRuns.requestedAt))
      .all();
  }

  findStaleRunningJobs(cutoffIso: string) {
    // Filter on updatedAt (liveness), not startedAt: a long-running but
    // heartbeating job has a fresh updatedAt and must survive the sweep, while a
    // genuinely wedged one has a stale updatedAt regardless of when it started.
    return this.db.select().from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.status, "running"),
        lt(pipelineRuns.updatedAt, cutoffIso),
      ))
      .all();
  }

  createRun(input: typeof pipelineRuns.$inferInsert) {
    this.db.insert(pipelineRuns).values(input).run();
  }

  markRunning(runId: string, startedAt: string) {
    const result = this.db.update(pipelineRuns)
      .set({ status: "running", startedAt, updatedAt: startedAt })
      .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "queued")))
      .run();
    return result.changes > 0;
  }

  updateRun(runId: string, input: Partial<typeof pipelineRuns.$inferInsert>) {
    this.db.update(pipelineRuns).set(input).where(eq(pipelineRuns.id, runId)).run();
  }

  markCompleted(runId: string, completedAt: string, summary: string, detailsJson?: string | null) {
    // Guarded transition: only a still-`running` row may complete. A sub-worker
    // that finishes AFTER the run was canceled/failed must NOT resurrect it.
    const result = this.db.update(pipelineRuns)
      .set({ status: "completed", summary, detailsJson: detailsJson ?? null, error: null, completedAt, updatedAt: completedAt })
      .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "running")))
      .run();
    return result.changes > 0;
  }

  markFailed(runId: string, failedAt: string, summary: string, detailsJson?: string | null) {
    // null/undefined detailsJson PRESERVES the existing details — callers on
    // failure paths used to pass null and wipe the audit checkpoint / progress
    // and the worker dials, breaking resume diagnostics.
    // Guarded transition: only queued/running rows may fail (a terminal row
    // can't be re-failed by a late sub-worker).
    const result = this.db.update(pipelineRuns)
      .set({ status: "failed", summary, error: summary, ...(detailsJson != null ? { detailsJson } : {}), completedAt: failedAt, updatedAt: failedAt })
      .where(and(eq(pipelineRuns.id, runId), or(eq(pipelineRuns.status, "queued"), eq(pipelineRuns.status, "running"))))
      .run();
    if (result.changes > 0) {
      // No-silent-failures: every worker failure surfaces as a system event.
      // Recording here (the one shared failure path) covers all run kinds.
      // Inside the changes>0 guard so a lost transition records nothing.
      const run = this.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get();
      if (run) {
        // Kinds with their own SystemEventSource record under it; the audit
        // family (campaign_audit + its audit_ruling executor) shares
        // "campaign_audit" so source-keyed indicators see the most expensive
        // failures. Everything else (recap) lands under "pipeline".
        const ownSources = new Set<SystemEventSource>([
          "rolling_diff", "thread_tracker", "repetition_detection",
          "sysprompt_audit", "lorebook_consolidation", "lorebook_archival", "drive_update",
          "world_tick",
        ]);
        const source: SystemEventSource = run.kind === "campaign_audit" || run.kind === "audit_ruling"
          ? "campaign_audit"
          : ownSources.has(run.kind as SystemEventSource) ? (run.kind as SystemEventSource) : "pipeline";
        // A run stopped because the transcript changed under it (an edit,
        // regenerate or delete) is the canon guard working, not a failure: its
        // writes were held and newer text is picked up by a later run. It goes
        // to the notices feed instead of the red alert count (2026-09-27).
        const heldInput = summary.includes(HELD_INPUT_MARK);
        recordSystemEvent({
          userId: run.userId,
          source,
          severity: heldInput ? "info" : "error",
          message: heldInput
            ? `${run.kind} run stopped without writing: the transcript changed while it ran (an edit, regenerate or delete), so its canon writes were held`
            : `${run.kind} run failed: ${summary}`,
          campaignId: run.campaignId,
          sessionId: run.sessionId ?? null,
          details: { runId },
        });
      }
    }
    return result.changes > 0;
  }

  markCanceled(runId: string, canceledAt: string, summary: string, detailsJson?: string | null) {
    // A canceled ruling executor releases its findings in the same transaction:
    // the API cancels a QUEUED ruling directly, and nothing else
    // ever touched those `processing` rows until the five-minute orphan sweep
    // — the ⚖ chip showed "processing" and a corrected resubmission was refused
    // with 409 for up to five minutes. The worker's own catch paths call
    // reopenByRulingRun too; it is idempotent on already-open rows.
    return this.db.transaction(() => {
      const result = this.db.update(pipelineRuns)
        .set({ status: "canceled", summary, error: summary, ...(detailsJson != null ? { detailsJson } : {}), completedAt: canceledAt, updatedAt: canceledAt })
        .where(and(eq(pipelineRuns.id, runId), or(eq(pipelineRuns.status, "queued"), eq(pipelineRuns.status, "running"))))
        .run();
      if (result.changes > 0) {
        const run = this.db.select({ kind: pipelineRuns.kind }).from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get();
        if (run?.kind === "audit_ruling") new AuditFindingRepository(this.db).reopenByRulingRun(runId, canceledAt);
      }
      return result.changes > 0;
    });
  }

  // Heartbeat liveness. Bumps updatedAt for a running run so the
  // updatedAt-based stale sweep doesn't reap a slow-but-live job.
  heartbeat(runId: string) {
    const now = new Date().toISOString();
    this.db.update(pipelineRuns)
      .set({ updatedAt: now })
      .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "running")))
      .run();
  }

  /**
   * Process-level liveness (2026-09-27): the worker's main loop refreshes every
   * run it is executing on each heartbeat, so a live run can never look stale
   * to the 60-min sweep however its own stage beats fare. A campaign audit was
   * once reaped at 82 min while the worker loop was demonstrably
   * alive: its per-call beats ran on the audit's own connection and every
   * failure was swallowed. Only `running` rows move; returns how many did.
   */
  touchRunning(runIds: readonly string[], nowIso: string = new Date().toISOString()): number {
    if (runIds.length === 0) return 0;
    return this.db.update(pipelineRuns)
      .set({ updatedAt: nowIso })
      .where(and(inArray(pipelineRuns.id, [...runIds]), eq(pipelineRuns.status, "running")))
      .run().changes;
  }

  // Boot orphan recovery. Any run left `running` from a previous
  // process (crash/restart) is reset to `queued` with its timestamps cleared so
  // the worker re-claims it. Guarded + idempotent (only running rows match).
  // Returns the recovered rows so the orchestrator can requeue/record events.
  recoverOrphanedRunningJobs() {
    const orphans = this.db.select().from(pipelineRuns).where(eq(pipelineRuns.status, "running")).all();
    if (orphans.length === 0) return orphans;
    const now = new Date().toISOString();
    this.db.update(pipelineRuns)
      .set({ status: "queued", startedAt: null, approvedAt: null, completedAt: null, updatedAt: now })
      .where(eq(pipelineRuns.status, "running"))
      .run();
    for (const run of orphans) {
      recordSystemEvent({
        userId: run.userId,
        source: "pipeline",
        severity: "info",
        message: `recovered orphaned ${run.kind} run after restart — requeued`,
        campaignId: run.campaignId,
        sessionId: run.sessionId ?? null,
        details: { runId: run.id },
      });
    }
    return orphans;
  }

  listCompletedRollingDiffsForSession(userId: string, sessionId: string) {
    return this.db.select().from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.userId, userId),
        eq(pipelineRuns.sessionId, sessionId),
        eq(pipelineRuns.kind, "rolling_diff"),
        eq(pipelineRuns.status, "completed"),
      ))
      .all();
  }

  /** Whether a run of `kind` other than `excludeRunId` was already enqueued for
   *  this rolling-diff ordinal (any status — failed/canceled rows keep their
   *  details). The queue's once-per-ordinal guard for cadenced sweeps. */
  hasRunAtRollingDiffOrdinal(kind: string, campaignId: string, ordinal: number, excludeRunId: string): boolean {
    return !!this.db.select({ id: pipelineRuns.id }).from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.kind, kind),
        eq(pipelineRuns.campaignId, campaignId),
        ne(pipelineRuns.id, excludeRunId),
        sql`json_extract(${pipelineRuns.detailsJson}, '$.rollingDiffOrdinal') = ${ordinal}`,
      ))
      .get();
  }

  countCompletedByKindAndCampaign(kind: string, campaignId: string): number {
    const result = this.db.select({ count: sql<number>`count(*)` }).from(pipelineRuns)
      .where(and(eq(pipelineRuns.kind, kind), eq(pipelineRuns.campaignId, campaignId), eq(pipelineRuns.status, "completed")))
      .get();
    return result?.count ?? 0;
  }

  transact(fn: () => void) {
    this.db.transaction(() => { fn(); });
  }
}
