import type { ChatMessage } from "@tracyhill-rp/contracts";

import { ApiError } from "../../shared/api/client";
import { getSessionDetail } from "./chatApi";

/**
 * How far a failed Resend or scene auto-regen got in removing the turn it replays (the truncate after the turn's
 * predecessor, or the delete of a first row): "done" once that call answered; "refused" when the server answered it
 * with a 4xx, which it does before cutting (not found, the chat changed, a bad request, signed out); "unknown"
 * otherwise. A 5xx or a dropped connection proves nothing, because the cut commits before the reply is built.
 */
export type ReplayRemoval = "done" | "refused" | "unknown";

export function removalAfterFailure(removed: boolean, error: unknown): ReplayRemoval {
  if (removed) return "done";
  return error instanceof ApiError && error.status >= 400 && error.status < 500 ? "refused" : "unknown";
}

/**
 * Whether a failed Resend or scene auto-regen hands the replayed text back to the composer: only when the original
 * turn is gone and the replay was not saved. The text used to go back after any
 * failure, a removal that never ran included, and the composer then held a copy of a turn still in the transcript.
 * - After the removal: back unless the replay was saved.
 * - A refused removal removed nothing: never back, and nothing is read.
 * - An unanswered removal: the stream never started, so back unless the original row is still there. A check that
 *   cannot be made gives the text back, since losing it is the failure the restore exists to prevent.
 */
export async function replayTextLost(check: {
  removal: ReplayRemoval;
  originalStillThere: () => Promise<boolean | null>;
  replayPersisted: () => Promise<boolean>;
}): Promise<boolean> {
  if (check.removal === "refused") return false;
  if (check.removal === "unknown") return (await check.originalStillThere()) !== true;
  return !(await check.replayPersisted());
}

/** Whether the session still holds the row, from a read of its slot; null when the read failed. */
export async function rowStillThere(sessionId: string, row: Pick<ChatMessage, "id" | "sortOrder">): Promise<boolean | null> {
  try {
    const detail = await getSessionDetail(sessionId, { after: row.sortOrder - 1, limit: 5 });
    return detail.messages.some((message) => message.id === row.id);
  } catch {
    return null;
  }
}
