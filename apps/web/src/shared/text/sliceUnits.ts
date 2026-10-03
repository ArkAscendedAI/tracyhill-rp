/**
 * `text.slice(0, units)` that never ends between the two halves of a surrogate pair (an emoji, or any other
 * character outside the Basic Multilingual Plane). `slice` counts UTF-16 units, so a pair straddling the cut kept
 * its high half, which renders as a replacement glyph and copies as U+FFFD; the cut backs off one unit instead.
 * The wizard review's corpus preview had it first; the other fixed-length cuts share it.
 */
export function sliceUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const last = text.charCodeAt(units - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? units - 1 : units);
}

/**
 * The mirror cut, `text.slice(-units)` that never starts between the two halves of a surrogate pair: a cut landing on
 * a pair's low half drops it too (one unit fewer). It also returns "" for 0 units, where `slice(-0)` returns the whole
 * text. It serves the tail previews and the second half of a middle cut; Android's `ccTailUnits`.
 */
export function tailUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const start = text.length - Math.max(0, units);
  const first = text.charCodeAt(start);
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? start + 1 : start);
}
