import type { LorebookEntry } from "@tracyhill-rp/contracts";
import { RegexBudget } from "./regexBudget";
import { ScanIndex } from "./scanIndex";

interface ActivationState {
  stickyRemaining: number;
  cooldownRemaining: number;
  lastActivatedTurn: number | null;
}

export interface KeywordActivationResult {
  activated: Map<string, { entry: LorebookEntry; score: number; source: "constant" | "sticky" | "keyword" }>;
  activationDelta: Map<string, Partial<ActivationState>>;
}

// ── Keyword scoring (2026-09-02) ──
export const KEYWORD_BASE = 800;
/** Per distinct non-PC primary key matched anywhere in the scan window, capped.
 *  Replaces the old precision fraction (matched / total keys × 100), which ranked
 *  an entry LOWER the more keys it carried — so the synonym expansion that makes
 *  an entry findable pushed it to the bottom of the budget race. Measured on
 *  one long campaign 2026-09-02: 16–20-key character cores at 870 vs 3-key entries at
 *  947, with three cores dropped on the very turn their location came into the scene. */
export const MATCH_BONUS_PER_KEY = 25;
export const MATCH_BONUS_MAX = 100;
/** Fresh-relevance signal. A key in the player's CURRENT message is the strongest
 *  evidence the next reply needs the entry; the last assistant reply (the scene
 *  the player is answering) is the second-strongest; a match only in older
 *  window text gets neither. Sized so one fresh match beats the incumbency
 *  recency boost (+49) but only a multi-key fresh match reaches the semantic
 *  band (900 + cos×100). */
export const FRESH_USER_TURN_BONUS = 60;
export const FRESH_LAST_REPLY_BONUS = 30;
/** A match consisting ONLY of player-character keys carries no relevance (the
 *  PC is in every scene) — the original penalty, unchanged. */
export const PC_ONLY_PENALTY = 200;
export const RECENCY_BOOST_MAX = 50;

export interface FreshBuffers { userTurn: string; lastAssistant: string }
interface FreshIndexes { userTurn: ScanIndex; lastAssistant: ScanIndex }
function toFreshIndexes(fresh: FreshBuffers | FreshIndexes): FreshIndexes {
  if (fresh.userTurn instanceof ScanIndex) return fresh as FreshIndexes;
  const f = fresh as FreshBuffers;
  return { userTurn: new ScanIndex(f.userTurn), lastAssistant: new ScanIndex(f.lastAssistant) };
}

/** Match bonus + PC penalty for a set of matched primary keys. Exported for tests.
 *  Counts DISTINCT keys (case-insensitively) as the formula says
 *  ("25 × distinct NON-PC primary keys") — an
 *  entry saved with `["Ryn", "ryn"]` once earned +50 for one word in the window. */
export function scoreMatchedKeys(matchedKeys: string[], pcKeySet: Set<string>): { matchBonus: number; pcPenalty: number } {
  const distinct = new Set(matchedKeys.map(k => k.toLowerCase()));
  const relevant = pcKeySet.size > 0 ? [...distinct].filter(k => !pcKeySet.has(k)) : [...distinct];
  const pcOnly = pcKeySet.size > 0 && distinct.size > 0 && relevant.length === 0;
  return { matchBonus: Math.min(relevant.length * MATCH_BONUS_PER_KEY, MATCH_BONUS_MAX), pcPenalty: pcOnly ? PC_ONLY_PENALTY : 0 };
}

/** Fresh bonus for an entry whose primary keys appear in the player's current
 *  message (strongest) or the last assistant reply. PC keys never count —
 *  the PC's own name is in every message. Uses the entry's own match options
 *  (regex keys, case, whole-word) via matchesEntry; the secondary-key gate was
 *  already satisfied on the full window, so only primary hits are read here.
 *  Accepts pre-built indexes so the two fresh buffers are tokenized once per
 *  assembly rather than once per matched entry. */
export function freshMatchBonus(entry: LorebookEntry, fresh: FreshBuffers | FreshIndexes | undefined, pcKeySet: Set<string>, regexBudget = new RegexBudget()): number {
  if (!fresh) return 0;
  const indexes = toFreshIndexes(fresh);
  const hits = (index: ScanIndex) => (index.text ? matchesEntry(entry, index, regexBudget).matchedKeys.filter(k => !pcKeySet.has(k.toLowerCase())).length : 0);
  if (hits(indexes.userTurn) > 0) return FRESH_USER_TURN_BONUS;
  if (hits(indexes.lastAssistant) > 0) return FRESH_LAST_REPLY_BONUS;
  return 0;
}

