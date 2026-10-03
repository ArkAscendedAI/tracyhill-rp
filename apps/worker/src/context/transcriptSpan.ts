import { and, desc, eq, ne, sql } from "drizzle-orm";

import { pipelineRuns, type DatabaseClient } from "@tracyhill-rp/db";

/**
 * Transcript spans for the canon writers.
 *
 * The rolling diff read the last eight settled messages and the thread tracker
 * the last twelve (each cut to 2,000 characters), taken at RUN time, so
 * everything between two runs' windows reached no canon writer. Measured on two
 * long campaigns on 2026-09-29, consecutive completed diffs were 18–86 messages
 * apart on one (average 40.8) and 14–58 on the other
 * (average 29.9): the hole was the steady state, not only the fast nights it
 * was found on (a named NPC's on-page death, 09-19, was one of the holes).
 *
 * Now each run records the point its input reached, and the next run of the
 * same kind and session reads every settled message after it:
 *
 * - `coveredThroughSortOrder`: the last settled row the run read;
 * - `coveredReadAt`: when it read the session. A row created after that time
 *   was never seen even if its sortOrder is lower: truncating or editing and
 *   regenerating a turn deletes the tail, and new rows then reuse its slots
 *   (`createMessageAtTail` allocates MAX(sort_order)+1).
 *
 * Both are written with the canon they describe (the pass's write
 * transaction), so a run that fails or is canceled after some passes still
 * tells the next run where to continue. A session's first run, or the first
 * after legacy runs that carry no marker, reads the old fixed window.
 */

export interface CoverageMarker {
  throughSortOrder: number;
  readAt: string;
}

/** The marker a run's details carry, or null (legacy runs, runs that wrote nothing). */
export function readCoverageMarker(details: unknown): CoverageMarker | null {
  if (!details || typeof details !== "object") return null;
  const d = details as { coveredThroughSortOrder?: unknown; coveredReadAt?: unknown };
  if (!Number.isInteger(d.coveredThroughSortOrder) || typeof d.coveredReadAt !== "string" || !d.coveredReadAt) return null;
  return { throughSortOrder: d.coveredThroughSortOrder as number, readAt: d.coveredReadAt };
}

/** The most recent marker another run of `kind` wrote for this session, in any
 *  terminal state (a failed or canceled run's committed passes count). "Most
 *  recent" is by when the run ended, not the largest sortOrder: after a rewind
 *  the latest run's marker can sit below an older one's, and the older one no
 *  longer describes the transcript. */
export function latestCoverageMarker(db: DatabaseClient["db"], input: { userId: string; campaignId: string; sessionId: string; kind: string; excludeRunId: string }): (CoverageMarker & { runId: string }) | null {
  const rows = db.select({ id: pipelineRuns.id, detailsJson: pipelineRuns.detailsJson })
    .from(pipelineRuns)
    .where(and(
      eq(pipelineRuns.campaignId, input.campaignId),
      eq(pipelineRuns.userId, input.userId),
      eq(pipelineRuns.sessionId, input.sessionId),
      eq(pipelineRuns.kind, input.kind),
      ne(pipelineRuns.id, input.excludeRunId),
      sql`json_valid(${pipelineRuns.detailsJson}) AND json_extract(${pipelineRuns.detailsJson}, '$.coveredThroughSortOrder') IS NOT NULL`,
    ))
    .orderBy(desc(sql`coalesce(${pipelineRuns.completedAt}, ${pipelineRuns.updatedAt})`), desc(pipelineRuns.id))
    .limit(5)
    .all();
  for (const row of rows) {
    let details: unknown = null;
    try { details = JSON.parse(row.detailsJson ?? "null"); } catch { continue; }
    const marker = readCoverageMarker(details);
    if (marker) return { ...marker, runId: row.id };
  }
  return null;
}

export interface SpanRow {
  id: string;
  role: string;
  sortOrder: number;
  createdAt: string;
}

/** The rows a run reads: everything after the marker (by slot, or created
 *  after the marker's read), or the last `fallbackCount` rows when there is no
 *  marker. `rows` are the settled read, in transcript order. */
export function selectSpan<T extends SpanRow>(rows: readonly T[], marker: CoverageMarker | null, fallbackCount: number): { rows: T[]; mode: "span" | "window" } {
  if (!marker) return { rows: rows.slice(-fallbackCount), mode: "window" };
  return { rows: rows.filter((row) => row.sortOrder > marker.throughSortOrder || row.createdAt > marker.readAt), mode: "span" };
}

export interface PassCaps {
  /** Messages per pass. */
  maxMessages: number;
  /** Rendered characters per pass. */
  maxChars: number;
}

/** Split a span into passes, in order. A user turn and the reply that follows it
 *  stay in one pass; a pass takes whole exchanges while both caps allow, and an
 *  exchange larger than a cap forms a pass of its own (nothing is ever cut).
 *  `measure` returns a row's rendered size. */
export function planPasses<T extends { role: string }>(rows: readonly T[], caps: PassCaps, measure: (row: T) => number): T[][] {
  const exchanges: T[][] = [];
  for (const row of rows) {
    const current = exchanges[exchanges.length - 1];
    if (row.role === "user" || !current) exchanges.push([row]);
    else current.push(row);
  }
  const passes: T[][] = [];
  let pass: T[] = [];
  let chars = 0;
  for (const exchange of exchanges) {
    const size = exchange.reduce((sum, row) => sum + measure(row), 0);
    if (pass.length > 0 && (pass.length + exchange.length > caps.maxMessages || chars + size > caps.maxChars)) {
      passes.push(pass);
      pass = [];
      chars = 0;
    }
    pass.push(...exchange);
    chars += size;
  }
  if (pass.length > 0) passes.push(pass);
  return passes;
}
