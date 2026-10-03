import type { ChatMessage, ContextPreviewEntry, ContextAssemblyDebug } from "@tracyhill-rp/contracts";

export type ComposerAttachmentInput = {
  filename: string;
  mimeType: string;
  contentMode: "text" | "base64";
  content: string;
};

/** A persisted attachment as a send input (a replayed turn re-sends its own attachments). */
export function mapStoredAttachmentToInput(attachment: ChatMessage["attachments"][number]): ComposerAttachmentInput {
  return {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    contentMode: attachment.contentMode,
    content: attachment.content,
  };
}

export type SessionStreamState = {
  sending: boolean;
  requestId: string | null;
  stopRequested: boolean;
  // True once the server reports the upstream model request has started
  // (response.started). Before that, the gap is context assembly (retrieval /
  // researcher / HyDE); after it, the gap is model ingestion. The waiting
  // indicator uses this to tell the user which phase they're in.
  responseStarted: boolean;
  pendingPrompt: string;
  pendingAttachments: ComposerAttachmentInput[];
  // sortOrder of the transcript tail the pending user turn will land AFTER:
  // the optimistic bubble is deduped against
  // persisted user messages NEWER than this, wherever they sit in the tail.
  // The old "is the LAST message my prompt" check went false the moment the
  // assistant reply refetched in, so the optimistic copy re-rendered BELOW the
  // reply for the validator's whole runtime. null = unknown (scan everything).
  pendingAfterSortOrder: number | null;
  streamingText: string;
  streamingThinking: string;
  error: string;
  contextPreview: ContextPreviewEntry[];
  contextDebug: ContextAssemblyDebug | null;
  contextBudgetTokens: number;
  // Degradation warnings from the server (e.g. "semantic retrieval failed —
  // keyword-only this turn"). Rendered in the context preview surface so
  // passive failures are never silent.
  contextNotes: string[];
  // Informational notes (feature telemetry, e.g. the comms-context pull) —
  // shown neutrally in the popover; NEVER mark the chip degraded.
  contextInfoNotes: string[];
  // True once response.completed arrived: the reply is persisted server-side
  // even though the stream stays open while the scene validator runs. The UI
  // unlocks the composer at this point instead of holding it hostage for the
  // validator's full runtime.
  completed: boolean;
  completedMessageId: string | null;
};

export function createEmptySessionStreamState(): SessionStreamState {
  return {
    sending: false,
    requestId: null,
    stopRequested: false,
    responseStarted: false,
    pendingPrompt: "",
    pendingAttachments: [],
    pendingAfterSortOrder: null,
    streamingText: "",
    streamingThinking: "",
    error: "",
    contextPreview: [],
    contextDebug: null,
    contextBudgetTokens: 0,
    contextNotes: [],
    contextInfoNotes: [],
    completed: false,
    completedMessageId: null,
  };
}

// A stable, frozen empty-state singleton for the "no stream yet" render
// fallback. Using createEmptySessionStreamState() there produced a NEW object (with
// new empty arrays) every render, which defeated SessionConversation's
// renderedMessages memo — forcing an O(n) recompute + scrollIntoView ~4×/sec during
// the 250ms pipeline poll on multi-thousand-message sessions. A single frozen
// singleton keeps every field reference (including the empty arrays) stable, and
// freezing makes any accidental mutation throw rather than corrupt shared state.
export const EMPTY_SESSION_STREAM_STATE: SessionStreamState = Object.freeze(createEmptySessionStreamState());

// Optimistic label for a spotlight send. The SERVER persists the turn as a
// `[GM SPOTLIGHT — Name: steer]` marker (chatService), so the two never
// compare equal — the dedupe below matches spotlight sends by directiveKind.
export const SPOTLIGHT_PENDING_PREFIX = "🎭 Scene handed to";
export function buildSpotlightPendingLabel(characterName: string, steer?: string) {
  return `${SPOTLIGHT_PENDING_PREFIX} ${characterName}${steer ? ` — “${steer}”` : ""}`;
}

type PersistedTurnProbe = Pick<ChatMessage, "role" | "content" | "directiveKind" | "sortOrder">;

/**
 * True when the persisted transcript already carries the pending user turn —
 * a user message newer than `afterSortOrder` whose content equals the pending
 * prompt (or, for a spotlight send, any newer gm_spotlight marker). Scans the
 * tail only, so an identical prompt sent earlier in the session never hides
 * the optimistic bubble, and the match holds regardless of what landed after
 * the user turn (the assistant reply, a second refetch, …).
 */
export function isPendingPromptPersisted(
  messages: readonly PersistedTurnProbe[],
  pendingPrompt: string,
  afterSortOrder: number | null,
): boolean {
  if (!pendingPrompt) return false;
  const floor = afterSortOrder ?? -1;
  const spotlight = pendingPrompt.startsWith(SPOTLIGHT_PENDING_PREFIX);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.sortOrder <= floor) break;
    if (m.role !== "user") continue;
    if (spotlight ? m.directiveKind === "gm_spotlight" : m.content === pendingPrompt) return true;
  }
  return false;
}

/**
 * The dedupe floor for a replayed user turn that had no loaded predecessor.
 * Resend and the scene auto-regen truncate at such a turn and delete it, then
 * re-stream it. The floor used to be -1, and the newest window after the delete reaches back
 * into rows that were never loaded, so an older user turn with the same text ("Continue.")
 * read as the persisted replay and a failed stream did not hand the deleted prompt back. The
 * live tail after the delete is exactly the row the replay lands after: the server allocates
 * MAX(sort_order) + 1, so this holds when sortOrders have holes, where "the replayed row's
 * sortOrder - 1" would miss the re-persisted turn. -1 for an emptied session.
 */
export function replayFloorAfterRemoval(windowAfterRemoval: readonly Pick<ChatMessage, "sortOrder">[]): number {
  return windowAfterRemoval[windowAfterRemoval.length - 1]?.sortOrder ?? -1;
}