export function runKeywordActivation(
  entries: LorebookEntry[],
  activationState: Map<string, ActivationState>,
  scanBuffer: string,
  turnNumber: number,
  maxRecursion = 3,
  playerCharacterKeys: string[] = [],
  // Pure `semantic` mode still needs constants injected, sticky carried forward,
  // and cooldown decremented — the only path that does those lived here behind a
  // keyword/hybrid gate. `skipKeywordScan` keeps those three but suppresses the
  // keyword-matching phase so semantic mode doesn't gain keyword activations.
  skipKeywordScan = false,
  // Per-entry scan-depth override: when an entry's scanDepth differs
  // from the engine's global scanDepth, its keyword match runs against a buffer
  // built for THAT depth (resolver supplied by the caller, which owns the
  // message history). Entries at the global depth keep using `scanBuffer`.
  globalScanDepth?: number,
  scanBufferForDepth?: (depth: number) => string,
  // Fresh-relevance buffers: the player's current message and the
  // reply it answers, matched separately from the window.
  fresh?: FreshBuffers | FreshIndexes,
  regexBudget = new RegexBudget(),
): KeywordActivationResult {
  const activated = new Map<string, { entry: LorebookEntry; score: number; source: "constant" | "sticky" | "keyword" }>();
  const activationDelta = new Map<string, Partial<ActivationState>>();
  // Content of newly-activated entries is appended here for the recursive scan
  // passes; it's shared across all per-entry depth buffers.
  let recursionExtra = "";
  // One ScanIndex per distinct scan window per recursion pass (2026-09-21): the
  // window text is tokenized once and every key is a lookup, instead of a fresh
  // regex compile + full-buffer scan per key. recursionExtra only grows between
  // passes, so the per-pass cache is exact.
  let passIndexes = new Map<number | "global", ScanIndex>();
  const indexFor = (entry: LorebookEntry): ScanIndex => {
    const ownDepth = scanBufferForDepth !== undefined && globalScanDepth !== undefined && entry.scanDepth !== globalScanDepth;
    const cacheKey = ownDepth ? entry.scanDepth : "global";
    let index = passIndexes.get(cacheKey);
    if (index === undefined) {
      const base = ownDepth ? scanBufferForDepth!(entry.scanDepth) : scanBuffer;
      index = new ScanIndex(recursionExtra ? base + recursionExtra : base);
      passIndexes.set(cacheKey, index);
    }
    return index;
  };
  const freshIndexes = fresh ? toFreshIndexes(fresh) : undefined;
  const pcKeySet = new Set(playerCharacterKeys.map(k => k.toLowerCase()));

  // 1. Constants activate unconditionally
  for (const entry of entries) {
    if (entry.isConstant) {
      activated.set(entry.id, { entry, score: 1000, source: "constant" });
    }
  }

  // 2. Sticky carry-forward
  for (const entry of entries) {
    if (activated.has(entry.id)) continue;
    const state = activationState.get(entry.id);
    if (state && state.stickyRemaining > 0) {
      activated.set(entry.id, { entry, score: 900, source: "sticky" });
      activationDelta.set(entry.id, { stickyRemaining: state.stickyRemaining - 1, lastActivatedTurn: turnNumber });
    }
  }

  // Cooldown decrement runs in every mode (even when the keyword scan is
  // suppressed): an entry that entered cooldown must tick down each turn or it
  // would be blocked forever in pure semantic mode.
  if (skipKeywordScan) {
    for (const entry of entries) {
      if (activated.has(entry.id)) continue;
      const state = activationState.get(entry.id);
      if (state && state.cooldownRemaining > 0) {
        activationDelta.set(entry.id, { cooldownRemaining: state.cooldownRemaining - 1 });
      }
    }
    return { activated, activationDelta };
  }

  // 3. Keyword scan with recursion
  const probabilityRolls = new Map<string, boolean>();
  const recursionConsidered = new Set<string>();
  let newActivations = true;
  let recursionDepth = 0;
  while (newActivations && recursionDepth < maxRecursion) {
    newActivations = false;
    for (const entry of entries) {
      if (activated.has(entry.id)) continue;
      if (!entry.isEnabled) continue;

      // Cooldown check
      const state = activationState.get(entry.id);
      if (state && state.cooldownRemaining > 0) {
        activationDelta.set(entry.id, { cooldownRemaining: state.cooldownRemaining - 1 });
        continue;
      }

      // Delay check
      if (entry.delay > 0 && turnNumber < entry.delay) continue;

      // Recursion-specific checks. delayUntilRecursion gates WHEN the entry is
      // considered, not WHAT it may match: it is skipped on the initial pass
      // and can activate only once a recursion pass runs, i.e. only when some
      // other keyword entry activated this turn. Its keys are then matched
      // against the whole window — the chat text plus the activated entries'
      // content — exactly as SillyTavern does (a port of ST's
      // world-info.js); a unit test pins both halves. (The old
      // check lived inside the depth>0 branch with an unsatisfiable condition,
      // making the flag a no-op, and this comment used to claim "never from the
      // raw chat buffer".)
      if (entry.delayUntilRecursion && recursionDepth === 0) continue;
      // excludeRecursion = this entry must NOT be activated BY recursion (i.e. it
      // can only fire from the raw chat buffer at depth 0). preventRecursion is a
      // DIFFERENT flag (handled below): its CONTENT must not be appended to the
      // recursion scan buffer. The old code made the two identical, so
      // preventRecursion wrongly blocked the entry's OWN activation.
      if (recursionDepth > 0 && entry.excludeRecursion) continue;

      // Probability roll — once per turn per entry (rolling inside the
      // recursion loop gave sub-100% entries up to maxRecursion chances).
      if (entry.probability < 100) {
        let roll = probabilityRolls.get(entry.id);
        if (roll === undefined) {
          roll = Math.random() * 100 < entry.probability;
          probabilityRolls.set(entry.id, roll);
        }
        if (!roll) continue;
      }

      const match = matchesEntry(entry, indexFor(entry), regexBudget);
      if (match.matched) {
        const { matchBonus, pcPenalty } = scoreMatchedKeys(match.matchedKeys, pcKeySet);
        const freshBonus = freshMatchBonus(entry, freshIndexes, pcKeySet, regexBudget);
        // lastActivatedTurn = the turn the entry was last DELIVERED into context
        // (inclusion-scoped since 2026-09-02) — so this rewards
        // continuity of what the model has already seen, not mere candidacy.
        const turnsSince = state?.lastActivatedTurn != null ? Math.max(0, turnNumber - state.lastActivatedTurn) : Infinity;
        const recencyBoost = Math.max(0, RECENCY_BOOST_MAX - turnsSince);
        const score = KEYWORD_BASE + matchBonus + freshBonus - pcPenalty - recursionDepth * 100 + recencyBoost;
        activated.set(entry.id, { entry, score, source: "keyword" });
        newActivations = true;

        const delta: Partial<ActivationState> = { lastActivatedTurn: turnNumber };
        if (entry.sticky > 0) delta.stickyRemaining = entry.sticky;
        if (entry.cooldown > 0) delta.cooldownRemaining = entry.cooldown;
        activationDelta.set(entry.id, delta);
      }
    }

    // Append newly activated entry content to buffer for recursive scan.
    // preventRecursion = this entry's CONTENT must not seed further activations,
    // so it's excluded from the recursion scan buffer (but it still activated
    // normally above). The dedupe rule is unchanged — skip content whose first
    // 100 characters already appear in the scan text — but it is evaluated
    // against ONE concatenation per pass (grown as content is appended, exactly
    // as the per-hit rebuild saw it) and an entry is considered once: its head
    // can only be more present on a later pass, never less. The per-hit
    // rebuild + scan of a megabyte buffer was ~0.4 s of the remaining cost on
    // a 386-entry campaign after the regex removal (profiled 2026-09-21).
    if (newActivations && recursionDepth < maxRecursion) {
      let combined = scanBuffer + recursionExtra;
      for (const [, hit] of activated) {
        if (hit.entry.preventRecursion) continue;
        if (hit.source !== "keyword" || recursionConsidered.has(hit.entry.id)) continue;
        recursionConsidered.add(hit.entry.id);
        if (!combined.includes(hit.entry.content.slice(0, 100))) {
          recursionExtra += "\n" + hit.entry.content;
          combined += "\n" + hit.entry.content;
        }
      }
      // The windows changed: the next pass tokenizes them afresh.
      passIndexes = new Map();
    }
    recursionDepth++;
  }

  return { activated, activationDelta };
}

