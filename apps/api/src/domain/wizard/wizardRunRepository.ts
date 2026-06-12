import { and, asc, desc, eq, isNull, or } from "drizzle-orm";

import { wizardRuns, type DatabaseClient } from "@tracyhill-rp/db";

import { recordSystemEvent } from "../system/systemEvents";

export type StoredWizardRunStep = {
  status: "pending" | "running" | "completed" | "failed";
  result: string | null;
  error: string | null;
};

export type LorebookCorpusEntry = {
  name: string;
  tag: string | null;
  content: string;
  keys: string[];
  keysSecondary?: string[];
  isConstant: boolean;
  position?: string;
  insertionOrder?: number;
  scanDepth?: number;
  startingAttire?: string;
};

export type StoredWizardRunDetails = {
  steps: {
    systemPrompt: StoredWizardRunStep;
    lorebookCorpus: StoredWizardRunStep;
  };
  review: {
    campaignName: string;
    brief: string;
    wizardTranscript: string;
    wizardSessionId: string | null;
    systemPromptDraft: string | null;
    lorebookCorpusDraft: LorebookCorpusEntry[] | null;
    approvedCampaignId: string | null;
    approvedSessionId: string | null;
    retriedFromRunId: string | null;
  };
};

export function synthesizeWizardTranscript(campaignName: string, brief: string, wizardTranscript?: string | null) {
  const transcript = wizardTranscript?.trim();
  if (transcript) return transcript;
  const trimmedBrief = brief.trim();
  if (!trimmedBrief) return `### User\n\nCampaign Name: ${campaignName}\n`;
  return [
    "### User",
    "",
    `Campaign Name: ${campaignName}`,
    "",
    trimmedBrief,
  ].join("\n");
}

export function createDefaultWizardRunDetails(campaignName = "New Campaign", brief = "", wizardTranscript = ""): StoredWizardRunDetails {
  const step = (): StoredWizardRunStep => ({ status: "pending", result: null, error: null });
  return {
    steps: {
      systemPrompt: step(),
      lorebookCorpus: step(),
    },
    review: {
      campaignName,
      brief,
      wizardTranscript: synthesizeWizardTranscript(campaignName, brief, wizardTranscript),
      wizardSessionId: null,
      systemPromptDraft: null,
      lorebookCorpusDraft: null,
      approvedCampaignId: null,
      approvedSessionId: null,
      retriedFromRunId: null,
    },
  };
}

export function parseWizardRunDetails(raw: string | null | undefined) {
  if (!raw) return createDefaultWizardRunDetails();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredWizardRunDetails>;
    const fallback = createDefaultWizardRunDetails(
      parsed.review?.campaignName ?? "New Campaign",
      parsed.review?.brief ?? "",
      parsed.review?.wizardTranscript ?? "",
    );
    return {
      steps: {
        systemPrompt: { ...fallback.steps.systemPrompt, ...(parsed.steps?.systemPrompt ?? {}) },
        lorebookCorpus: { ...fallback.steps.lorebookCorpus, ...(parsed.steps?.lorebookCorpus ?? {}) },
      },
      review: {
        ...fallback.review,
        ...(parsed.review ?? {}),
      },
    } satisfies StoredWizardRunDetails;
  } catch {
    return createDefaultWizardRunDetails();
  }
}

export class WizardRunRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listForUser(userId: string) {
    return this.db.select().from(wizardRuns)
      .where(eq(wizardRuns.userId, userId))
      .orderBy(desc(wizardRuns.requestedAt), desc(wizardRuns.updatedAt))
      .all();
  }

  listActiveForUser(userId: string) {
    return this.db.select().from(wizardRuns)
      .where(and(
        eq(wizardRuns.userId, userId),
        isNull(wizardRuns.approvedAt),
        or(
          eq(wizardRuns.status, "queued"),
          eq(wizardRuns.status, "running"),
          eq(wizardRuns.status, "completed"),
          eq(wizardRuns.status, "failed"),
        ),
      ))
      .orderBy(desc(wizardRuns.requestedAt), desc(wizardRuns.updatedAt))
      .all();
  }

  findById(userId: string, runId: string) {
    return this.db.select().from(wizardRuns)
      .where(and(eq(wizardRuns.userId, userId), eq(wizardRuns.id, runId)))
      .get();
  }

  findNextQueued() {
    return this.db.select().from(wizardRuns)
      .where(eq(wizardRuns.status, "queued"))
      .orderBy(asc(wizardRuns.requestedAt), asc(wizardRuns.updatedAt))
      .get();
  }

  createRun(input: typeof wizardRuns.$inferInsert) {
    this.db.insert(wizardRuns).values(input).run();
  }

  markRunning(runId: string, startedAt: string) {
    const result = this.db.update(wizardRuns)
      .set({ status: "running", startedAt, updatedAt: startedAt })
      .where(and(eq(wizardRuns.id, runId), eq(wizardRuns.status, "queued")))
      .run();
    return result.changes > 0;
  }

  updateRun(runId: string, input: Partial<typeof wizardRuns.$inferInsert>) {
    this.db.update(wizardRuns).set(input).where(eq(wizardRuns.id, runId)).run();
  }

  markCompleted(runId: string, completedAt: string, summary: string, detailsJson?: string | null) {
    this.db.update(wizardRuns)
      .set({ status: "completed", summary, error: null, detailsJson: detailsJson ?? null, completedAt, updatedAt: completedAt })
      .where(eq(wizardRuns.id, runId))
      .run();
  }

  markFailed(runId: string, failedAt: string, summary: string, detailsJson?: string | null) {
    // null/undefined detailsJson PRESERVES the existing details — callers on
    // failure paths used to pass null and wipe step progress/watermarks/model
    // config, breaking retry-from-step diagnostics.
    this.db.update(wizardRuns)
      .set({ status: "failed", summary, error: summary, ...(detailsJson != null ? { detailsJson } : {}), completedAt: failedAt, updatedAt: failedAt })
      .where(eq(wizardRuns.id, runId))
      .run();
    // No-silent-failures: surface wizard worker failures as system events.
    const run = this.db.select().from(wizardRuns).where(eq(wizardRuns.id, runId)).get();
    if (run) {
      recordSystemEvent({
        userId: run.userId,
        source: "wizard",
        severity: "error",
        message: `wizard run failed: ${summary}`,
        details: { runId },
      });
    }
  }

  markCanceled(runId: string, canceledAt: string, summary: string, detailsJson?: string | null) {
    this.db.update(wizardRuns)
      .set({ status: "canceled", summary, error: summary, ...(detailsJson != null ? { detailsJson } : {}), completedAt: canceledAt, updatedAt: canceledAt })
      .where(eq(wizardRuns.id, runId))
      .run();
  }
}
