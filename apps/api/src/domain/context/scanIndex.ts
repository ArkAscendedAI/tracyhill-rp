// Scan index — the regex-free whole-word matcher behind keyword activation.
//
// Until 2026-09-21 every lorebook key was matched by compiling a fresh Unicode
// lookbehind regex (`(?<![\p{L}\p{N}_])key(?![\p{L}\p{N}_])`, flags `iu`) and
// running it over the whole scan buffer — per key, per entry, per recursion
// pass, per turn. Compiling those regexes dominated context assembly: ~5 s of
// synchronous CPU on a 386-entry / 5,900-key campaign, during which the API's
// single event loop served nothing (the "app locks while assembling context"
// report). The regex was replaced, not cached, because the cost was in the
// compile: a cached regex still scans the full buffer per key.
//
// Semantics preserved exactly, by construction:
//   • a "word character" is `\p{L}`, `\p{N}` or `_` (the class the old regex used —
//     Unicode-aware, so accented and CJK names have boundaries);
//   • a literal key matches whole-word when it occurs in the buffer with a
//     non-word character (or the string edge) on both sides;
//   • case-insensitive matching lowercases BOTH the buffer and the key with
//     `toLowerCase()` — the old code did the same before applying its `i` regex.
//     The residual differences, both pinned by unit tests and absent
//     from the measured corpora (2026-09-21 snapshot): the `i` flag treated
//     simple case-fold pairs that `toLowerCase()` keeps distinct as equal
//     (ſ ↔ s, ς ↔ σ incl. a Final_Sigma Σ, µ ↔ μ, ϐ ↔ β, ϑ ↔ θ, ϱ ↔ ρ, ϰ ↔ κ,
//     ẛ ↔ ṡ, U+0345/U+1FBE ↔ ι — NOT the Kelvin sign, which lowercases to k on
//     both sides); and under `iu` the boundary class itself was closed under
//     folding, so U+0345 (combining ypogegrammeni, folds to ι) counted as a
//     letter there while here every combining mark is a boundary, uniformly.
//   • matches are code-point matches: a key that carries an unpaired surrogate
//     (reachable through a JSON `\ud83d` escape) can never match half of a
//     surrogate pair in the window — `indexOf`/`startsWith` would, the retired
//     `u`-flag regex did not.
//
// How it works: the buffer is tokenized ONCE into maximal runs of word
// characters (token → start offsets). A key that is itself a single token is a
// Map lookup. A key with several tokens (or leading/trailing punctuation) is
// anchored on its rarest token's occurrences and confirmed with `startsWith`
// plus the two boundary checks, so "old harbor" costs a handful of comparisons
// instead of a 300 KB scan. A key with no word characters at all falls back to
// an `indexOf` sweep with the same boundary checks.

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const KEY_TOKEN = /[\p{L}\p{N}_]+/gu;

// ASCII fast path; non-ASCII code points ask the Unicode class once and are memoized.
const ASCII_WORD = new Uint8Array(128);
for (let c = 0; c < 128; c++) ASCII_WORD[c] = /[A-Za-z0-9_]/.test(String.fromCharCode(c)) ? 1 : 0;
const nonAsciiWord = new Map<number, boolean>();

export function isWordCodePoint(cp: number): boolean {
  if (cp < 128) return ASCII_WORD[cp] === 1;
  let known = nonAsciiWord.get(cp);
  if (known === undefined) {
    known = WORD_CHAR.test(String.fromCodePoint(cp));
    if (nonAsciiWord.size > 8192) nonAsciiWord.clear();
    nonAsciiWord.set(cp, known);
  }
  return known;
}

/** Is the code point that ENDS at index `i` (i.e. immediately before position i) a word character? */
function wordBefore(text: string, i: number): boolean {
  if (i <= 0) return false;
  const unit = text.charCodeAt(i - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return isWordCodePoint(text.codePointAt(i - 2)!);
  }
  return isWordCodePoint(unit);
}

/** Is the code point that STARTS at index `i` a word character? (false at the end of the string) */
function wordAt(text: string, i: number): boolean {
  if (i >= text.length) return false;
  return isWordCodePoint(text.codePointAt(i)!);
}

/** Does index `i` fall between the two halves of a surrogate pair? A match that
 *  starts or ends there is half a code point — the retired `u`-flag regex could
 *  not produce it, `indexOf`/`startsWith` can. */
function splitsSurrogatePair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const unit = text.charCodeAt(i);
  if (unit < 0xdc00 || unit > 0xdfff) return false;
  const prev = text.charCodeAt(i - 1);
  return prev >= 0xd800 && prev <= 0xdbff;
}

/** Maximal runs of word characters → their start offsets. Surrogate-aware. */
export function tokenizePositions(text: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    let cp = text.codePointAt(i)!;
    let width = cp > 0xffff ? 2 : 1;
    if (!isWordCodePoint(cp)) { i += width; continue; }
    const start = i;
    i += width;
    while (i < n) {
      cp = text.codePointAt(i)!;
      width = cp > 0xffff ? 2 : 1;
      if (!isWordCodePoint(cp)) break;
      i += width;
    }
    const token = text.slice(start, i);
    const list = map.get(token);
    if (list) list.push(start); else map.set(token, [start]);
  }
  return map;
}

