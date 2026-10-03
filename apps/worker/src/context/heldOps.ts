// Why a worker held (did not apply) a model-proposed op against an existing
// entry. The rolling diff used to report every held op as
// "source entries changed or were outside this campaign's input", whether the
// target was missing, a constant, a thread, disabled, or genuinely edited during
// the run. One vocabulary for every worker: the
// names are part of the events' details and are what an owner filters on.
export const HELD_OP_REASONS = [
  "not-found",       // the entry id does not exist (hallucinated or deleted)
  "other-campaign",  // the entry belongs to another campaign
  "disabled",        // the entry is disabled
  "constant",        // constants (the Thread Index) are never worker targets
  "thread",          // `threads` entries are owned by the thread tracker
  "source-changed",  // the entry changed after the run read it: newer canon wins
  "protected-tag",   // a DISABLE of a tag this worker may not disable
  "archive-trigger", // a DISABLE or merge-away of a compressed trigger
] as const;
export type HeldOpReason = (typeof HELD_OP_REASONS)[number];

export interface HeldOp {
  entryId: string;
  op: string;
  reason: HeldOpReason;
}

const PHRASE: Record<HeldOpReason, string> = {
  "not-found": "target not found",
  "other-campaign": "target in another campaign",
  "disabled": "target disabled",
  "constant": "target is a constant entry",
  "thread": "target is a tracker-owned thread",
  "source-changed": "target changed during the run",
  "protected-tag": "DISABLE of a protected tag",
  "archive-trigger": "DISABLE of an archive trigger",
};

/** Counts per reason, in HELD_OP_REASONS order (stable for tests and events). */
export function countHeldByReason(held: readonly HeldOp[]): Partial<Record<HeldOpReason, number>> {
  const out: Partial<Record<HeldOpReason, number>> = {};
  for (const reason of HELD_OP_REASONS) {
    const n = held.filter((h) => h.reason === reason).length;
    if (n > 0) out[reason] = n;
  }
  return out;
}

/** "2 target changed during the run, 1 target is a tracker-owned thread". */
export function describeHeldOps(held: readonly HeldOp[]): string {
  return Object.entries(countHeldByReason(held)).map(([reason, n]) => `${n} ${PHRASE[reason as HeldOpReason]}`).join(", ");
}
