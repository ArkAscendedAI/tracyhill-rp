import { ATTACHMENT_MAX_CONTENT_LEN } from "@tracyhill-rp/contracts";

// Composer input edge cases.

// Mirrors `chatSendRequestSchema.attachments.max(8)` in
// packages/contracts/src/chat.ts (no shared constant is exported there);
// the server rejects a ninth attachment, so the
// composer trims to the cap and SAYS so instead of dropping files silently.
export const COMPOSER_ATTACHMENT_LIMIT = 8;

export function mergeAttachments<T>(current: readonly T[], incoming: readonly T[], limit = COMPOSER_ATTACHMENT_LIMIT): { attachments: T[]; dropped: number } {
  const room = Math.max(0, limit - current.length);
  const kept = incoming.slice(0, room);
  return { attachments: kept.length ? [...current, ...kept] : [...current], dropped: incoming.length - kept.length };
}

export function describeDroppedAttachments(dropped: number, limit = COMPOSER_ATTACHMENT_LIMIT): string {
  return `Only ${limit} attachments per message — ${dropped} ${dropped === 1 ? "file was" : "files were"} not added.`;
}

/**
 * Enter as a COMMIT key, composition-safe: while an IME is composing (CJK
 * candidate confirmation) the Enter keydown must not send. `isComposing` is
 * the standard signal; `keyCode === 229` is the legacy one some WebKit builds
 * still emit for the keydown that ends a composition with `isComposing` false.
 */
export function isEnterKey(event: { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean } }): boolean {
  if (event.key !== "Enter") return false;
  if (event.nativeEvent?.isComposing) return false;
  if (event.keyCode === 229) return false;
  return true;
}

// Throws-before-attach check on an encoded attachment: images are resized, but a PDF/text file
// used to be base64'd in full and only rejected by the server's Zod schema at send time,
// surfacing as a raw validation string in the composer error slot. The lower bound
// had the same gap: an empty (0-byte) file attached, then failed the whole send.
export function attachmentContentProblem(filename: string, content: string): string | null {
  if (!content.length) return `${filename} is empty`;
  if (content.length > ATTACHMENT_MAX_CONTENT_LEN) {
    // base64 inflates 4/3, so the binary ceiling is ~¾ of the char cap.
    const limitMb = (ATTACHMENT_MAX_CONTENT_LEN * 0.75 / 1_000_000).toFixed(1);
    return `${filename} is too large to attach (limit ≈${limitMb} MB per file)`;
  }
  return null;
}
