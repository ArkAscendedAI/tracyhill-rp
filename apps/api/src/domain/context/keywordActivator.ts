import type { LorebookEntry } from "@tracyhill-rp/contracts";

interface ActivationState {
  stickyRemaining: number;
  cooldownRemaining: number;
  lastActivatedTurn: number | null;
}

export interface KeywordActivationResult {
  activated: Map<string, { entry: LorebookEntry; score: number; source: "constant" | "sticky" | "keyword" }>;
  activationDelta: Map<string, Partial<ActivationState>>;
}

export function runKeywordActivation(
  entries: LorebookEntry[],
  activationState: Map<string, ActivationState>,
  scanBuffer: string,
  turnNumber: number,
  maxRecursion = 3,
  playerCharacterKeys: string[] = [],
): KeywordActivationResult {
  const activated = new Map<string, { entry: LorebookEntry; score: number; source: "constant" | "sticky" | "keyword" }>();
  const activationDelta = new Map<string, Partial<ActivationState>>();
  let buffer = scanBuffer;
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

  // 3. Keyword scan with recursion
  const probabilityRolls = new Map<string, boolean>();
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

      // Recursion-specific checks. delayUntilRecursion = entry may only
      // activate via recursion (other entries' content), never from the raw
      // chat buffer — the old check lived inside the depth>0 branch with an
      // unsatisfiable condition, making the flag a no-op.
      if (entry.delayUntilRecursion && recursionDepth === 0) continue;
      if (recursionDepth > 0 && entry.excludeRecursion) continue;
      if (entry.preventRecursion && recursionDepth > 0) continue;

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

      const match = matchesEntry(entry, buffer);
      if (match.matched) {
        const precisionBonus = Math.round((match.matchedCount / Math.max(match.totalPrimaryKeys, 1)) * 100);
        const countBonus = Math.min(match.matchedCount * 15, 75);
        let pcPenalty = 0;
        if (pcKeySet.size > 0 && match.matchedCount > 0) {
          const allPC = match.matchedKeys.every(k => pcKeySet.has(k.toLowerCase()));
          if (allPC) pcPenalty = 200;
        }
        const turnsSince = state?.lastActivatedTurn != null ? Math.max(0, turnNumber - state.lastActivatedTurn) : Infinity;
        const recencyBoost = Math.max(0, 50 - turnsSince);
        const score = 800 + precisionBonus + countBonus - pcPenalty - recursionDepth * 100 + recencyBoost;
        activated.set(entry.id, { entry, score, source: "keyword" });
        newActivations = true;

        const delta: Partial<ActivationState> = { lastActivatedTurn: turnNumber };
        if (entry.sticky > 0) delta.stickyRemaining = entry.sticky;
        if (entry.cooldown > 0) delta.cooldownRemaining = entry.cooldown;
        activationDelta.set(entry.id, delta);
      }
    }

    // Append newly activated entry content to buffer for recursive scan
    if (newActivations && recursionDepth < maxRecursion) {
      for (const [id, hit] of activated) {
        if (hit.source === "keyword" && !buffer.includes(hit.entry.content.slice(0, 100))) {
          buffer += "\n" + hit.entry.content;
        }
      }
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

export function matchesEntry(entry: LorebookEntry, buffer: string): MatchResult {
  const primaryKeys = entry.keys;
  const secondaryKeys = entry.keysSecondary;
  const empty: MatchResult = { matched: false, matchedKeys: [], matchedCount: 0, totalPrimaryKeys: primaryKeys.length };
  if (primaryKeys.length === 0) return empty;

  const opts = entry.matchOptions ?? {};
  const caseSensitive = opts.caseSensitive ?? false;
  const wholeWords = opts.matchWholeWords ?? true;
  const searchBuffer = caseSensitive ? buffer : buffer.toLowerCase();

  const matchedPrimary = primaryKeys.filter(k => matchKey(k, searchBuffer, caseSensitive, wholeWords));
  if (matchedPrimary.length === 0) return empty;

  if (secondaryKeys.length === 0) {
    return { matched: true, matchedKeys: matchedPrimary, matchedCount: matchedPrimary.length, totalPrimaryKeys: primaryKeys.length };
  }

  const secondaryHits = secondaryKeys.filter(k => matchKey(k, searchBuffer, caseSensitive, wholeWords));
  let secondaryPass = false;
  switch (entry.selectiveLogic) {
    case "and_any": secondaryPass = secondaryHits.length > 0; break;
    case "and_all": secondaryPass = secondaryHits.length === secondaryKeys.length; break;
    case "not_all": secondaryPass = secondaryHits.length < secondaryKeys.length; break;
    case "not_any": secondaryPass = secondaryHits.length === 0; break;
    default: secondaryPass = secondaryHits.length > 0;
  }

  return { matched: secondaryPass, matchedKeys: matchedPrimary, matchedCount: matchedPrimary.length, totalPrimaryKeys: primaryKeys.length };
}

// Reject regex patterns with the classic catastrophic-backtracking shapes
// (quantified groups that themselves contain quantifiers, and backreferences).
// User-authored keys run against the full scan buffer for every entry on every
// turn in a single-process API — one pathological pattern would freeze ALL
// users' streams. Heuristic, not a proof; combined with a length cap.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*{][^)]*\)\s*[+*{?]/;
const BACKREFERENCE = /\\[1-9]/;
export function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length > 200) return false;
  if (NESTED_QUANTIFIER.test(pattern)) return false;
  if (BACKREFERENCE.test(pattern)) return false;
  return true;
}

function matchKey(key: string, buffer: string, caseSensitive: boolean, wholeWords: boolean): boolean {
  // Regex key: /pattern/flags
  if (key.startsWith("/")) {
    const lastSlash = key.lastIndexOf("/");
    if (lastSlash > 0) {
      try {
        const pattern = key.slice(1, lastSlash);
        if (!isSafeRegexPattern(pattern)) return false;
        // Dedupe flags: a key authored as /…/i plus our case-insensitive default
        // used to produce flags "ii" → SyntaxError → silently dead key.
        const rawFlags = key.slice(lastSlash + 1) + (caseSensitive ? "" : "i");
        const flags = [...new Set(rawFlags)].join("");
        return new RegExp(pattern, flags).test(buffer);
      } catch { return false; }
    }
  }

  const searchKey = caseSensitive ? key : key.toLowerCase();
  if (wholeWords) {
    const escaped = searchKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, caseSensitive ? "" : "i").test(buffer);
  }
  return buffer.includes(searchKey);
}
