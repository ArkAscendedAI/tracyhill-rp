import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { systemEvents } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";

import { createId } from "../../lib/ids";

import type { DatabaseClient } from "@tracyhill-rp/db";

type Db = DatabaseClient["db"];

// Module-singleton recorder (initialized once in createApp) rather than DI:
// failure recording must be reachable from EVERY passive subsystem — embedding
// providers, HyDE, researcher, scene validator, and all seven background
// workers — without threading a service through a dozen constructors. The
// hard rule (2026-06-10): passive systems never fail silently.

const logger = createLogger("system-events");

export type SystemEventSource =
  | "embed_query"
  | "embed_index"
  | "hyde"
  | "researcher"
  | "scene_validator"
  | "context_assembly"
  | "rolling_diff"
  | "thread_tracker"
  | "sysprompt_audit"
  | "repetition_detection"
  | "lorebook_consolidation"
  | "lorebook_archival"
  | "campaign_review"
  | "pipeline"
  | "wizard"
  | "image_generation";

export interface SystemEventInput {
  userId: string;
  source: SystemEventSource;
  message: string;
  severity?: "info" | "warn" | "error";
  campaignId?: string | null;
  sessionId?: string | null;
  details?: unknown;
}

let db: Db | null = null;

// Throttle identical (userId+source+message) events: a 30-minute provider
// outage should produce a handful of rows, not one per turn.
const THROTTLE_MS = 5 * 60 * 1000;
const recentEvents = new Map<string, number>();

export function initSystemEvents(client: Db): void {
  db = client;
}

/** For tests — reset the singleton + throttle between cases. */
export function resetSystemEventsForTest(client: Db | null): void {
  db = client;
  recentEvents.clear();
}

/**
 * Record a passive-subsystem failure. NEVER throws — the recorder must not be
 * able to turn a degraded turn into a failed one. Always logs (so the event is
 * visible in pino output even if persistence is unavailable).
 */
export function recordSystemEvent(input: SystemEventInput): void {
  try {
    const logPayload = { source: input.source, userId: input.userId, campaignId: input.campaignId, sessionId: input.sessionId, details: input.details };
    if (input.severity === "error") logger.error(logPayload, `[system-event] ${input.message}`);
    else logger.warn(logPayload, `[system-event] ${input.message}`);
    if (!db) return;

    const throttleKey = `${input.userId}|${input.source}|${input.message}`;
    const now = Date.now();
    const last = recentEvents.get(throttleKey);
    if (last != null && now - last < THROTTLE_MS) return;
    if (recentEvents.size > 1000) {
      for (const [key, ts] of recentEvents) {
        if (now - ts > THROTTLE_MS) recentEvents.delete(key);
      }
    }

    db.insert(systemEvents).values({
      id: createId(),
      userId: input.userId,
      source: input.source,
      severity: input.severity ?? "warn",
      message: input.message.slice(0, 500),
      campaignId: input.campaignId ?? null,
      sessionId: input.sessionId ?? null,
      detailsJson: input.details !== undefined ? safeStringify(input.details) : null,
      acknowledgedAt: null,
      createdAt: new Date().toISOString(),
    }).run();
    // Mark the throttle only AFTER a successful insert — marking first meant a
    // failed insert suppressed identical events for the whole window.
    recentEvents.set(throttleKey, now);
  } catch (err) {
    // Last resort: the recorder itself must never propagate.
    logger.error({ err }, "failed to record system event");
  }
}

export function listSystemEvents(userId: string, opts: { unackedOnly?: boolean; limit?: number } = {}) {
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.unackedOnly
    ? and(eq(systemEvents.userId, userId), isNull(systemEvents.acknowledgedAt))
    : eq(systemEvents.userId, userId);
  return db.select().from(systemEvents).where(where).orderBy(desc(systemEvents.createdAt)).limit(limit).all();
}

export function countUnackedSystemEvents(userId: string): number {
  if (!db) return 0;
  const row = db.select({ count: sql<number>`count(*)` })
    .from(systemEvents)
    .where(and(eq(systemEvents.userId, userId), isNull(systemEvents.acknowledgedAt)))
    .get();
  return row?.count ?? 0;
}

/** Acknowledge specific events, or ALL unacked events when ids is omitted. */
export function ackSystemEvents(userId: string, ids?: string[]): number {
  if (!db) return 0;
  const now = new Date().toISOString();
  // An EXPLICIT empty selection acks nothing (it used to route into the
  // ack-all branch); omitted ids = ack all unacked. The ids branch only
  // stamps rows that are still unacked so re-acks don't overwrite timestamps.
  if (ids && ids.length === 0) return 0;
  const where = ids
    ? and(eq(systemEvents.userId, userId), inArray(systemEvents.id, ids), isNull(systemEvents.acknowledgedAt))
    : and(eq(systemEvents.userId, userId), isNull(systemEvents.acknowledgedAt));
  const result = db.update(systemEvents).set({ acknowledgedAt: now }).where(where).run();
  return result.changes ?? 0;
}

/** Delete acknowledged events older than 30 days and ANY event older than 90 —
 *  the table was insert-only and grew forever in the hot SQLite file. */
export function sweepSystemEvents(): number {
  if (!db) return 0;
  const ackCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const hardCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const acked = db.delete(systemEvents)
    .where(and(sql`${systemEvents.acknowledgedAt} IS NOT NULL`, lt(systemEvents.acknowledgedAt, ackCutoff)))
    .run();
  const ancient = db.delete(systemEvents).where(lt(systemEvents.createdAt, hardCutoff)).run();
  return (acked.changes ?? 0) + (ancient.changes ?? 0);
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value)?.slice(0, 4000) ?? null;
  } catch {
    return null;
  }
}
