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

// Process-level events with no owning user (worker DEAD/recovered, catalog
// invariant violations, bridge-not-configured, boot attestation) are recorded
// under this sentinel. They are surfaced to every ADMIN user's feed + badge
// (list/count/ack take `includeSystem`). Before 2026-09-02 nothing
// read them at all, so the worker-death watchdog never reached a human.
export const SYSTEM_EVENT_USER = "__system__";

export type SystemEventSource =
  | "antagonist_intent"
  | "auth"
  | "context_assembly"
  | "embed_query"
  | "embed_index"
  | "embed_coverage"
  | "hyde"
  | "researcher"
  | "scene_validator"
  | "rolling_diff"
  | "thread_tracker"
  | "sysprompt_audit"
  | "repetition_detection"
  | "lorebook_consolidation"
  | "lorebook_archival"
  | "drive_update"
  | "world_tick"
  // Phase-7 producers (threats, consequences, standings). A degradation here is
  // invisible in play — the world just quietly stops having consequences — so it
  // has to surface on its own source rather than hiding under "pipeline".
  | "world_state"
  // Entry-size watchdog at the lorebook write chokepoint: an entry crossing the
  // delivery-size guidance (or the provider embed cap) must surface when it
  // happens, not when the embed layer starts failing on it.
  | "lorebook_size"
  | "campaign_review"
  | "campaign_audit"
  | "pipeline"
  | "wizard"
  | "image_generation"
  // A stored per-user provider/endpoint key that no longer decrypts (server
  // secret rotated) — the user must re-enter it; chat sends fall back to the
  // server default or fail with "not configured" until then.
  | "provider_keys"
  // Fast mode was requested (Anthropic direct ⚡ or the OpenAI fast dial) but
  // the provider did not confirm it ran fast — the turn is recorded standard
  // and the user is told why the badge is absent (2026-09-09).
  | "fast_mode";

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
    else if (input.severity === "info") logger.info(logPayload, `[system-event] ${input.message}`);
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

/**
 * Delivery class (2026-09-27): informational alerts take their own delivery
 * path so they do not cause alert fatigue for the actual failures. Severity
 * carries the meaning: warn/error are ALERTS (something failed or degraded —
 * the rail badge counts them); info is a NOTICE (the system handled it: a hold
 * that kept newer canon, a recovered run, findings waiting in their own chip) —
 * readable in the same panel, never counted on the badge.
 */
export type SystemEventClass = "alert" | "notice";
export const ALERT_SEVERITIES = ["warn", "error"] as const;

function classPredicate(eventClass?: SystemEventClass) {
  if (!eventClass) return undefined;
  return eventClass === "alert"
    ? inArray(systemEvents.severity, [...ALERT_SEVERITIES])
    : eq(systemEvents.severity, "info");
}

export interface SystemEventScope {
  /** Admin callers: also see (and ack) the `__system__` process-level rows.
   *  An admin ack of a system row acks it for every admin — it is one shared
   *  row, not a per-admin copy. */
  includeSystem?: boolean;
}

function ownerPredicate(userId: string, scope: SystemEventScope) {
  return scope.includeSystem && userId !== SYSTEM_EVENT_USER
    ? inArray(systemEvents.userId, [userId, SYSTEM_EVENT_USER])
    : eq(systemEvents.userId, userId);
}

export function listSystemEvents(userId: string, opts: { unackedOnly?: boolean; limit?: number; eventClass?: SystemEventClass } & SystemEventScope = {}) {
  if (!db) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const owner = ownerPredicate(userId, opts);
  const where = and(owner, opts.unackedOnly ? isNull(systemEvents.acknowledgedAt) : undefined, classPredicate(opts.eventClass));
  return db.select().from(systemEvents).where(where).orderBy(desc(systemEvents.createdAt)).limit(limit).all();
}

export function countUnackedSystemEvents(userId: string, scope: SystemEventScope = {}, eventClass?: SystemEventClass): number {
  if (!db) return 0;
  const row = db.select({ count: sql<number>`count(*)` })
    .from(systemEvents)
    .where(and(ownerPredicate(userId, scope), isNull(systemEvents.acknowledgedAt), classPredicate(eventClass)))
    .get();
  return row?.count ?? 0;
}

/** True when an identical event (same user, source, campaign and message) was
 *  recorded at or after `sinceIso` — lets a periodic check stay quiet across
 *  process restarts instead of relying on in-memory dedupe alone. */
export function hasRecentSystemEvent(input: { userId: string; source: SystemEventSource; campaignId: string | null; message: string; sinceIso: string }): boolean {
  if (!db) return false;
  try {
    const row = db.select({ id: systemEvents.id }).from(systemEvents).where(and(
      eq(systemEvents.userId, input.userId),
      eq(systemEvents.source, input.source),
      input.campaignId === null ? isNull(systemEvents.campaignId) : eq(systemEvents.campaignId, input.campaignId),
      eq(systemEvents.message, input.message.slice(0, 500)),
      sql`${systemEvents.createdAt} >= ${input.sinceIso}`,
    )).limit(1).get();
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Acknowledge specific events, or ALL unacked events when ids is omitted —
 *  optionally only one delivery class ("Acknowledge alerts" / "Mark notices read"). */
export function ackSystemEvents(userId: string, ids?: string[], scope: SystemEventScope = {}, eventClass?: SystemEventClass): number {
  if (!db) return 0;
  const now = new Date().toISOString();
  // An EXPLICIT empty selection acks nothing (it used to route into the
  // ack-all branch); omitted ids = ack all unacked. The ids branch only
  // stamps rows that are still unacked so re-acks don't overwrite timestamps.
  if (ids && ids.length === 0) return 0;
  const owner = ownerPredicate(userId, scope);
  const where = ids
    ? and(owner, inArray(systemEvents.id, ids), isNull(systemEvents.acknowledgedAt), classPredicate(eventClass))
    : and(owner, isNull(systemEvents.acknowledgedAt), classPredicate(eventClass));
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
