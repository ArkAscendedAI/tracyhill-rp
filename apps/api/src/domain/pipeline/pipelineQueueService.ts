import { characterDrives, lorebookEntries, lorebookEntryRevisions, sessions, type DatabaseClient } from "@tracyhill-rp/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { createLogger } from "@tracyhill-rp/logging";

import { createId } from "../../lib/ids";
import { AuditFindingRepository } from "./auditFindingRepository";
import type { SettledAssistantSource } from "../chat/messageRepository";
import type { PipelineRunRepository } from "./pipelineRunRepository";

// Shared priority map for every queued kind — lower runs first WITHIN a lane.
// Each campaign has its own fast and slow lane since 2026-10-02, so these numbers
// order one campaign's runs, never one campaign against another.
// `audit_ruling` (15) sits just behind `rolling_diff` so an owner's rulings
// execute ahead of the rest of the background backbone; `campaign_audit` (90)
// runs in its campaign's slow lane, so its number only orders it against that
// campaign's other audits. "recap" is manual-trigger only (never auto-enqueued here).
export const PIPELINE_KIND_PRIORITY = { rolling_diff: 10, repetition_detection: 20, sysprompt_audit: 30, thread_tracker: 40, drive_update: 45, world_tick: 50, lorebook_consolidation: 60, lorebook_archival: 70, recap: 80, campaign_audit: 90, audit_ruling: 15 } as const;
const PRIORITY = PIPELINE_KIND_PRIORITY;
const STALE_LOCK_MS = 60 * 60 * 1000;

type AutoKind = "rolling_diff" | "repetition_detection" | "sysprompt_audit";

interface Thresholds {
  rollingDiffCharThreshold: number;
  repetitionCharThreshold: number;
  syspromptAuditCharThreshold: number;
  rollingModel: string;
  repetitionModel: string;
  syspromptAuditModel: string;
  embeddingModel: string;
  driveModel: string;
  npcAgendaEnabled: boolean;
  worldTickModel: string;
  dramatistEnabled: boolean;
  dramatistModel: string;
  dramatistIntensity: "restrained" | "standard" | "bold";
  tickEveryNthRollingDiff: number;
  pipelineAutoEnabled: boolean;
  auditModel: string;
  auditAutoEnabled: boolean;
  auditQuickEveryNChanges: number;
  auditFullEveryNChanges: number;
  // Engine dial: explicit reasoning effort for every worker call.
  workerEffort: string;
  // Engine dial (2026-09-09): OpenAI fast mode for every worker call whose
  // resolved model supports it — threaded through detailsJson beside workerEffort
  // as `openaiFastMode`. Optional so an older caller/fixture without the dial
  // means OFF (the contract default), never a type-level break.
  openaiFastModeEnabled?: boolean;
  // Anti-repetition caps (0077): Engine dials the repetition worker used to read
  // from CAMPAIGN contextDefaults — a scope the Engine panel never writes — so both
  // silently fell back to hardcoded 80/5 and changing either in the panel did
  // nothing. Threaded through detailsJson like every other worker dial.
  maxAntiRepetitionRules: number;
  antiRepArchiveAfter: number;
  // PC exclusion (0077): same story. driveUpdateWorker read this from campaign
  // contextDefaults, whose only editor was the campaign panel, so it sat at its `[]`
  // default and the guard never fired once — the player's own protagonist accumulated
  // a worker-maintained drive sheet that was injected as an agenda to service.
  playerCharacterKeys: string[];
}

const AUDIT_FULL_FLOOR_MS = 30 * 24 * 60 * 60 * 1000;

export class PipelineQueueService {
  private readonly logger = createLogger("pipeline-queue");
  // Reads the queue's own db handle; built here rather than injected so every
  // existing construction (createApp, the worker tests) keeps its shape.
  private readonly findings: AuditFindingRepository;

  constructor(
    private readonly db: DatabaseClient["db"],
    private readonly runs: PipelineRunRepository,
    private readonly kick: () => void,
  ) {
    this.findings = new AuditFindingRepository(db);
  }

