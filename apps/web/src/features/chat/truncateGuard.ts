import { TRUNCATE_UNCONFIRMED_LIMIT } from "@tracyhill-rp/contracts";

// What a cut removes, counted as the server counts it: the visible rows from `removedFromIndex` on, one per
// slot. The client sends the count the person confirmed and the last message it has; the server refuses when it holds a
// newer message, so a page showing an old transcript reloads instead of cutting what it never loaded.

type Row = { id: string; variantActive?: boolean };

export type CutPlan = {
  // Visible messages the cut removes.
  removed: number;
  // The last visible message this client has; the server checks it against its own.
  lastId: string | undefined;
  // More than TRUNCATE_UNCONFIRMED_LIMIT go: the person confirms the count first.
  needsConfirmation: boolean;
};

const visible = (rows: readonly Row[]) => rows.filter((row) => row.variantActive !== false);

export function cutPlan(rows: readonly Row[], removedFromIndex: number): CutPlan {
  const removed = visible(rows.slice(Math.max(0, removedFromIndex))).length;
  const shown = visible(rows);
  return { removed, lastId: shown[shown.length - 1]?.id, needsConfirmation: removed > TRUNCATE_UNCONFIRMED_LIMIT };
}

/** "the message" or "the 4 messages", for the confirmations. */
export function messagesPhrase(count: number): string {
  return count === 1 ? "the message" : `the ${count} messages`;
}
