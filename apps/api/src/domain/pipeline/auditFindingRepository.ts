import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { auditFindings, type DatabaseClient } from "@tracyhill-rp/db";

import { createId } from "../../lib/ids";

// Findings review queue. Rows are the
// audit's ambiguous residue awaiting an owner ruling. Cross-run dedupe is by
// fingerprint: audits are stateless, so the same unresolved tension re-derives
// every run — a re-flag refreshes the existing ACTIVE row instead of stacking.

export type AuditFindingRow = typeof auditFindings.$inferSelect;

export interface FlaggedFindingInput {
  userId: string;
  campaignId: string;
  runId: string;
  kind: string;
  summary: string;
  detail: string | null;
  reason: string | null;
  entryIds: string[];
}

/** Stable-ish identity for an LLM-worded finding: implicated entries when we
 *  have them (wording drifts run-to-run; the entry set mostly doesn't), else a
 *  normalized summary prefix. Collisions merge — acceptable: the blurb refreshes
 *  to the latest wording and the owner rules once. */
export function fingerprintFinding(f: { kind: string; summary: string; entryIds?: string[] | null }): string {
  const ids = (f.entryIds ?? []).filter(Boolean);
  if (ids.length > 0) return `${f.kind}|${[...ids].sort().join(",")}`;
  const normalized = f.summary.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
  return `${f.kind}|${normalized}`;
}

export class AuditFindingRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  /** Persist one flagged finding. An ACTIVE (open/processing) row with the same
   *  fingerprint absorbs it: open rows refresh their blurb to the newest audit's
   *  wording (preserving any ruling/bounce context), processing rows are left
   *  alone (they're being executed right now). */
  upsertFlagged(input: FlaggedFindingInput, now: string): string {
    const fingerprint = fingerprintFinding(input);
    const existing = this.db.select().from(auditFindings)
      .where(and(
        eq(auditFindings.campaignId, input.campaignId),
        eq(auditFindings.fingerprint, fingerprint),
        inArray(auditFindings.status, ["open", "processing"]),
      ))
      .get();
    if (existing) {
      if (existing.status === "open") {
        this.db.update(auditFindings).set({
          runId: input.runId, summary: input.summary, detail: input.detail,
          reason: input.reason, entryIds: JSON.stringify(input.entryIds), updatedAt: now,
        }).where(eq(auditFindings.id, existing.id)).run();
      }
      return existing.id;
    }
    const id = createId();
    this.db.insert(auditFindings).values({
      id, userId: input.userId, campaignId: input.campaignId, runId: input.runId,
      fingerprint, kind: input.kind, summary: input.summary, detail: input.detail,
      reason: input.reason, entryIds: JSON.stringify(input.entryIds),
      status: "open", createdAt: now, updatedAt: now,
    }).run();
    return id;
  }

  /** Active queue plus a bounded tail of recent rulings for reference. */
  listForCampaign(userId: string, campaignId: string, ruledLimit = 20): AuditFindingRow[] {
    const active = this.db.select().from(auditFindings)
      .where(and(eq(auditFindings.userId, userId), eq(auditFindings.campaignId, campaignId), inArray(auditFindings.status, ["open", "processing"])))
      .orderBy(desc(auditFindings.updatedAt))
      .all();
    const ruled = this.db.select().from(auditFindings)
      .where(and(eq(auditFindings.userId, userId), eq(auditFindings.campaignId, campaignId), eq(auditFindings.status, "ruled")))
      .orderBy(desc(auditFindings.ruledAt))
      .limit(ruledLimit)
      .all();
    return [...active, ...ruled];
  }

  findByIds(userId: string, campaignId: string, ids: string[]): AuditFindingRow[] {
    if (ids.length === 0) return [];
    return this.db.select().from(auditFindings)
      .where(and(eq(auditFindings.userId, userId), eq(auditFindings.campaignId, campaignId), inArray(auditFindings.id, ids)))
      .all();
  }

  listByRulingRun(rulingRunId: string): AuditFindingRow[] {
    return this.db.select().from(auditFindings)
      .where(and(eq(auditFindings.rulingRunId, rulingRunId), eq(auditFindings.status, "processing")))
      .all();
  }

  markProcessing(items: Array<{ findingId: string; ruling: string }>, rulingRunId: string, now: string): void {
    for (const item of items) {
      this.db.update(auditFindings).set({
        status: "processing", ruling: item.ruling, rulingRunId, executorQuestion: null, updatedAt: now,
      }).where(eq(auditFindings.id, item.findingId)).run();
    }
  }

  markRuled(id: string, outcome: string, now: string): void {
    this.db.update(auditFindings).set({ status: "ruled", outcome, ruledAt: now, updatedAt: now }).where(eq(auditFindings.id, id)).run();
  }

  /** Executor couldn't act — back to the queue with a specific question; the
   *  submitted ruling text is preserved so the owner can refine it in place. */
  bounce(id: string, question: string, now: string): void {
    this.db.update(auditFindings).set({ status: "open", executorQuestion: question, updatedAt: now }).where(eq(auditFindings.id, id)).run();
  }

  /** Queue hygiene (offscreen-flow 2026-07-17): a completed audit is the
   *  freshest whole-picture verdict — open findings it did NOT re-derive were
   *  resolved elsewhere (rulings, offscreen reconciliation, live play, later
   *  audits refuting them) and would otherwise sit in the owner's queue
   *  forever. Close them with an explanatory outcome. Coverage-kind findings
   *  only close on FULL runs (quick runs never look for coverage). */
  autoCloseStale(userId: string, campaignId: string, activeFingerprints: Set<string>, mode: "quick" | "full", now: string): number {
    const open = this.db.select().from(auditFindings)
      .where(and(eq(auditFindings.userId, userId), eq(auditFindings.campaignId, campaignId), eq(auditFindings.status, "open")))
      .all();
    let closed = 0;
    for (const row of open) {
      if (activeFingerprints.has(row.fingerprint)) continue;
      if (row.kind === "coverage" && mode !== "full") continue;
      this.db.update(auditFindings).set({
        status: "ruled",
        outcome: "auto-resolved — the latest audit no longer detects this conflict (fixed by rulings, offscreen reconciliation, or later canon)",
        ruledAt: now, updatedAt: now,
      }).where(eq(auditFindings.id, row.id)).run();
      closed++;
    }
    return closed;
  }

  /** Failure path: a dead ruling run releases its findings back to the queue. */
  reopenByRulingRun(rulingRunId: string, now: string): number {
    const rows = this.listByRulingRun(rulingRunId);
    for (const row of rows) {
      this.db.update(auditFindings).set({ status: "open", updatedAt: now }).where(eq(auditFindings.id, row.id)).run();
    }
    return rows.length;
  }

  /** Sweep hygiene: a `processing` finding whose ruling
   *  run is no longer queued/running has no executor left to release it — the
   *  API's stale-lock sweep failed the run out of process (the worker's catch
   *  paths, the only callers of `reopenByRulingRun`, never saw it), or the run
   *  row is gone. Release them back open with the ruling text kept, exactly as
   *  an in-process failure would. */
  releaseOrphanedProcessing(now: string): number {
    const result = this.db.update(auditFindings)
      .set({ status: "open", updatedAt: now })
      .where(and(
        eq(auditFindings.status, "processing"),
        sql`(${auditFindings.rulingRunId} IS NULL OR ${auditFindings.rulingRunId} NOT IN (SELECT id FROM pipeline_runs WHERE status IN ('queued', 'running')))`,
      ))
      .run();
    return result.changes;
  }
}
