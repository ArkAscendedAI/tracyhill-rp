/**
 * Strip [OOC: …] blocks from transcript text before a CANON-WRITING worker
 * reads it.
 *
 * Why this exists: a rolling diff once ran
 * on a window whose last message was the player's [OOC: …] beat-sheet for a
 * scene that had not been rendered yet. The diff ingested the PLAN as played
 * reality — eight villager entries with fabricated names, a tribute-regime
 * entry with invented specifics, and an edit to a hand-written
 * character entry citing an appearance that did not exist. The epistemic-
 * status rule cannot catch this: it guards against in-world unreality
 * (visions, illusions), not out-of-character authorial planning.
 *
 * OOC is direction to the COMPOSER. It is never itself an event. Canon
 * writers (rolling diff, thread tracker, drive update, campaign audit,
 * world-state extraction) therefore see transcript windows with OOC blocks
 * removed; the composer path is untouched and still receives them.
 *
 * Matching is a balanced-bracket scan, not a regex: OOC blocks are frequently
 * multiline and may contain nested brackets. An explicit `/OOC]` terminator
 * ends the block regardless of depth (a form that appears in real campaigns).
 * An unterminated block strips to end-of-text — planning text with a typo'd
 * closer must still never reach a canon writer.
 */

const OPENER = /\[\s*OOC\b/gi;
// The explicit terminator, case-insensitive like the opener (`indexOf("/OOC]")`
// used to miss `/ooc]`, so a lower-case block with a stray `]` inside closed at
// that bracket and its planning text reached the canon writers, and one with an
// unbalanced `[` stripped to end-of-text).
const TERMINATOR = /\/OOC\]/gi;

export function stripOocBlocks(text: string): string {
  if (!text || text.indexOf("[") === -1) return text;
  OPENER.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = OPENER.exec(text)) !== null) {
    if (match.index < cursor) continue; // opener inside a block we already cut
    out += text.slice(cursor, match.index);
    // An explicit /OOC] terminator is authorial and decisive: beat-sheets
    // routinely contain stray unbalanced "]" characters that would close a
    // depth scan early. Honor the terminator when it belongs to THIS block
    // (i.e. appears before the next [OOC opener); fall back to balanced scan.
    OPENER.lastIndex = match.index + 4;
    const nextOpener = OPENER.exec(text)?.index ?? text.length;
    OPENER.lastIndex = match.index + 4; // restore loop position
    TERMINATOR.lastIndex = match.index;
    const term = TERMINATOR.exec(text)?.index ?? -1;
    let end: number;
    if (term !== -1 && term < nextOpener) {
      end = term + 5;
    } else {
      end = text.length; // unterminated → strip to end
      let depth = 0;
      for (let i = match.index; i < text.length; i++) {
        const ch = text[i];
        if (ch === "[") depth++;
        else if (ch === "]") {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
    }
    cursor = end;
  }
  out += text.slice(cursor);
  // Collapse the whitespace the removal leaves behind so windows stay tidy.
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
