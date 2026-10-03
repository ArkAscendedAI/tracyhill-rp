import type { ChatMessage } from "@tracyhill-rp/contracts";

// The live transcript (windowing): the session detail query carries only the
// newest window; older windows the reader loaded with "Load older" live in a local buffer
// so the streaming-completion invalidations (which refetch ONLY the newest window) never
// drop them. Older rows are filtered against the current window start, and by id, so a
// post-mutation window shift can't double-render a message.
export function mergeTranscript(older: readonly ChatMessage[], window: readonly ChatMessage[]): ChatMessage[] {
  if (!older.length) return window as ChatMessage[];
  const windowStart = window[0]?.sortOrder ?? Number.POSITIVE_INFINITY;
  const windowIds = new Set(window.map((m) => m.id));
  const kept = older.filter((m) => m.sortOrder < windowStart && !windowIds.has(m.id));
  return kept.length ? [...kept, ...window] : window as ChatMessage[];
}

/**
 * What the older buffer becomes when a new newest window replaces the previous one.
 * The default detail read is the newest 200 rows BY COUNT, so
 * every completed turn (a user row and a reply) starts the next window two rows later. The
 * rows that slide out of the window were in neither buffer, and Load older pages only from
 * the oldest loaded row, so the transcript silently lost two rows per turn and nothing ever
 * fetched them back. While the reader holds older pages, or while the first Load older is in
 * flight (its cursor is the previous window's start, so its page ends where the slid rows
 * begin), the previous window's rows below the new window's start move into the older
 * buffer, which keeps it contiguous with the window. They are the rows the reader was looking at, carried as the same objects (message
 * identity is immutable through paging), and each replaces any stale copy the buffer held at
 * the same slot, left there when an earlier truncate made the window reach back over it.
 * A truncate or delete moves the window start back, so it carries nothing; without older
 * pages the plain newest window stays the transcript.
 */
export function carryWindowIntoOlder(
  older: ChatMessage[],
  previousWindow: readonly ChatMessage[],
  nextWindow: readonly ChatMessage[],
  loadingOlder = false,
): ChatMessage[] {
  if ((!older.length && !loadingOlder) || !previousWindow.length || !nextWindow.length) return older;
  const nextStart = nextWindow[0]!.sortOrder;
  const nextIds = new Set(nextWindow.map((m) => m.id));
  const slid = previousWindow.filter((m) => m.sortOrder < nextStart && !nextIds.has(m.id));
  if (!slid.length) return older;
  const slidOrders = new Set(slid.map((m) => m.sortOrder));
  const slidIds = new Set(slid.map((m) => m.id));
  const kept = older.filter((m) => !slidOrders.has(m.sortOrder) && !slidIds.has(m.id));
  return [...kept, ...slid].sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * The Load older answer the transcript can still use. `answer` is the hasOlder of the
 * last Load older fetch, which describes the rows above the older buffer. It holds only while the buffer shows rows
 * above the newest window (`transcript` is `mergeTranscript(older, window)`). Once it shows none (every older row
 * deleted, or a truncate brought the window back over it) the transcript is the newest window alone: later turns
 * slide rows out of that window with no buffer to carry them, and the kept "nothing older" hid Load older while the
 * window's own hasOlder was true. Returns null then (no answer: the window's hasOlder decides), and the caller stores
 * it, so the stale answer cannot come back when rows reach the buffer again. A Load older in flight keeps the answer
 * until its own replaces it.
 */
export function heldOlderAnswer(
  answer: boolean | null,
  transcript: readonly ChatMessage[],
  window: readonly ChatMessage[],
  loadingOlder: boolean,
): boolean | null {
  if (answer === null || loadingOlder) return answer;
  return transcript.length > window.length ? answer : null;
}

/** Rows a newer window skipped over, as exclusive sortOrder bounds: every row with `after < sortOrder < before`. */
export type WindowGap = { after: number; before: number };

/** The gap fill's page size (the session detail's after-cursor read). */
export const GAP_PAGE_LIMIT = 500;
/** The muted row the transcript shows at a gap while it is being filled (Android copies the text). */
export const GAP_LOADING_TEXT = "Loading the messages in between…";
/** The chat's error line when a gap could not be filled and the older pages were dropped (Android copies it). */
export const GAP_FILL_FAILED_TEXT = "Some earlier messages could not be loaded, so the chat now shows the newest ones. Load older brings the rest back.";

/**
 * The rows a new newest window skipped. The default detail read is the newest 200 rows by
 * count, so when more than about 100 turns were added elsewhere (a focus refetch in a tab left open), the next window
 * starts past the previous window's end. The rows between were in neither buffer: the transcript showed a silent hole,
 * and Resend on the first row after it truncated after the buffer's last row, deleting the hidden rows on the server.
 * It matters only while older pages are held (or the first Load older is in flight, whose page ends where the previous
 * window began); without them the plain newest window is the transcript. Overlapping or exactly adjacent windows are
 * no gap. Rows deleted on the server leave sortOrder holes, which is normal: the fill keeps whatever exists between.
 */