  evaluateAndEnqueue(
    userId: string,
    campaignId: string,
    sessionId: string,
    newContentLength: number,
    thresholds: Thresholds,
    settledSource?: SettledAssistantSource,
  ) {
    if (!thresholds.pipelineAutoEnabled) return;
    if (newContentLength <= 0) return;

    // F (counters): increment FIRST, unconditionally — enqueue decisions below
    // must never cost a turn its char accounting.
    this.db.update(sessions).set({
      pipelineCharsSinceRollingDiff: sql`${sessions.pipelineCharsSinceRollingDiff} + ${newContentLength}`,
      pipelineCharsSinceRepetition: sql`${sessions.pipelineCharsSinceRepetition} + ${newContentLength}`,
      pipelineCharsSinceSysprompt: sql`${sessions.pipelineCharsSinceSysprompt} + ${newContentLength}`,
    }).where(eq(sessions.id, sessionId)).run();

    const session = this.db.select({
      rd: sessions.pipelineCharsSinceRollingDiff,
      rep: sessions.pipelineCharsSinceRepetition,
      sp: sessions.pipelineCharsSinceSysprompt,
    }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) return;

    const now = new Date().toISOString();
    const enqueued: AutoKind[] = [];

    // The rolling diff is the campaign's story-change clock: cadenced sweeps
    // (Dramatist tick, consolidation, archival) key on the ORDINAL of the run
    // being enqueued (completed + 1), stamped into its details.
    let rollingDiffRunId: string | null = null;
    let rollingDiffOrdinal = 0;
    if (session.rd >= thresholds.rollingDiffCharThreshold) {
      if (!this.runs.hasQueuedOrRunningByKindAndCampaign("rolling_diff", campaignId)) {
        const completedCount = this.runs.countCompletedByKindAndCampaign("rolling_diff", campaignId);
        rollingDiffOrdinal = completedCount + 1;
        rollingDiffRunId = createId();
        // `counterThreshold`: the session dial this run was enqueued
        // at, so the runner settles the counter by the SAME amount instead of
        // the repository's hard-coded default.
        this.runs.createRun({
          id: rollingDiffRunId, userId, campaignId, sessionId, kind: "rolling_diff",
          priority: PRIORITY.rolling_diff, status: "queued",
          detailsJson: JSON.stringify({ settledSource, rollingModel: thresholds.rollingModel, embeddingModel: thresholds.embeddingModel, workerEffort: thresholds.workerEffort, openaiFastMode: thresholds.openaiFastModeEnabled ?? false, staleSweep: completedCount > 0 && completedCount % 2 === 0, rollingDiffOrdinal, counterThreshold: thresholds.rollingDiffCharThreshold }),
          requestedAt: now, updatedAt: now,
        });
        enqueued.push("rolling_diff");
      }
    }
    // Cadenced sweeps are armed ONCE per ordinal. A boundary rolling diff that
    // fails leaves the completed count parked on the boundary, so its
    // re-enqueue carries the same ordinal and used to arm a second
    // consolidation/archival. Failed/canceled runs keep
    // their details (the sweep workers rewrite their own at completion, so the
    // marker cannot live there), which makes the earlier attempt visible.
    const ordinalAlreadyArmed = rollingDiffRunId !== null
      && this.runs.hasRunAtRollingDiffOrdinal("rolling_diff", campaignId, rollingDiffOrdinal, rollingDiffRunId);

    if (session.rep >= thresholds.repetitionCharThreshold) {
      if (!this.runs.hasQueuedOrRunningByKindAndCampaign("repetition_detection", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "repetition_detection",
          priority: PRIORITY.repetition_detection, status: "queued",
          detailsJson: JSON.stringify({ settledSource, repetitionModel: thresholds.repetitionModel, workerEffort: thresholds.workerEffort, openaiFastMode: thresholds.openaiFastModeEnabled ?? false, maxAntiRepetitionRules: thresholds.maxAntiRepetitionRules, antiRepArchiveAfter: thresholds.antiRepArchiveAfter, counterThreshold: thresholds.repetitionCharThreshold }), requestedAt: now, updatedAt: now,
        });
        enqueued.push("repetition_detection");
      }
    }

