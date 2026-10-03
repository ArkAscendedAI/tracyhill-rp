// Robust extraction of a single JSON value from an LLM response.
//
// Workers/context callers used to do `text.match(/\{[\s\S]*\}/)` (greedy
// first-open→last-close), which broke whenever the model emitted anything after
// the JSON. The first rewrite preferred ```fenced``` content — but that LOSES a
// leading bare `{…}` when the model appends a code fence AFTER the JSON (observed
// on -bridge models: a valid `{"ids":[…]}` followed by a ``` block parsed to
// null). So: scan the RAW text for the first balanced value FIRST, and only fall
// back to fence bodies if the raw text yields nothing parseable.

// Balanced span starting at the first `open` at or after `from`; null when
// there is no `open` at all, `{ span: null, start }` when the candidate at
// `start` never closes — string tracking begins at the candidate's own brace,
// so a prose `{` followed by an odd number of quotes reads the real object's
// closing brace "inside a string"; the caller then advances past `start` and
// the next candidate gets its own parity.
function scanBalanced(src: string, open: "{" | "[", from = 0): { span: string | null; start: number } | null {
  const close = open === "{" ? "}" : "]";
  const start = src.indexOf(open, from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return { span: src.slice(start, i + 1), start }; }
  }
  return { span: null, start };
}

// A prose brace before the real JSON (`The set {a, b} was chosen: {"ids":…}`)
// used to be the ONLY raw candidate — it fails to parse and, absent a fence,
// the reply was lost as "no parseable JSON". Keep scanning from the next `open`
// so a later balanced span gets its turn, bounded so a brace-heavy reply can't
// turn into a quadratic scan.
const MAX_RAW_CANDIDATES = 8;

// Candidate balanced spans, in priority order: successive raw-text spans first,
// then the body of each ```…``` fence. (Raw-first so a leading bare object beats
// a trailing fence.) Lazy so the common case stops at the first parse.
function* candidates(text: string, open: "{" | "["): Generator<string> {
  let from = 0;
  for (let n = 0; n < MAX_RAW_CANDIDATES; n++) {
    const hit = scanBalanced(text, open, from);
    if (!hit) break;
    // An unclosed candidate used to END the raw scan (`Use "{" to open: {…}`
    // lost the real object to a fence-less null); it now just spends one of
    // the bounded candidates.
    if (hit.span) yield hit.span;
    from = hit.start + 1;
  }
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const f = scanBalanced(m[1] ?? "", open);
    if (f?.span) yield f.span;
  }
}

// Returns the first candidate that actually JSON.parses (a balanced span can
// still be invalid), or null if none parse / none found. Null lets callers
// distinguish "no parseable JSON" from a parsed-but-empty result.
export function parseFirstJson<T = unknown>(text: string, open: "{" | "[" = "{"): T | null {
  if (!text) return null;
  for (const c of candidates(text, open)) {
    try { return JSON.parse(c) as T; } catch { /* try next candidate */ }
  }
  return null;
}
