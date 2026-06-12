import { sessions, type DatabaseClient } from "@tracyhill-rp/db";
import { eq, sql } from "drizzle-orm";
import { createLogger } from "@tracyhill-rp/logging";

import { createId } from "../../lib/ids";
import type { PipelineRunRepository } from "./pipelineRunRepository";

const PRIORITY = { rolling_diff: 10, repetition_detection: 20, sysprompt_audit: 30, thread_tracker: 40, lorebook_consolidation: 60, lorebook_archival: 70 } as const;
const STALE_LOCK_MS = 60 * 60 * 1000;

type AutoKind = "rolling_diff" | "repetition_detection" | "sysprompt_audit";

interface Thresholds {
  rollingDiffCharThreshold: number;
  repetitionCharThreshold: number;
  syspromptAuditCharThreshold: number;
  rollingModel: string;
  embeddingModel: string;
  pipelineAutoEnabled: boolean;
}

export class PipelineQueueService {
  private readonly logger = createLogger("pipeline-queue");

  constructor(
    private readonly db: DatabaseClient["db"],
    private readonly runs: PipelineRunRepository,
    private readonly kick: () => void,
  ) {}

  evaluateAndEnqueue(
    userId: string,
    campaignId: string,
    sessionId: string,
    newContentLength: number,
    thresholds: Thresholds,
  ) {
    if (!thresholds.pipelineAutoEnabled) return;
    if (newContentLength <= 0) return;
    if (this.runs.hasQueuedOrRunningByKindAndCampaign("campaign_review", campaignId)) return;

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

    if (session.rd >= thresholds.rollingDiffCharThreshold) {
      if (!this.runs.hasQueuedOrRunningByKindAndCampaign("rolling_diff", campaignId)) {
        const completedCount = this.runs.countCompletedByKindAndCampaign("rolling_diff", campaignId);
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "rolling_diff",
          priority: PRIORITY.rolling_diff, status: "queued",
          detailsJson: JSON.stringify({ rollingModel: thresholds.rollingModel, embeddingModel: thresholds.embeddingModel, staleSweep: completedCount > 0 && completedCount % 2 === 0 }),
          requestedAt: now, updatedAt: now,
        });
        enqueued.push("rolling_diff");
      }
    }

    if (session.rep >= thresholds.repetitionCharThreshold) {
      if (!this.runs.hasQueuedOrRunningByKindAndCampaign("repetition_detection", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "repetition_detection",
          priority: PRIORITY.repetition_detection, status: "queued",
          detailsJson: null, requestedAt: now, updatedAt: now,
        });
        enqueued.push("repetition_detection");
      }
    }

    if (session.sp >= thresholds.syspromptAuditCharThreshold) {
      if (!this.runs.hasQueuedOrRunningByKindAndCampaign("sysprompt_audit", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "sysprompt_audit",
          priority: PRIORITY.sysprompt_audit, status: "queued",
          detailsJson: null, requestedAt: now, updatedAt: now,
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
          detailsJson: JSON.stringify({ trackerModel: thresholds.rollingModel, embeddingModel: thresholds.embeddingModel }),
          requestedAt: now, updatedAt: now,
        });
        this.logger.info({ campaignId }, "auto-enqueued thread tracker");
      }
    }

    // Consolidation sweep — every 10th rolling diff, lowest priority
    if (enqueued.includes("rolling_diff")) {
      const rdCount = this.runs.countCompletedByKindAndCampaign("rolling_diff", campaignId);
      if (rdCount > 0 && rdCount % 10 === 0 && !this.runs.hasQueuedOrRunningByKindAndCampaign("lorebook_consolidation", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "lorebook_consolidation",
          priority: PRIORITY.lorebook_consolidation, status: "queued",
          detailsJson: JSON.stringify({ consolidationModel: thresholds.rollingModel, embeddingModel: thresholds.embeddingModel }),
          requestedAt: now, updatedAt: now,
        });
        this.logger.info({ campaignId, rdCount }, "auto-enqueued lorebook consolidation");
      }

      // Archival sweep — every 20th rolling diff
      if (rdCount > 0 && rdCount % 20 === 0 && !this.runs.hasQueuedOrRunningByKindAndCampaign("lorebook_archival", campaignId)) {
        this.runs.createRun({
          id: createId(), userId, campaignId, sessionId, kind: "lorebook_archival",
          priority: PRIORITY.lorebook_archival, status: "queued",
          detailsJson: JSON.stringify({ archivalModel: thresholds.rollingModel, embeddingModel: thresholds.embeddingModel }),
          requestedAt: now, updatedAt: now,
        });
        this.logger.info({ campaignId, rdCount }, "auto-enqueued lorebook archival");
      }
    }

    if (enqueued.length > 0) {
      this.logger.info({ campaignId, sessionId, enqueued }, "auto-enqueued pipeline jobs");
      this.kick();
    }
  }

  sweepStaleLocks() {
    const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString();
    const stale = this.runs.findStaleRunningJobs(cutoff);
    for (const run of stale) {
      this.logger.warn({ runId: run.id, kind: run.kind, startedAt: run.startedAt }, "stale lock timeout — marking failed");
      this.runs.markFailed(run.id, new Date().toISOString(), "stale lock timeout (60 min)", null);
    }
    return stale.length;
  }
}
