import { and, asc, desc, eq, isNull, lt, ne, not, or, sql } from "drizzle-orm";

import { pipelineRuns, type DatabaseClient } from "@tracyhill-rp/db";
import type { PipelineRetryMode } from "@tracyhill-rp/contracts";

import { recordSystemEvent } from "../system/systemEvents";

import type { SystemEventSource } from "../system/systemEvents";

export type StoredPipelineRunStep = {
  status: "pending" | "running" | "completed" | "failed";
  result: string | null;
  error: string | null;
};

export type StoredPipelineRunDetails = {
  models?: {
    creativeModelId: string;
  };
  steps: {
    analysis?: StoredPipelineRunStep;
    lorebookRefresh?: StoredPipelineRunStep;
    syspromptUpdate?: StoredPipelineRunStep;
    repetitionDetection?: StoredPipelineRunStep;
  };
  review: {
    analysisReport?: string | null;
    lorebookOperations?: string | null;
    syspromptNoChanges?: boolean | null;
    systemPromptDraft: string | null;
    antiRepetitionRules?: string | null;
    watermarkBefore?: number | null;
    watermarkAfter?: number | null;
    retriedFromRunId: string | null;
    retriedFromStep: PipelineRetryMode | null;
    approvedSessionId: string | null;
  };
};

const EMPTY_STEP: StoredPipelineRunStep = { status: "pending", result: null, error: null };

export function createDefaultPipelineRunDetails(): StoredPipelineRunDetails {
  return {
    steps: {
      analysis: { ...EMPTY_STEP },
      lorebookRefresh: { ...EMPTY_STEP },
      syspromptUpdate: { ...EMPTY_STEP },
      repetitionDetection: { ...EMPTY_STEP },
    },
    review: {
      analysisReport: null,
      lorebookOperations: null,
      syspromptNoChanges: null,
      systemPromptDraft: null,
      antiRepetitionRules: null,
      watermarkBefore: null,
      watermarkAfter: null,
      retriedFromRunId: null,
      retriedFromStep: null,
      approvedSessionId: null,
    },
  };
}

export function parsePipelineRunDetails(raw: string | null | undefined): StoredPipelineRunDetails {
  if (!raw) return createDefaultPipelineRunDetails();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPipelineRunDetails>;
    const defaults = createDefaultPipelineRunDetails();
    return {
      models: parsed.models,
      steps: {
        analysis: parsed.steps?.analysis ? { ...EMPTY_STEP, ...parsed.steps.analysis } : undefined,
        lorebookRefresh: parsed.steps?.lorebookRefresh ? { ...EMPTY_STEP, ...parsed.steps.lorebookRefresh } : undefined,
        syspromptUpdate: parsed.steps?.syspromptUpdate ? { ...EMPTY_STEP, ...parsed.steps.syspromptUpdate } : undefined,
        repetitionDetection: parsed.steps?.repetitionDetection ? { ...EMPTY_STEP, ...parsed.steps.repetitionDetection } : undefined,
      },
      review: {
        ...defaults.review,
        ...(parsed.review ?? {}),
      },
    };
  } catch {
    return createDefaultPipelineRunDetails();
  }
}

