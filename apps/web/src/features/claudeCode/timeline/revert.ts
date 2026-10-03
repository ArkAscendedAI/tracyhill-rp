// Whether an Edit/Write chip offers ↶ Revert.
// The agent service rewinds files only through a live query: its
// `/rewind` answers "no active query with checkpointing" once the query has
// ended, which since the 2026-09-29 owed-turns change is a few seconds after
// each turn. And the CLI rewinds only to a checkpoint it recorded, which is
// the uuid of a user prompt. Today only the archive transcript (`GET
// …/messages`) carries that uuid; replayed `user` events carry none, and a
// `tool_use` event's userMessageId is a tool-result uuid the CLI refuses, so
// the fold does not use it (turns.ts). Revert is offered exactly where both
// hold; everywhere else the chip says why instead of showing a button that
// always fails.

export type RevertOffer =
  | { kind: "offer"; userMessageId: string }
  | { kind: "unavailable"; reason: string };

export const REVERT_NO_CHECKPOINT = "Revert is unavailable: the agent service does not report this turn's file checkpoint.";
export const REVERT_NOT_LIVE = "Revert works only while the session is live.";

/**
 * `live` is the panel's own "live" state (connected to the session's running
 * query, `ClaudeCodeStreamState.streaming`). Null means no revert surface at
 * all: there is no session to rewind (a new session's first turn, or a
 * subagent's nested chip, which never carried one).
 */
export function revertOffer({ sessionId, userMessageId, live }: { sessionId?: string | null; userMessageId?: string; live: boolean }): RevertOffer | null {
  if (!sessionId) return null;
  if (!userMessageId) return { kind: "unavailable", reason: REVERT_NO_CHECKPOINT };
  if (!live) return { kind: "unavailable", reason: REVERT_NOT_LIVE };
  return { kind: "offer", userMessageId };
}