export function findWindowGap(
  older: readonly ChatMessage[],
  previousWindow: readonly ChatMessage[],
  nextWindow: readonly ChatMessage[],
  loadingOlder: boolean,
): WindowGap | null {
  if ((!older.length && !loadingOlder) || !previousWindow.length || !nextWindow.length) return null;
  const after = previousWindow[previousWindow.length - 1]!.sortOrder;
  const before = nextWindow[0]!.sortOrder;
  return before > after + 1 ? { after, before } : null;
}

export type GapPage = { messages: readonly ChatMessage[]; pagination: { hasNewer: boolean } };

/**
 * Read a gap's rows: after-cursor pages from `gap.after`, keeping `after < sortOrder < before`, until a page is empty,
 * has nothing newer, or reaches `before - 1`. A page that does not advance throws, as `refreshMessageRange` does, and
 * the caller falls back to the newest window.
 */
export async function collectGapRows(
  gap: WindowGap,
  readPage: (cursor: { after: number; limit: number }) => Promise<GapPage>,
): Promise<ChatMessage[]> {
  const rows: ChatMessage[] = [];
  let after = gap.after;
  for (;;) {
    const page = await readPage({ after, limit: GAP_PAGE_LIMIT });
    const last = page.messages[page.messages.length - 1]?.sortOrder;
    rows.push(...page.messages.filter((message) => message.sortOrder > gap.after && message.sortOrder < gap.before));
    if (last == null || !page.pagination.hasNewer || last >= gap.before - 1) return rows;
    if (last <= after) throw new Error("Loading the messages in between did not advance");
    after = last;
  }
}

/**
 * The older buffer once a gap is known: the union of the older pages, the whole previous window (every row of it lies
 * below the gap's `before`, so all of it is carried, as the same objects) and the fetched gap rows, in sortOrder,
 * de-duplicated by id and by sortOrder with the newest copy winning (fetched over the previous window over the older
 * pages). The component carries the previous window when the gap is found (`fetched` empty) and merges the fetched
 * rows when the fill lands.
 */
export function mergeWindowGap(
  older: readonly ChatMessage[],
  previousWindow: readonly ChatMessage[],
  fetched: readonly ChatMessage[],
): ChatMessage[] {
  const bySlot = new Map<number, ChatMessage>();
  const slotOfId = new Map<string, number>();
  for (const message of [...older, ...previousWindow, ...fetched]) {
    const earlierSlot = slotOfId.get(message.id);
    if (earlierSlot !== undefined) bySlot.delete(earlierSlot);
    const displaced = bySlot.get(message.sortOrder);
    if (displaced) slotOfId.delete(displaced.id);
    bySlot.set(message.sortOrder, message);
    slotOfId.set(message.id, message.sortOrder);
  }
  return [...bySlot.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Whether this window change carries the first row of a previous window whose own `hasOlder` was false into the
 * older buffer. Its rows begin the session, so nothing lies above the buffer and the caller records the held Load
 * older answer as false. Without it, a truncate that brought the window back over the buffer dropped the answer,
 * and a later slide that carried rows 0 and 1 offered Load older at row 0. The carry moves the previous window's rows
 * below the next window's start (all of them across a gap), so its first row goes whenever any row does.
 */
export function carryReachesSessionStart(
  older: readonly ChatMessage[],
  previousWindow: readonly ChatMessage[],
  previousHasOlder: boolean,
  nextWindow: readonly ChatMessage[],
  loadingOlder: boolean,
): boolean {
  if (previousHasOlder || (!older.length && !loadingOlder)) return false;
  const first = previousWindow[0];
  const nextStart = nextWindow[0]?.sortOrder;
  if (!first || nextStart == null) return false;
  return first.sortOrder < nextStart && !nextWindow.some((message) => message.id === first.id);
}

/**
 * The gaps still open after a new newest window arrives; the caller restarts the fill with them, so a newer detail
 * read always supersedes an older fill. A gap the new window starts inside now ends where the window starts; a gap the
 * window starts at or before is closed (a truncate or delete moved the window back over it); a new gap joins the list.
 */
export function gapsAfterWindowChange(
  open: readonly WindowGap[],
  gap: WindowGap | null,
  nextWindow: readonly ChatMessage[],
): WindowGap[] {
  const start = nextWindow[0]?.sortOrder;
  const kept = start == null ? [] : open.flatMap((pending) => (start <= pending.after + 1 ? [] : [{ after: pending.after, before: Math.min(pending.before, start) }]));
  return gap ? [...kept, gap] : kept;
}

/**
 * Where the transcript shows `GAP_LOADING_TEXT`: before the first row past each open gap's start, when a shown row at
 * or below that start precedes it. Returns ascending transcript indexes.
 */
export function gapMarkerIndexes(transcript: readonly Pick<ChatMessage, "sortOrder">[], gaps: readonly WindowGap[]): number[] {
  const indexes = new Set<number>();
  for (const gap of gaps) {
    const index = transcript.findIndex((message) => message.sortOrder > gap.after);
    if (index > 0) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}

/**
 * The live transcript's Load older button. `remaining` is the session's row count less the rows the transcript holds,
 * so while a gap fill runs it counts the gap's rows too, which Load older would not bring: the count hides until the
 * fill lands (Android mirrors it).
 */
export function loadOlderLabel(loading: boolean, remaining: number, gapFillPending: boolean): string {
  if (loading) return "Loading older...";
  return `Load older${remaining > 0 && !gapFillPending ? ` (${remaining.toLocaleString()} more)` : ""}`;
}
