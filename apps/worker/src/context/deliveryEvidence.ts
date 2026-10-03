import type { CampaignActivationEvidence } from "../../../api/src/domain/context/lorebookRepository";

/**
 * Whether an entry was ever delivered into context, and where.
 *
 * Activation state is keyed by session, and a new session starts with none, so
 * the rolling diff's stale review and archival used to read "never delivered in
 * this session" as "never delivered": in the first sweeps and archival runs of
 * a new session, events the earlier sessions delivered constantly looked
 * unused, the stale review called them never activated (the evidence its
 * DISABLE guidance keys on) and archival told its model "never". The campaign's
 * other sessions now count (`LorebookRepository.findCampaignActivationEvidence`);
 * turns are compared only within one session, since each session numbers its
 * own.
 */
export type DeliveryEvidence =
  | { kind: "this-session"; turn: number }
  | { kind: "other-session"; sessions: number }
  | { kind: "never" };

/** Archival's idle guard, shared with the stale review: a row no session ever
 *  delivered counts as unused only after it sat untouched this long (a new or
 *  freshly edited row has simply not been needed yet). */
export const NEVER_DELIVERED_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

export function deliveryEvidence(
  entryId: string,
  thisSession: ReadonlyMap<string, number | null>,
  campaign: ReadonlyMap<string, CampaignActivationEvidence>,
): DeliveryEvidence {
  const turn = thisSession.get(entryId);
  if (turn != null) return { kind: "this-session", turn };
  // The campaign query counts only sessions with a delivery turn, so when this
  // session has none for the entry, every session it counts is another one.
  const elsewhere = campaign.get(entryId);
  if (elsewhere) return { kind: "other-session", sessions: elsewhere.sessionCount };
  return { kind: "never" };
}

/** Milliseconds since the entry was last edited (created, if never edited). */
export function idleMs(entry: { updatedAt?: string | null; createdAt: string }, now = Date.now()): number {
  return now - new Date(entry.updatedAt ?? entry.createdAt).getTime();
}

/** The prompt wording for an entry delivered only in other sessions. */
export function otherSessionsLabel(sessions: number): string {
  return `not in this session (delivered in ${sessions} other session${sessions === 1 ? "" : "s"} of this campaign)`;
}
