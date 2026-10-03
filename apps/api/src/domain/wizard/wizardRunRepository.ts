import { and, asc, desc, eq, isNull, or } from "drizzle-orm";

import { wizardRuns, type DatabaseClient } from "@tracyhill-rp/db";
import { WIZARD_PLAYER_CHARACTER_FALLBACK, type AntagonistScheme, type LorebookCorpusActivation, type LorebookCorpusOrigin, type WizardAutoCorrection, type WizardLintFinding, type WizardRunReview } from "@tracyhill-rp/contracts";

import { recordSystemEvent } from "../system/systemEvents";

type StoredWizardRunStep = {
  status: "pending" | "running" | "completed" | "failed";
  result: string | null;
  error: string | null;
  progress?: string | null;
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
  // Living World — optional compact drive seed for a character entry.
  // Mirrors lorebookCorpusEntrySchema.startingDrives in @tracyhill-rp/contracts.
  // redLines/leverage/concealment are the structural-capability fields the drive
  // sheet has always supported but the wizard never requested or accepted, so
  // every generated cast arrived unable to oppose anyone. Keep in sync.
  startingDrives?: {
    wants?: string[];
    goals?: string[];
    redLines?: string[];
    leverage?: string[];
    concealment?: { secret: string; behavior: string }[];
    offpageProject?: string;
    dispositions?: Record<string, string>;
  };
  // The sealed drive schema currently supports one active scheme. Keep the
  // plural wizard wire shape so future queued schemes do not need a migration.
  startingSchemes?: AntagonistScheme[];
  // An imported entry's trigger settings and provenance (SillyTavern import); mirrors lorebookCorpusEntrySchema.
  activation?: LorebookCorpusActivation;
  origin?: LorebookCorpusOrigin;
};

/**
 * One entry of an imported lorebook, normalized at the request (SillyTavern import):
 * the text with {{user}} and {{char}} resolved, the keys, and how it fired. The worker sorts and enriches these; the
 * text itself is never rewritten except to remove player-authority lines the wizard lint flags.
 */
export type ImportSourceEntry = {
  index: number;
  title: string;
  content: string;
  keys: string[];
  keysSecondary: string[];
  isConstant: boolean;
  position: string;
  insertionOrder: number;
  scanDepth: number;
  activation: LorebookCorpusActivation;
  // The SillyTavern group, a hint for sorting.
  group: string | null;
};

export type StoredWizardImportSource = {
  format: "sillytavern";
  fileName: string;
  charName: string;
  notes: string;
  addCharacterSections: boolean;
  entries: ImportSourceEntry[];
  // Field corrections the importer's row mapper reported, shown in the review as advisories.
  notices: string[];
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
    playerCharacterName: string;
    systemPromptDraft: string | null;
    lorebookCorpusDraft: LorebookCorpusEntry[] | null;
    autoCorrections: WizardAutoCorrection[];
    lintResidue: WizardLintFinding[];
    approvedCampaignId: string | null;
    approvedSessionId: string | null;
    retriedFromRunId: string | null;
    importSummary: WizardRunReview["importSummary"];
  };
  // Present on a lorebook import run. Never sent to the client: the review carries importSummary instead.
  source?: StoredWizardImportSource | null;
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
      playerCharacterName: WIZARD_PLAYER_CHARACTER_FALLBACK,
      systemPromptDraft: null,
      lorebookCorpusDraft: null,
      autoCorrections: [],
      lintResidue: [],
      approvedCampaignId: null,
      approvedSessionId: null,
      retriedFromRunId: null,
      importSummary: null,
    },
    source: null,
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
      source: parsed.source ?? null,
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

  deleteRun(id: string) {
    return this.db.delete(wizardRuns).where(eq(wizardRuns.id, id)).run();
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

  /** Approval stamp guarded on `status = completed AND approved_at IS NULL`;
   *  false when another approval already landed on the row. */
  stampApproved(runId: string, input: { summary: string; approvedAt: string; detailsJson: string; updatedAt: string }): boolean {
    const result = this.db.update(wizardRuns)
      .set(input)
      .where(and(eq(wizardRuns.id, runId), eq(wizardRuns.status, "completed"), isNull(wizardRuns.approvedAt)))
      .run();
    return result.changes > 0;
  }

  transact(fn: () => void) {
    this.db.transaction(() => { fn(); });
  }

  markCompleted(runId: string, completedAt: string, summary: string, detailsJson?: string | null) {
    // Guarded transition: only a still-`running` row may complete.
    const result = this.db.update(wizardRuns)
      .set({ status: "completed", summary, error: null, detailsJson: detailsJson ?? null, completedAt, updatedAt: completedAt })
      .where(and(eq(wizardRuns.id, runId), eq(wizardRuns.status, "running")))
      .run();
    return result.changes > 0;
  }

  markFailed(runId: string, failedAt: string, summary: string, detailsJson?: string | null) {
    // null/undefined detailsJson PRESERVES the existing details — callers on
    // failure paths used to pass null and wipe the step progress and review
    // output, breaking retry diagnostics.
    // Guarded transition: only queued/running rows may fail.
    const result = this.db.update(wizardRuns)
      .set({ status: "failed", summary, error: summary, ...(detailsJson != null ? { detailsJson } : {}), completedAt: failedAt, updatedAt: failedAt })
      .where(and(eq(wizardRuns.id, runId), or(eq(wizardRuns.status, "queued"), eq(wizardRuns.status, "running"))))
      .run();
    if (result.changes > 0) {
      // No-silent-failures: surface wizard worker failures as system events.
      // Inside the changes>0 guard so a lost transition records nothing.
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
    return result.changes > 0;
  }

  markCanceled(runId: string, canceledAt: string, summary: string, detailsJson?: string | null) {
    const result = this.db.update(wizardRuns)
      .set({ status: "canceled", summary, error: summary, ...(detailsJson != null ? { detailsJson } : {}), completedAt: canceledAt, updatedAt: canceledAt })
      .where(and(eq(wizardRuns.id, runId), or(eq(wizardRuns.status, "queued"), eq(wizardRuns.status, "running"))))
      .run();
    return result.changes > 0;
  }

  // Heartbeat liveness + updatedAt-based stale sweep (wizard parity).
  heartbeat(runId: string) {
    const now = new Date().toISOString();
    this.db.update(wizardRuns)
      .set({ updatedAt: now })
      .where(and(eq(wizardRuns.id, runId), eq(wizardRuns.status, "running")))
      .run();
  }

  hasQueuedOrRunning(userId: string): boolean {
    return !!this.db.select({ id: wizardRuns.id }).from(wizardRuns)
      .where(and(
        eq(wizardRuns.userId, userId),
        or(eq(wizardRuns.status, "queued"), eq(wizardRuns.status, "running")),
      ))
      .get();
  }

  // Boot orphan recovery (wizard parity). Resets process-orphaned
  // running rows back to queued; idempotent, records a system_event each.
  recoverOrphanedRunningJobs() {
    const orphans = this.db.select().from(wizardRuns).where(eq(wizardRuns.status, "running")).all();
    if (orphans.length === 0) return orphans;
    const now = new Date().toISOString();
    this.db.update(wizardRuns)
      .set({ status: "queued", startedAt: null, approvedAt: null, completedAt: null, updatedAt: now })
      .where(eq(wizardRuns.status, "running"))
      .run();
    for (const run of orphans) {
      recordSystemEvent({
        userId: run.userId,
        source: "wizard",
        severity: "info",
        message: "recovered orphaned wizard run after restart — requeued",
        details: { runId: run.id },
      });
    }
    return orphans;
  }
}