interface MatchResult {
  matched: boolean;
  matchedKeys: string[];
  matchedCount: number;
  totalPrimaryKeys: number;
}

/** Evaluate an entry's primary keys and secondary gate against a scan window.
 *  Accepts a pre-built ScanIndex (the hot path) or a plain string (tests, one-off callers). */
/** A blank key (empty or whitespace only) is never evidence of relevance.
 *  The whole-word matcher reproduces the retired regex, which
 *  finds "" at almost every boundary, and the substring test finds it everywhere,
 *  so one stored blank key activated its entry on every turn and a blank
 *  secondary key decided the entry's gate by itself. The matcher skips them;
 *  scanIndex.ts keeps its oracle parity for "". Both clients drop blank keys and
 *  production held none on 2026-09-29; the write paths are closed separately. */
function usableKeys(keys: readonly unknown[]): string[] {
  for (const key of keys) {
    if (typeof key !== "string" || key.trim() === "") return keys.filter((k): k is string => typeof k === "string" && k.trim() !== "");
  }
  return keys as string[];
}

export function matchesEntry(entry: LorebookEntry, buffer: string | ScanIndex, regexBudget = new RegexBudget()): MatchResult {
  const primaryKeys = usableKeys(entry.keys);
  const secondaryKeys = usableKeys(entry.keysSecondary);
  const empty: MatchResult = { matched: false, matchedKeys: [], matchedCount: 0, totalPrimaryKeys: primaryKeys.length };
  if (primaryKeys.length === 0) return empty;

  const index = typeof buffer === "string" ? new ScanIndex(buffer) : buffer;
  const opts = entry.matchOptions ?? {};
  const caseSensitive = opts.caseSensitive ?? false;
  const wholeWords = opts.matchWholeWords ?? true;

  const matchedPrimary = primaryKeys.filter(k => matchKey(k, index, caseSensitive, wholeWords, regexBudget) === true);
  if (matchedPrimary.length === 0) return empty;

  if (secondaryKeys.length === 0) {
    return { matched: true, matchedKeys: matchedPrimary, matchedCount: matchedPrimary.length, totalPrimaryKeys: primaryKeys.length };
  }

  const secondaryHits = secondaryKeys.map(k => matchKey(k, index, caseSensitive, wholeWords, regexBudget));
  let secondaryPass = false;
  switch (entry.selectiveLogic) {
    case "and_any": secondaryPass = secondaryHits.some(hit => hit === true); break;
    case "and_all": secondaryPass = secondaryHits.every(hit => hit === true); break;
    // A timeout is unknown, never evidence that a negative gate passed.
    case "not_all": secondaryPass = secondaryHits.some(hit => hit === false); break;
    case "not_any": secondaryPass = secondaryHits.every(hit => hit === false); break;
    default: secondaryPass = secondaryHits.some(hit => hit === true);
  }

  return { matched: secondaryPass, matchedKeys: matchedPrimary, matchedCount: matchedPrimary.length, totalPrimaryKeys: primaryKeys.length };
}

