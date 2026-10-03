/**
 * Fixed-length cuts that never split a surrogate pair (an emoji, or any other character outside the Basic
 * Multilingual Plane). `slice` counts UTF-16 units, so a pair straddling a cut kept one half, which renders as a
 * replacement glyph and copies as U+FFFD. These are the server's copies of the web's `shared/text/sliceUnits.ts`
 * (`sliceUnits` and `tailUnits`), with the same rules and test vectors, so a server excerpt
 * and a client preview cut alike. First used by the workspace search excerpt.
 */

/** `text.slice(0, units)`, backing off one unit when the cut would end on a high surrogate. */
export function sliceUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const last = text.charCodeAt(units - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? units - 1 : units);
}

/** `text.slice(-units)`, dropping one more unit when the cut would start on a low surrogate; "" for 0 units. */
export function tailUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const start = text.length - Math.max(0, units);
  const first = text.charCodeAt(start);
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? start + 1 : start);
}