interface KeyToken { token: string; offset: number }
// Keys repeat across recursion passes and turns; their token split is cached.
const keyTokenCache = new Map<string, KeyToken[]>();
function keyTokens(key: string): KeyToken[] {
  let toks = keyTokenCache.get(key);
  if (toks) return toks;
  toks = [];
  for (const m of key.matchAll(KEY_TOKEN)) toks.push({ token: m[0], offset: m.index! });
  if (keyTokenCache.size > 50_000) keyTokenCache.clear();
  keyTokenCache.set(key, toks);
  return toks;
}

/** Whole-word occurrence of a literal `needle` in `haystack` by sweeping — for short strings
 *  (present-character names) and for keys with no word characters. Exact boundary semantics. */
export function containsWholeWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) {
    // The old empty-key regex matched at any position with non-word (or edge) on
    // both sides — INCLUDING a position between the halves of a surrogate pair
    // (measured on V8: `/(?<![\p{L}\p{N}_])(?![\p{L}\p{N}_])/u.exec("a😀b").index`
    // is 2), so this loop deliberately visits every code unit. Only a non-empty
    // key is barred from matching half a pair (below).
    for (let i = 0; i <= haystack.length; i++) if (!wordBefore(haystack, i) && !wordAt(haystack, i)) return true;
    return false;
  }
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const end = at + needle.length;
    if (!splitsSurrogatePair(haystack, at) && !splitsSurrogatePair(haystack, end) && !wordBefore(haystack, at) && !wordAt(haystack, end)) return true;
    from = at + 1;
  }
}

export class ScanIndex {
  private lower: string | null = null;
  private lowerTokens: Map<string, number[]> | null = null;
  private exactTokens: Map<string, number[]> | null = null;

  constructor(readonly text: string) {}

  /** The buffer as the matcher sees it: lowercased unless the entry is case-sensitive. */
  textFor(caseSensitive: boolean): string {
    if (caseSensitive) return this.text;
    if (this.lower === null) this.lower = this.text.toLowerCase();
    return this.lower;
  }

  private tokensFor(caseSensitive: boolean): Map<string, number[]> {
    if (caseSensitive) {
      if (this.exactTokens === null) this.exactTokens = tokenizePositions(this.text);
      return this.exactTokens;
    }
    if (this.lowerTokens === null) this.lowerTokens = tokenizePositions(this.textFor(false));
    return this.lowerTokens;
  }

  /** Plain substring test (matchWholeWords:false). `key` must already be lowercased when !caseSensitive. */
  includes(key: string, caseSensitive: boolean): boolean {
    return this.textFor(caseSensitive).includes(key);
  }

  /** Whole-word test. `key` must already be lowercased when !caseSensitive (the caller lowercases
   *  keys exactly as the retired regex path did). */
  hasWholeWord(key: string, caseSensitive: boolean): boolean {
    const toks = keyTokens(key);
    const text = this.textFor(caseSensitive);
    if (toks.length === 0) return containsWholeWord(text, key);
    const map = this.tokensFor(caseSensitive);
    let anchor: KeyToken | null = null;
    let positions: number[] | null = null;
    for (const t of toks) {
      const found = map.get(t.token);
      if (!found) return false; // a token absent from the buffer: the key cannot occur
      if (positions === null || found.length < positions.length) { anchor = t; positions = found; }
    }
    // A key that IS one whole token: every occurrence is a maximal word run, i.e. already bounded.
    if (toks.length === 1 && anchor!.offset === 0 && anchor!.token.length === key.length) return true;
    for (const p of positions!) {
      const start = p - anchor!.offset;
      if (start < 0) continue;
      if (!text.startsWith(key, start)) continue;
      const end = start + key.length;
      if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) continue;
      if (wordBefore(text, start) || wordAt(text, end)) continue;
      return true;
    }
    return false;
  }

  /** Every whole-word occurrence's start offset in `textFor(caseSensitive)`, ascending — `hasWholeWord`'s rule, all
   *  matches instead of the first (presence resolution attributes each mention to one person). */
  wholeWordStarts(key: string, caseSensitive: boolean): number[] {
    const text = this.textFor(caseSensitive);
    const toks = keyTokens(key);
    const out: number[] = [];
    if (key.length === 0) return out;
    if (toks.length === 0) {
      for (let from = 0; ;) {
        const at = text.indexOf(key, from);
        if (at < 0) return out;
        const end = at + key.length;
        if (!splitsSurrogatePair(text, at) && !splitsSurrogatePair(text, end) && !wordBefore(text, at) && !wordAt(text, end)) out.push(at);
        from = at + 1;
      }
    }
    const map = this.tokensFor(caseSensitive);
    let anchor: KeyToken | null = null;
    let positions: number[] | null = null;
    for (const t of toks) {
      const found = map.get(t.token);
      if (!found) return out;
      if (positions === null || found.length < positions.length) { anchor = t; positions = found; }
    }
    if (toks.length === 1 && anchor!.offset === 0 && anchor!.token.length === key.length) return [...positions!];
    for (const p of positions!) {
      const start = p - anchor!.offset;
      if (start < 0 || !text.startsWith(key, start)) continue;
      const end = start + key.length;
      if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) continue;
      if (wordBefore(text, start) || wordAt(text, end)) continue;
      out.push(start);
    }
    return out;
  }
}
