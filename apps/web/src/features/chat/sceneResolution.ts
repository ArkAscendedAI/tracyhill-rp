import type { ChatMessage, SessionDetailResponse } from "@tracyhill-rp/contracts";

import { buildSpotlightPendingLabel, mapStoredAttachmentToInput, type ComposerAttachmentInput } from "./sessionStreamState";

// What happens AFTER a scene-validator resolution is saved with the Auto-regen
// dial on.
//
// The automatic regenerate is destructive: it truncates the transcript to the
// message BEFORE the resolved reply's user turn and re-streams that turn (the
// reply slot, its variants and EVERY later turn are hard-deleted server-side).
// That is only acceptable when the resolved reply is the live tail — then the
// only thing replaced is the reply itself. Before this helper the branch ran
// for any reply found in the newest window ("Agree with Validator & regenerate"
// on a twenty-turn-old divider silently deleted twenty turns), and silently did
// nothing for a reply outside the window (the historical scene-jump view).
//
// Every non-regen outcome is reported to the user (toast + the divider's own
// wording); the confirmed Cut action stays the one deliberate destructive route.
export type AutoRegenTarget =
  | {
    kind: "regen";
    userMessage: ChatMessage;
    // Message the transcript is truncated to (everything after it is deleted);
    // null when the user turn is the first message of the window — the caller
    // then truncates AT the user turn and deletes it (the stream re-persists it).
    truncateToId: string | null;
    // sortOrder the replayed user turn lands after (pending-bubble dedupe).
    pendingAfterSortOrder: number;
  }
  | { kind: "not-live-tail"; reason: "outside-window" | "older-reply" }
  | { kind: "no-user-turn" };

/**
 * Decide whether the resolved reply may be auto-regenerated. `detail` is the
 * server's post-resolution session detail — the newest window with
 * `pagination.hasNewer === false` — so "last row of the window" means "live
 * tail of the session". Any later row (a newer turn, a generated-image message,
 * a dangling user turn) makes the reply an older reply.
 */
export function resolveAutoRegenTarget(
  detail: Pick<SessionDetailResponse, "messages" | "pagination">,
  messageId: string,
): AutoRegenTarget {
  const rows = detail.messages;
  const idx = rows.findIndex((m) => m.id === messageId);
  if (idx < 0) return { kind: "not-live-tail", reason: "outside-window" };
  if (idx !== rows.length - 1 || detail.pagination.hasNewer) return { kind: "not-live-tail", reason: "older-reply" };
  let prevUserIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (rows[i]!.role === "user") { prevUserIdx = i; break; }
  }
  if (prevUserIdx < 0) return { kind: "no-user-turn" };
  return {
    kind: "regen",
    userMessage: rows[prevUserIdx]!,
    truncateToId: prevUserIdx > 0 ? rows[prevUserIdx - 1]!.id : null,
    pendingAfterSortOrder: rows[prevUserIdx - 1]?.sortOrder ?? -1,
  };
}

/** User-facing explanation for a resolution that was saved without a regenerate. */
export function describeSkippedAutoRegen(target: Exclude<AutoRegenTarget, { kind: "regen" }>): string {
  if (target.kind === "no-user-turn") return "Scene resolution saved. There is nothing to regenerate, because no user turn precedes this reply.";
  return "Scene resolution saved. Automatic regeneration runs only on the newest reply. To replay the story from this point, Cut the turn before it and Resend. Cut deletes every later turn.";
}

/**
 * How the auto-regen replays the resolved reply's user turn. The
 * replay used to re-stream the turn's TEXT for every kind of turn. A Living World spotlight
 * marker (role user, directiveKind "gm_spotlight", persisted by the stream route as
 * "[GM SPOTLIGHT — Name: steer]") then came back as a plain player row: a user bubble with the
 * raw marker text and Edit/Resend on it, for good, where it should render as the hand-off
 * divider. The marker now replays through the spotlight request, so the server persists the
 * same marker with its kind and rebuilds the spotlight instruction from it, exactly as for the
 * original hand-off. A marker that cannot be read back, or that the request contract would
 * refuse, is not replayed at all: the truncate before the stream would delete it.
 */
export type AutoRegenReplay =
  | { kind: "prompt"; prompt: string; attachments: ComposerAttachmentInput[]; pendingPrompt: string }
  | { kind: "spotlight"; spotlight: { characterName: string; steer?: string }; pendingPrompt: string }
  | { kind: "unreadable-spotlight" };

// The server's parseSpotlightMarker (chatService.ts), which also rebuilds the spotlight
// instruction from the marker; the limits are chatSendRequestSchema's spotlight caps.
const SPOTLIGHT_MARKER_RE = /^\[GM SPOTLIGHT [—-] ([^:\]]+?)(?::\s*([\s\S]+?))?\]$/;
const SPOTLIGHT_NAME_MAX = 200;
const SPOTLIGHT_STEER_MAX = 500;

export function autoRegenReplay(userMessage: ChatMessage): AutoRegenReplay {
  if (userMessage.directiveKind === "gm_spotlight") {
    const match = SPOTLIGHT_MARKER_RE.exec(userMessage.content.trim());
    const characterName = match?.[1]?.trim() ?? "";
    const steer = match?.[2]?.trim() ?? "";
    if (!characterName || characterName.length > SPOTLIGHT_NAME_MAX || steer.length > SPOTLIGHT_STEER_MAX) return { kind: "unreadable-spotlight" };
    return {
      kind: "spotlight",
      spotlight: { characterName, ...(steer ? { steer } : {}) },
      pendingPrompt: buildSpotlightPendingLabel(characterName, steer || undefined),
    };
  }
  return {
    kind: "prompt",
    prompt: userMessage.content,
    attachments: userMessage.attachments.map(mapStoredAttachmentToInput),
    pendingPrompt: userMessage.content || "See attached files.",
  };
}

/** User-facing notice for a spotlight reply whose marker could not be replayed. */
export function describeUnreadableSpotlightReplay(): string {
  return "Scene resolution saved. This reply answered a spotlight hand-off that could not be read back, so it was not regenerated automatically. Use Regenerate on the reply to write it again.";
}
