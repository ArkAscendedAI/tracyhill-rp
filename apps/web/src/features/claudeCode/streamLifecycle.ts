// Pure decision logic for the panel SSE connection lifecycle.
// Kept free of React so the reconnect policy is
// unit-testable: the hook feeds it what it observed about a finished fetch and
// applies the returned action.
//
// Why a resolved fetch is NOT "the turn ended": the RP proxy relays the
// agent-service stream and ends its response on ANY upstream failure — a mid-
// stream socket drop, an agent-service restart, its own inactivity timeout. It
// now writes an `event: error` frame (`source:"bridge-proxy"`) first but
// deliberately emits no synthetic `done`: after a service restart the boot
// recovery writes the real `error` + `done` to the events file, and the client
// must reconnect from its cursor to fetch them. So only a terminal frame seen
// on THIS connection means the stream closed for a reason; a clean close
// without one takes the same backoff/reconnect path as a thrown fetch, ending
// in the inline "Connection lost" turn after MAX_RECONNECT_ATTEMPTS.

// `done` = turn end (live or replayed). `stream_end` = the agent service's
// "session not running" close after an idle replay (handlers/sessions.js).
const TERMINAL_EVENT_TYPES = new Set(["done", "stream_end"]);

// After this many consecutive reconnect failures, stop retrying and surface a
// terminal error rather than looping forever.
export const MAX_RECONNECT_ATTEMPTS = 6;

// Clicking the session in the sidebar re-runs the status probe and reattaches
// (ClaudeCodePage reattaches on a click of the already-active row) — the old
// "reload to reconnect" advice destroyed the composer draft.
export const CONNECTION_LOST_MESSAGE = "Connection lost — click this session in the sidebar to reconnect.";

// HTTP statuses that mean "this subscription may not continue", not "the
// transport dropped": the hook stops instead of backing off, and resumes from
// its cursor once the session list loads again (a re-login).
const ACCESS_STATUSES = new Set([401, 403, 404]);

function isTerminalEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

// Capped exponential backoff: 2s, 4s, 8s, 16s, 30s, 30s.
export function reconnectDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

type StreamCloseDecision =
  // A superseded connection (a newer connectToStream replaced it, or
  // disconnect() tore it down) must never patch the state of its replacement.
  | { action: "ignore" }
  // Our own abort on the current connection.
  | { action: "aborted" }
  // A terminal frame was seen: the events already set the right state.
  | { action: "closed" }
  // The server refused the subscription (401/403/404): stop, do not retry.
  | { action: "access-denied"; status: number }
  | { action: "reconnect"; attempt: number; delayMs: number }
  | { action: "give-up"; message: string };

export function decideStreamClose(input: {
  // abortRef.current === this connection's controller
  isCurrent: boolean;
  // the fetch ended with an AbortError
  aborted: boolean;
  // a `done` / `stream_end` frame arrived on this connection (and no persisted
  // event followed it)
  sawTerminal: boolean;
  // consecutive failed attempts so far (reset to 0 whenever data flows)
  attempts: number;
  // the HTTP status the fetch rejected with, when it was an ApiError
  status?: number;
}): StreamCloseDecision {
  if (!input.isCurrent) return { action: "ignore" };
  if (input.aborted) return { action: "aborted" };
  if (input.sawTerminal) return { action: "closed" };
  if (input.status !== undefined && ACCESS_STATUSES.has(input.status)) return { action: "access-denied", status: input.status };
  const attempt = input.attempts + 1;
  if (attempt > MAX_RECONNECT_ATTEMPTS) return { action: "give-up", message: CONNECTION_LOST_MESSAGE };
  return { action: "reconnect", attempt, delayMs: reconnectDelayMs(attempt) };
}

// Tracks whether the connection's most recent persisted frame was terminal.
// A persisted (idx-bearing) event AFTER a `done` means the query continued on
// the same connection (queued follow-up), so the flag drops again; transport-
// only frames (keepalive, the proxy's error frame) carry no idx and leave it.
export function nextTerminalFlag(current: boolean, event: { type: string; _idx?: number }): boolean {
  if (isTerminalEvent(event.type)) return true;
  if (event._idx !== undefined) return false;
  return current;
}