// Reject regex patterns with the classic catastrophic-backtracking shapes
// (quantified groups that themselves contain quantifiers, and backreferences).
// User-authored keys run against the full scan buffer for every entry on every
// turn in a single-process API. These cheap prefilters are conservative, not
// a proof; RegexBudget's independent watchdog enforces the execution bound.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*{][^)]*\)\s*[+*{?]/;
const BACKREFERENCE = /\\[1-9]/;
export function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length > 200) return false;
  if (NESTED_QUANTIFIER.test(pattern)) return false;
  if (BACKREFERENCE.test(pattern)) return false;
  return true;
}

function matchKey(key: string, index: ScanIndex, caseSensitive: boolean, wholeWords: boolean, regexBudget: RegexBudget): boolean | null {
  // Regex key: /pattern/flags
  if (key.startsWith("/")) {
    const lastSlash = key.lastIndexOf("/");
    if (lastSlash > 0) {
      const pattern = key.slice(1, lastSlash);
      // Dedupe flags: a key authored as /…/i plus our case-insensitive default
      // used to produce flags "ii" → SyntaxError → silently dead key.
      const rawFlags = key.slice(lastSlash + 1) + (caseSensitive ? "" : "i");
      const flags = [...new Set(rawFlags)].join("");
      if (!isSafeRegexPattern(pattern)) return regexBudget.reject(pattern, flags, "pattern exceeds the supported safety limits");
      // An invalid pattern or flag set is caught INSIDE the sandbox and reported
      // under `/${pattern}/${flags}`, so nothing here can throw (an unreachable
      // catch that would have filed the problem as `//pattern/flags/` is gone).
      return regexBudget.test(pattern, flags, index.textFor(caseSensitive));
    }
  }

  // Literal keys: lowercase the key exactly as before; the index lowercases the
  // window once. Whole-word matching is the tokenized lookup in scanIndex.ts.
  const searchKey = caseSensitive ? key : key.toLowerCase();
  if (wholeWords) return index.hasWholeWord(searchKey, caseSensitive);
  return index.includes(searchKey, caseSensitive);
}

// The retired whole-word matcher (in service 2026-09-02 → 2026-09-21).
// Unicode-aware: JS `\b` without the `u` flag is a boundary between
// [A-Za-z0-9_] and anything else, so a key whose first or last character is a
// non-ASCII letter ("José", "Élise", "Zoë") or punctuation ("Mr.") had NO
// boundary at that edge next to a space and could never match. ScanIndex now
// implements the identical boundary rule without a regex; this stays exported
// as the oracle for the scan-index tests and for one-off callers.
export function wholeWordRegex(literal: string, flags: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, `${flags}u`);
}
