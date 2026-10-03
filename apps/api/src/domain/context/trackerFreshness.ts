import { recordSystemEvent } from "../system/systemEvents";

import type { ScoredCandidate } from "./budgetPruner";

// Constant-entry freshness guard.
// The tracker's CONSTANT Thread Index is always in context and is written to be
// trusted; when the tracker fails repeatedly the index keeps asserting a stale
// world as authoritative truth (the "forgotten lunch" failure: the
// index was 3 days / ~178 turns behind and the model obeyed it, inventing a
// third stood-up lunch complete with arithmetic on the stale tally). A stale
// constant that DECLARES its staleness degrades gracefully; one that doesn't
// is an authoritative lie.
//
// The index self-stamps its rebuild turn ("As of … (turn N)" — written by the
// tracker worker on every successful run). We parse that stamp against the
// current turn; past the threshold we append an explicit hedge INTO the
// injected content so the model calibrates trust, add a context-preview note,
// and raise a warn system_event (re-raised every +50 turns of additional lag,
// not per turn).

export const TRACKER_STALE_TURNS = 30;
const REALERT_EVERY_TURNS = 50;
// A rewrite within this window means the tracker is demonstrably alive — the
// lag is cadence, not failure. Sized well above the longest healthy batch gap.
const RECENT_REBUILD_MS = 6 * 60 * 60 * 1000;
const reportedLag = new Map<string, number>(); // campaignId -> lag at last event

export function applyTrackerFreshnessHedge(
  candidates: ScoredCandidate[],
  turnNumber: number,
  ids: { userId: string; campaignId: string | null | undefined; recordEvents?: boolean },
): string | null {
  // A dry-run preview passes recordEvents:false: the hedge and the note are
  // computed the same, but no system_events row is written and the per-campaign
  // re-alert throttle is left as the live turns set it.
  const recordEvents = ids.recordEvents !== false;
  const idx = candidates.find(
    (c) => c.source === "constant" && c.entry.tag === "threads" && c.entry.isConstant,
  );
  if (!idx) return null;

  // Machine-readable stamp first (comment JSON `asOfTurn`, written by the
  // tracker worker since 2026-08-11) — manual curation or a header-format tweak
  // can never silently break freshness detection again. The prose "(turn N)"
  // regex remains as the fallback for indexes written before the stamp existed.
  let asOfTurn: number | null = null;
  if (idx.entry.comment) {
    try {
      const parsed = JSON.parse(idx.entry.comment) as { asOfTurn?: unknown };
      if (typeof parsed.asOfTurn === "number" && Number.isFinite(parsed.asOfTurn) && parsed.asOfTurn > 0) {
        asOfTurn = parsed.asOfTurn;
      }
    } catch { /* comment is not JSON — fall through to the prose stamp */ }
  }
  if (asOfTurn === null) {
    const stamp = idx.entry.content.match(/\(turn\s*~?(\d+)/i);
    if (!stamp) return null; // unstamped index — nothing to compare against (fail-safe: no hedge)
    const parsedTurn = Number(stamp[1]);
    if (!Number.isFinite(parsedTurn) || parsedTurn <= 0) return null;
    asOfTurn = parsedTurn;
  }

  const lag = turnNumber - asOfTurn;
  if (lag <= TRACKER_STALE_TURNS) {
    if (ids.campaignId && recordEvents) reportedLag.delete(ids.campaignId); // recovered — re-alert on relapse
    return null;
  }

  const hedge =
    `\n\n⚠ INDEX STALENESS WARNING: this Thread Index was last rebuilt at turn ~${asOfTurn}; ` +
    `the current turn is ~${turnNumber} (${lag} turns behind). Developments from the last ` +
    `${lag} turns are NOT reflected above. Wherever this index disagrees with the transcript ` +
    `or with retrieved event entries about that window, the transcript wins — do not assert ` +
    `index-derived state (owed meetings, pending statuses, tallies, deadlines) for recent ` +
    `events without transcript support.`;
  // Turn-local candidate object — mutating the copy never touches the DB row.
  idx.entry = { ...idx.entry, content: idx.entry.content + hedge };

  // Turn-lag alone cannot distinguish a BROKEN tracker from a long play session
  // that simply outran the rebuild cadence (2026-08-11: 31 turns in one
  // afternoon fired "the tracker is likely failing" while every run was green).
  // Wall-clock recency of the index row is the discriminator: a recent rewrite
  // means the tracker is healthy and play is just fast.
  const updatedTs = Date.parse((idx.entry as { updatedAt?: string }).updatedAt ?? "");
  const rebuiltRecently = Number.isFinite(updatedTs) && Date.now() - updatedTs < RECENT_REBUILD_MS;

  if (ids.campaignId && recordEvents) {
    const prev = reportedLag.get(ids.campaignId);
    if (prev === undefined || lag >= prev + REALERT_EVERY_TURNS) {
      reportedLag.set(ids.campaignId, lag);
      recordSystemEvent({
        // Play outpacing a healthy tracker is a notice; a tracker that has not
        // rewritten recently may be failing — that one stays an alert.
        userId: ids.userId, source: "thread_tracker", severity: rebuiltRecently ? "info" : "warn", campaignId: ids.campaignId,
        message: rebuiltRecently
          ? `thread tracker index is ${lag} turns behind the transcript (last rebuilt ~turn ${asOfTurn}, now ~turn ${turnNumber}) — staleness hedge injected; the index WAS rewritten recently, so this is play outpacing the rebuild cadence, not a tracker failure. The next rolling-diff batch refreshes it.`
          : `thread tracker index is ${lag} turns stale (last rebuilt ~turn ${asOfTurn}, now ~turn ${turnNumber}) and has not been rewritten recently — staleness hedge injected; the tracker may be failing, check its pipeline runs`,
        details: { asOfTurn, turnNumber, lag, rebuiltRecently },
      });
    }
  }

  return rebuiltRecently
    ? `Thread Index is ${lag} turns behind (rebuilt ~turn ${asOfTurn}, recently) — hedge injected; play is outpacing the rebuild cadence`
    : `Thread Index is ${lag} turns stale (rebuilt ~turn ${asOfTurn}) — staleness hedge injected; check tracker health`;
}