    if (session.sp >= thresholds.syspromptAuditCharThreshold) {
      if (!this.runs.hasQueuedOrRunningByKindAndCampaign("sysprompt_audit", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "sysprompt_audit",
          priority: PRIORITY.sysprompt_audit, status: "queued",
          detailsJson: JSON.stringify({ settledSource, syspromptAuditModel: thresholds.syspromptAuditModel, workerEffort: thresholds.workerEffort, openaiFastMode: thresholds.openaiFastModeEnabled ?? false, counterThreshold: thresholds.syspromptAuditCharThreshold }), requestedAt: now, updatedAt: now,
        });
        enqueued.push("sysprompt_audit");
      }
    }

    // Thread tracker — runs alongside every rolling diff. Maintains the campaign's
    // pending-thread ledger (the constant Thread Index + per-thread lorebook entries).
    if (enqueued.includes("rolling_diff")) {
      if (!this.runs.hasQueuedOrRunningByKindAndCampaign("thread_tracker", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "thread_tracker",
          priority: PRIORITY.thread_tracker, status: "queued",
          detailsJson: JSON.stringify({ settledSource, trackerModel: thresholds.rollingModel, embeddingModel: thresholds.embeddingModel, workerEffort: thresholds.workerEffort, openaiFastMode: thresholds.openaiFastModeEnabled ?? false }),
          requestedAt: now, updatedAt: now,
        });
        this.logger.info({ campaignId }, "auto-enqueued thread tracker");
      }
    }

    // Living World — drive_update runs alongside every rolling diff, keeping NPC
    // drive sheets current. Gated on npcAgendaEnabled so campaigns not using the
    // feature never enqueue it.
    if (enqueued.includes("rolling_diff") && thresholds.npcAgendaEnabled) {
      if (!this.runs.hasQueuedOrRunningByKindAndCampaign("drive_update", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "drive_update",
          priority: PRIORITY.drive_update, status: "queued",
          detailsJson: JSON.stringify({ settledSource, driveModel: thresholds.driveModel, workerEffort: thresholds.workerEffort, openaiFastMode: thresholds.openaiFastModeEnabled ?? false, playerCharacterKeys: thresholds.playerCharacterKeys }),
          requestedAt: now, updatedAt: now,
        });
        this.logger.info({ campaignId }, "auto-enqueued drive update");
      }
    }

    // The Dramatist shares rolling-diff cadence because that worker is the
    // campaign's reliable story-change clock. Count the run being enqueued as
    // the next ordinal; never increment a separate counter that can drift.
    // Same once-per-ordinal guard as the sweeps below.
    let dramatistEnqueued = false;
    if (enqueued.includes("rolling_diff") && thresholds.dramatistEnabled && !ordinalAlreadyArmed) {
      const cadence = Math.max(1, Math.round(thresholds.tickEveryNthRollingDiff));
      const atCadence = rollingDiffOrdinal % cadence === 0;
      const hasDriveSheets = (this.db.select({ count: sql<number>`count(*)` }).from(characterDrives)
        .where(eq(characterDrives.campaignId, campaignId)).get()?.count ?? 0) > 0;
      if (atCadence && hasDriveSheets && !this.runs.hasQueuedOrRunningByKindAndCampaign("world_tick", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "world_tick",
          priority: PRIORITY.world_tick, status: "queued",
          detailsJson: JSON.stringify({ settledSource,
            automatic: true,
            autoApply: true,
            mode: "catchup",
            fromInWorld: null,
            toInWorld: "story-now",
            worldTickModel: thresholds.worldTickModel,
            dramatistEnabled: true,
            dramatistModel: thresholds.dramatistModel,
            dramatistIntensity: thresholds.dramatistIntensity,
            embeddingModel: thresholds.embeddingModel,
            workerEffort: thresholds.workerEffort,
            openaiFastMode: thresholds.openaiFastModeEnabled ?? false,
            rollingDiffOrdinal,
            cadence,
          }),
          requestedAt: now, updatedAt: now,
        });
        dramatistEnqueued = true;
        this.logger.info({ campaignId, rollingDiffOrdinal, cadence }, "auto-enqueued Dramatist world tick");
      }
    }

    // Consolidation sweep every 10th rolling diff, archival every 20th — on the
    // ordinal, guarded once per ordinal (see above). The old gate was the raw
    // completed count (`rdCount % 10`), which fired alongside the 11th diff and
    // again if that diff failed.
    if (enqueued.includes("rolling_diff") && !ordinalAlreadyArmed) {
      const ordinal = rollingDiffOrdinal;
      if (ordinal % 10 === 0 && !this.runs.hasQueuedOrRunningByKindAndCampaign("lorebook_consolidation", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "lorebook_consolidation",
          priority: PRIORITY.lorebook_consolidation, status: "queued",
          detailsJson: JSON.stringify({ settledSource, consolidationModel: thresholds.rollingModel, embeddingModel: thresholds.embeddingModel, workerEffort: thresholds.workerEffort, openaiFastMode: thresholds.openaiFastModeEnabled ?? false, rollingDiffOrdinal: ordinal }),
          requestedAt: now, updatedAt: now,
        });
        this.logger.info({ campaignId, rollingDiffOrdinal: ordinal }, "auto-enqueued lorebook consolidation");
      }

      if (ordinal % 20 === 0 && !this.runs.hasQueuedOrRunningByKindAndCampaign("lorebook_archival", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "lorebook_archival",
          priority: PRIORITY.lorebook_archival, status: "queued",
          detailsJson: JSON.stringify({ settledSource, archivalModel: thresholds.rollingModel, embeddingModel: thresholds.embeddingModel, workerEffort: thresholds.workerEffort, openaiFastMode: thresholds.openaiFastModeEnabled ?? false, rollingDiffOrdinal: ordinal }),
          requestedAt: now, updatedAt: now,
        });
        this.logger.info({ campaignId, rollingDiffOrdinal: ordinal }, "auto-enqueued lorebook archival");
      }
    }

    // Campaign audit — cadenced on ENTRY CHANGES since the last completed audit
    // (not chars): the audit reconciles lorebook state, so lorebook churn is the
    // signal. QUICK on the frequent threshold; FULL on the rare threshold with a
    // 30-day floor (a full run re-reads the whole transcript — heavyweight).
    //
    // REPAIR WRITES DO NOT COUNT. Fixing an audit's findings edits entries, and
    // those edits used to ratchet the next audit closer — an audit partly
    // triggered by the cleanup after the previous one. (Measured on one campaign
    // 2026-07-29: all 8 entries in the bucket were ruling writes — 16% of the
    // threshold already spent on repairs.) A run's own auto-applied ops land
    // before its completedAt so those were already excluded, but rulings
    // executed AFTER it completes — the ⚖ review queue, or an out-of-band fix —
    // were not. Classify by the entry's most recent revision source, which is
    // the write that superseded it: audit + ruling writes are excluded; story
    // churn (rolling_diff, consolidation, thread_tracker) and human edits
    // (manual, user) still count. Entries with no revision at all count, as
    // before — constants are never revision-captured.
    let auditEnqueued = false;
    if (thresholds.auditAutoEnabled && !this.runs.hasQueuedOrRunningByKindAndCampaign("campaign_audit", campaignId)) {
      const lastAudit = this.runs.findLatestCompletedByKindAndCampaign("campaign_audit", campaignId);
      const since = lastAudit?.completedAt ?? "";
      const changed = this.db.select({ n: sql<number>`count(*)` }).from(lorebookEntries)
        .where(and(
          eq(lorebookEntries.campaignId, campaignId),
          gt(lorebookEntries.updatedAt, since),
          sql`coalesce((select r.source from ${lorebookEntryRevisions} r
                        where r.entry_id = ${lorebookEntries.id}
                        order by r.revision_no desc limit 1), '')
              not in ('campaign_audit', 'campaign_audit_ruling')`,
        ))
        .get()?.n ?? 0;
      let mode: "quick" | "full" | null = null;
      if (changed >= thresholds.auditFullEveryNChanges) {
        const lastFull = this.runs.findLatestCompletedByKindAndCampaign("campaign_audit", campaignId, { path: "$.mode", value: "full" });
        const floorOk = !lastFull?.completedAt || Date.now() - new Date(lastFull.completedAt).getTime() > AUDIT_FULL_FLOOR_MS;
        mode = floorOk ? "full" : "quick";
      } else if (changed >= thresholds.auditQuickEveryNChanges) {
        mode = "quick";
      }
      if (mode) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "campaign_audit",
          priority: PRIORITY.campaign_audit, status: "queued",
          detailsJson: JSON.stringify({ settledSource, mode, auditModel: thresholds.auditModel, embeddingModel: thresholds.embeddingModel, workerEffort: thresholds.workerEffort, openaiFastMode: thresholds.openaiFastModeEnabled ?? false, auto: true }),
          requestedAt: now, updatedAt: now,
        });
        auditEnqueued = true;
        this.logger.info({ campaignId, mode, changed }, "auto-enqueued campaign audit");
      }
    }

    if (enqueued.length > 0 || auditEnqueued || dramatistEnqueued) {
      this.logger.info({ campaignId, sessionId, enqueued, auditEnqueued, dramatistEnqueued }, "auto-enqueued pipeline jobs");
      this.kick();
    }
  }

  sweepStaleLocks() {
    const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString();
    const stale = this.runs.findStaleRunningJobs(cutoff);
    const now = new Date().toISOString();
    for (const run of stale) {
      this.logger.warn({ runId: run.id, kind: run.kind, startedAt: run.startedAt }, "stale lock timeout — marking failed");
      const failed = this.runs.markFailed(run.id, now, "stale lock timeout (60 min)", null);
      // A reaped ruling executor never reaches the worker's in-process catch
      // paths — the only callers of reopenByRulingRun — so its findings stayed
      // `processing` forever: the chip polled at 4 s, resubmits 409'd, and no
      // sweep touched them.
      if (failed && run.kind === "audit_ruling") {
        const reopened = this.findings.reopenByRulingRun(run.id, now);
        if (reopened > 0) this.logger.warn({ runId: run.id, reopened }, "released the findings of a stale ruling run");
      }
    }
    // Same class, other entry points (worker-side sweep, cancel, deleted run):
    // any processing finding with no queued/running ruling run is released.
    const orphaned = this.findings.releaseOrphanedProcessing(now);
    if (orphaned > 0) this.logger.warn({ orphaned }, "released processing findings with no live ruling run");
    return stale.length;
  }
}
