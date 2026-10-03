import type { ComposerAttachmentInput } from "./sessionStreamState";

/** A spotlight hand-off as the stream request carries it. */
export type SpotlightHandOff = { characterName: string; steer?: string };

/**
 * What a failed send gives back when the server never saved its turn: the composer's text and files, and a
 * spotlight send's hand-off, which goes back to the spotlight popover (character and steer), never into the
 * composer, where sending it would save the marker text as a player turn.
 */
export type FailedSendRestore = {
  draft: string;
  attachments: ComposerAttachmentInput[];
  spotlight?: SpotlightHandOff;
};

// Composer text a failed send could not hand back to its own instance. Stream
// state lives in AppShell (keyed by session id) and survives a session switch,
// but draft/attachments are instance state of a component the shell REMOUNTS
// per session — a send that fails after the user switched away used to call
// setDraft on the unmounted instance and the text was gone.
// The finally block stashes it here instead; the next mount of that
// session consumes it. Module scope: survives remounts, not page reloads
// (nothing in-memory does). A spotlight hand-off rides the same entry.
export const composerRestoreStash = new Map<string, FailedSendRestore>();

/**
 * What a failed, never-saved send hands back, or null when there is nothing to give back. "Hand the scene" clears
 * the popover's steer before it sends, and this used to hand back only the composer's text and files, so a hand-off
 * that failed before the server saved it lost its steer.
 */
export function failedSendRestore(sent: FailedSendRestore): FailedSendRestore | null {
  if (!sent.draft && !sent.attachments.length && !sent.spotlight) return null;
  return { draft: sent.draft, attachments: sent.attachments, ...(sent.spotlight ? { spotlight: sent.spotlight } : {}) };
}

/**
 * The spotlight popover's fields after a failed hand-off comes back: the character and steer together, unless a
 * steer has been typed since, which stays with the character chosen for it. This is the composer's rule (never
 * over text typed since); the earlier restore kept a typed steer but still switched the character, which paired the
 * new steer with the failed hand-off's character.
 */
export function spotlightFieldsAfterRestore(
  current: { characterName: string; steer: string },
  handOff: SpotlightHandOff,
): { characterName: string; steer: string } {
  if (current.steer) return current;
  return { characterName: handOff.characterName, steer: handOff.steer ?? "" };
}