export class PipelineRunRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForCampaign(userId: string, campaignId: string) {
    return this.db.select().from(pipelineRuns)
      .where(and(eq(pipelineRuns.userId, userId), eq(pipelineRuns.campaignId, campaignId)))
      .orderBy(desc(pipelineRuns.requestedAt), desc(pipelineRuns.updatedAt))
      .all();
  }

  findById(userId: string, runId: string) {
    return this.db.select().from(pipelineRuns)
      .where(and(eq(pipelineRuns.userId, userId), eq(pipelineRuns.id, runId)))
      .get();
  }

  listActiveForUser(userId: string) {
    return this.db.select().from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.userId, userId),
        isNull(pipelineRuns.approvedAt),
        or(
          eq(pipelineRuns.status, "queued"),
          eq(pipelineRuns.status, "running"),
          eq(pipelineRuns.status, "completed"),
        ),
      ))
      .orderBy(desc(pipelineRuns.updatedAt), desc(pipelineRuns.requestedAt))
      .all();
  }

  findNextQueuedRespectingCampaignLock() {
    // Auto jobs can run concurrently with each other — they touch disjoint data.
    // campaign_review touches everything, so it serializes against all jobs.
    return this.db.select().from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.status, "queued"),
        sql`CASE
          WHEN ${pipelineRuns.kind} IN ('rolling_diff','repetition_detection','sysprompt_audit','lorebook_consolidation','thread_tracker')
          THEN ${pipelineRuns.campaignId} NOT IN (
            SELECT campaign_id FROM ${pipelineRuns} WHERE status = 'running' AND kind = 'campaign_review'
          )
          ELSE ${pipelineRuns.campaignId} NOT IN (
            SELECT campaign_id FROM ${pipelineRuns} WHERE status = 'running'
          )
        END`,
      ))
      .orderBy(asc(pipelineRuns.priority), asc(pipelineRuns.requestedAt))
      .get();
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
    return this.db.select().from(pipelineRuns)
      .where(and(
        eq(pipelineRuns.status, "running"),
        lt(pipelineRuns.startedAt, cutoffIso),
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
    this.db.update(pipelineRuns)
      .set({ status: "completed", summary, detailsJson: detailsJson ?? null, error: null, completedAt, updatedAt: completedAt })
      .where(eq(pipelineRuns.id, runId))
      .run();
  }

  markFailed(runId: string, failedAt: string, summary: string, detailsJson?: string | null) {
    // null/undefined detailsJson PRESERVES the existing details — callers on
    // failure paths used to pass null and wipe step progress/watermarks/model
    // config, breaking retry-from-step diagnostics.
    this.db.update(pipelineRuns)
      .set({ status: "failed", summary, error: summary, ...(detailsJson != null ? { detailsJson } : {}), completedAt: failedAt, updatedAt: failedAt })
      .where(eq(pipelineRuns.id, runId))
      .run();
    // No-silent-failures: every worker failure surfaces as a system event.
    // Recording here (the one shared failure path) covers all run kinds.
    const run = this.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).get();
    if (run) {
      const knownSources = new Set([
        "campaign_review", "rolling_diff", "thread_tracker", "repetition_detection",
        "sysprompt_audit", "lorebook_consolidation", "lorebook_archival",
      ]);
      recordSystemEvent({
        userId: run.userId,
        source: (knownSources.has(run.kind) ? run.kind : "pipeline") as SystemEventSource,
        severity: "error",
        message: `${run.kind} run failed: ${summary}`,
        campaignId: run.campaignId,
        sessionId: run.sessionId ?? null,
        details: { runId },
      });
    }
  }

  markCanceled(runId: string, canceledAt: string, summary: string, detailsJson?: string | null) {
    this.db.update(pipelineRuns)
      .set({ status: "canceled", summary, error: summary, ...(detailsJson != null ? { detailsJson } : {}), completedAt: canceledAt, updatedAt: canceledAt })
      .where(eq(pipelineRuns.id, runId))
      .run();
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

  countCompletedByKindAndCampaign(kind: string, campaignId: string): number {
    const result = this.db.select({ count: sql<number>`count(*)` }).from(pipelineRuns)
      .where(and(eq(pipelineRuns.kind, kind), eq(pipelineRuns.campaignId, campaignId), eq(pipelineRuns.status, "completed")))
      .get();
    return result?.count ?? 0;
  }

  deleteRun(userId: string, runId: string) {
    const result = this.db.delete(pipelineRuns)
      .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.userId, userId)))
      .run();
    return result.changes > 0;
  }

  transact(fn: () => void) {
    this.db.transaction(() => { fn(); });
  }
}
