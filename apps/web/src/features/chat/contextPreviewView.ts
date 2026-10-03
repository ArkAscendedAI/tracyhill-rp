import type { ChatMessage, ContextAssemblyDebug, ContextPreviewEntry, MessageContextSnapshot } from "@tracyhill-rp/contracts";

import type { SessionStreamState } from "./sessionStreamState";

/** The reply a stored snapshot belongs to. */
export type ContextReply = { messageId: string; createdAt: string; newest: boolean };

/**
 * What the Preview chip and its popover show: the
 * live stream's `response.context` when this page holds one, otherwise a reply's stored snapshot.
 */
export type ContextPreviewView = {
  preview: ContextPreviewEntry[];
  debug: ContextAssemblyDebug | null;
  budgetTokens: number;
  notes: string[];
  infoNotes: string[];
  /** Every row the engine dropped on that turn; a snapshot keeps only the highest-scoring ones. null when live. */
  droppedTotal: number | null;
  /** null for the live stream; the reply and its composer model for a stored snapshot. */
  reply: (ContextReply & { modelId: string }) | null;
};

/** A turn is in flight, or the page already received a turn's context: the live state wins. */
export function hasLiveContext(stream: Pick<SessionStreamState, "sending" | "contextDebug" | "contextPreview">): boolean {
  return stream.sending || stream.contextDebug !== null || stream.contextPreview.length > 0;
}

export type ContextSource = { kind: "live" } | { kind: "snapshot"; reply: ContextReply } | { kind: "none" };

/**
 * What the Preview chip shows (2026-09-29): the live stream state when this page
 * holds one; otherwise, after a reload, the newest reply's stored snapshot; otherwise nothing.
 */
export function chipContextSource(
  stream: Pick<SessionStreamState, "sending" | "contextDebug" | "contextPreview">,
  messages: readonly Pick<ChatMessage, "id" | "role" | "createdAt" | "hasContextSnapshot">[],
): ContextSource {
  if (hasLiveContext(stream)) return { kind: "live" };
  const reply = newestSnapshotReply(messages);
  return reply ? { kind: "snapshot", reply } : { kind: "none" };
}

export function liveContextView(stream: SessionStreamState): ContextPreviewView {
  return {
    preview: stream.contextPreview,
    debug: stream.contextDebug,
    budgetTokens: stream.contextBudgetTokens,
    notes: stream.contextNotes,
    infoNotes: stream.contextInfoNotes,
    droppedTotal: null,
    reply: null,
  };
}

export function snapshotContextView(snapshot: MessageContextSnapshot, reply: ContextReply): ContextPreviewView {
  return {
    preview: snapshot.preview,
    debug: snapshot.debug,
    budgetTokens: snapshot.budgetTokens,
    notes: snapshot.notes,
    infoNotes: snapshot.infoNotes,
    droppedTotal: snapshot.droppedTotal,
    reply: { ...reply, modelId: snapshot.modelId },
  };
}

/** The newest assistant reply in the window. */
export function newestReplyId(messages: readonly Pick<ChatMessage, "id" | "role">[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "assistant") return messages[i]!.id;
  return null;
}

/**
 * The reply whose snapshot the chip falls back to after a reload: the newest assistant reply that
 * has one (`hasContextSnapshot`), flagged when it is also the newest reply of the window.
 */
export function newestSnapshotReply(messages: readonly Pick<ChatMessage, "id" | "role" | "createdAt" | "hasContextSnapshot">[]): ContextReply | null {
  const newest = newestReplyId(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.hasContextSnapshot) return { messageId: m.id, createdAt: m.createdAt, newest: m.id === newest };
  }
  return null;
}

const when = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/** Names the reply a snapshot belongs to, so the reader knows which turn the popover describes. */
export function describeReply(reply: ContextReply): string {
  return reply.newest ? `newest reply, ${when(reply.createdAt)}` : `reply of ${when(reply.createdAt)}`;
}

/** The popover title; `reply` names the reply while its snapshot is still loading. */
export function contextPreviewTitle(view: ContextPreviewView | null, reply?: ContextReply | null): string {
  const parts = ["Context Preview"];
  const subject = view?.reply ?? reply ?? null;
  if (subject) parts.push(describeReply(subject));
  if (view && view.preview.length > 0) {
    parts.push(`${view.preview.filter((e) => e.included).length} entries`);
    parts.push(`${view.debug?.totalTokens ?? 0} / ${view.budgetTokens} tok`);
  }
  return parts.join(" · ");
}

/**
 * The Preview popover's line when its view holds no entry rows (Android copies the text).
 * It used to say "No context data yet — send a message to see the breakdown." for every live turn, so right after a
 * notes-only turn it asked for the message just sent. A turn in flight has not reported its context yet (the
 * `response.context` event always carries `debug`, so a null `contextDebug` means it has not arrived).
 */
export function chipContextEmptyText(
  source: ContextSource,
  stream: Pick<SessionStreamState, "contextDebug">,
  snapshot: { isError: boolean; loaded: boolean },
): string {
  if (source.kind === "live") return stream.contextDebug === null ? "This turn's context has not arrived yet." : "This turn reported no context breakdown.";
  if (source.kind === "none") return "No context data yet. Send a message to see the breakdown.";
  if (snapshot.isError) return "The newest reply's stored context could not be loaded.";
  return snapshot.loaded ? "No lorebook entries were scored for the newest reply." : "Loading the newest reply's stored context…";
}
