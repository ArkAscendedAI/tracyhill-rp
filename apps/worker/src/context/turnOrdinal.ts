import type { MessageRepository, SettledAssistantSource } from "../../../api/src/domain/chat/messageRepository";

// The "current turn" ordinal the workers stamp (tracker `asOfTurn`, drive-sheet
// `sinceTurn`/`lastUpdatedTurn`, the stale-review `current_turn`, archival's
// staleness gate) and the context engine reads. One formula, matching
// `contextEngine.ts` (`Math.floor(input.history.length / 2) + 1`). Three copies
// used to disagree: two used `floor(n/2)+1`, two used
// `max(1, ceil(n/2))`, which is one lower for an even message count, so the
// tracker's freshness stamp and the engine's turn were off by one for the same
// state.
export function sessionTurnNumber(messageCount: number): number {
  return Math.floor(Math.max(0, messageCount) / 2) + 1;
}

/**
 * The engine's turn number as of the message that settled this job. Use this,
 * not `sessionTurnNumber(readSession().length)`, for any
 * ordinal a worker stamps or compares with the engine's.
 *
 * The formula is shared; the POPULATION was not. The engine counts every active
 * non-cold-start row of the session (`chatService.ts` builds `history` from
 * `listForSession` plus the new user message, cold-start filtered), while a
 * worker's settled read (`listForPipeline`) keeps only receipted user/assistant
 * pairs. Image rows, stopped or errored replies, user turns with no kept reply,
 * and settled pairs later edited or swiped never carry a valid receipt, so the
 * worker's count fell behind the engine's by half of those rows, for good. The
 * tracker stamped that lower number as `asOfTurn`, the engine subtracted it from
 * its own turn, and past 30 the always-on Thread Index carried a false
 * staleness warning on every turn; stale-review and archival ages came out low.
 *
 * Population here = the engine's: active (variant-active) rows, `cold-start`
 * excluded, read with `listForSession`. With a settled source the count stops at
 * the settling user message (the turn on which the engine enqueued this job),
 * so a run that starts after more play still stamps the turn its input reaches.
 * Without one (manual runs) it counts the whole session. Counting reads no text
 * into canon: nothing here enters a prompt or the transcript manifest.
 *
 * `assertCurrent()` has already required the settling row to exist on every
 * automatic run; should it be gone anyway, the count stops at the kept reply.
 *
 * `throughSortOrder` overrides the bound: a run that reads its span in passes
 * stamps an intermediate pass with the turn of the user message that
 * followed the pass's last reply, the turn the engine was on when that reply
 * was settled.
 */
export function workerTurnNumber(
  messages: Pick<MessageRepository, "listForSession">,
  userId: string,
  sessionId: string,
  source?: SettledAssistantSource | null,
  throughSortOrder?: number,
): number {
  const rows = messages.listForSession(userId, sessionId).filter((row) => row.role !== "cold-start");
  if (throughSortOrder !== undefined) return sessionTurnNumber(rows.filter((row) => row.sortOrder <= throughSortOrder).length);
  if (!source || source.sessionId !== sessionId) return sessionTurnNumber(rows.length);
  const bound = rows.find((row) => row.id === source.settledByMessageId)?.sortOrder ?? source.sortOrder;
  return sessionTurnNumber(rows.filter((row) => row.sortOrder <= bound).length);
}
