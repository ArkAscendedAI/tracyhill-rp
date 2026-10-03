import { LOREBOOK_KEY_MAX_CHARS, LOREBOOK_MAX_KEYS } from "@tracyhill-rp/contracts";

/**
 * Key-list hygiene for every lorebook write.
 *
 * Before this module each writer did its own thing: the rolling diff merged with
 * a growth cap of 20, archival unioned, consolidation and the audit replaced the
 * list, the diff's CREATE stored the model's keys unfiltered, and only the HTTP
 * contracts knew LOREBOOK_MAX_KEYS. A worker could therefore store a list the
 * editor's full-payload save rejects, an empty key (which
 * matches almost any text), or a case-duplicate. `normalizeKeyList` is the one
 * rule for a list that is stored; `mergeKeyLists` is the one rule for adding
 * keys to a live list.
 *
 * Case: keys are deduplicated case-insensitively, keeping the first spelling.
 * The matcher lowercases both sides unless an entry opts into case-sensitive
 * matching, and scoring counts distinct lowercased keys, so for every entry
 * that matches case-insensitively (all of production on 2026-09-29) dropping a
 * case-duplicate changes nothing a turn sees.
 */

export interface NormalizedKeys {
  /** The list to store. */
  keys: string[];
  /** True when the count cap bound; `overCap` holds what it left off. */
  capped: boolean;
  /** Distinct keys left off by the count cap, in input order. */
  overCap: string[];
  /** Keys longer than the per-key limit, left off (no editor save could carry them). */
  overLong: string[];
}

export interface KeyListOptions {
  /** List cap. Default LOREBOOK_MAX_KEYS, the number the contracts enforce. */
  max?: number;
  /** Per-key length limit after trimming. Default LOREBOOK_KEY_MAX_CHARS. */
  maxKeyChars?: number;
}

/** Parse a stored key column (JSON text) into its string members; malformed or non-array text yields []. */
export function parseStoredKeys(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function toKeyArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    // A stored JSON column; anything that does not parse to an array is one
    // bare key (a model that wrote `"keys": "Ryn"`, or a key like "[Redacted]").
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON: a bare key */ }
    return [value];
  }
  return [];
}

/**
 * The one key list rule for a stored list: trim every key, drop empty and
 * non-text keys, drop keys over the per-key limit (reported in `overLong`),
 * drop case-insensitive repeats keeping the first spelling, and cap the list at
 * `max` (reported: `capped` and `overCap`). Accepts an array, a stored JSON
 * column or a single key string.
 */
export function normalizeKeyList(keys: unknown, options: KeyListOptions = {}): NormalizedKeys {
  const max = options.max ?? LOREBOOK_MAX_KEYS;
  const maxKeyChars = options.maxKeyChars ?? LOREBOOK_KEY_MAX_CHARS;
  const out: string[] = [];
  const overCap: string[] = [];
  const overLong: string[] = [];
  const seen = new Set<string>();
  for (const raw of toKeyArray(keys)) {
    if (typeof raw !== "string") continue;
    const key = raw.trim();
    if (!key) continue;
    if (key.length > maxKeyChars) { overLong.push(key); continue; }
    const folded = key.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    if (out.length >= max) { overCap.push(key); continue; }
    out.push(key);
  }
  return { keys: out, capped: overCap.length > 0, overCap, overLong };
}

export interface MergedKeys extends NormalizedKeys {
  /** Keys this merge appended (new to the list), in order. */
  added: string[];
  /** Proposed keys refused by the growth cap, in order. */
  overGrowth: string[];
  /** Which cap bound: the merge's growth cap, the list cap, or neither. */
  cappedBy: "growth" | "max" | null;
  /** True when the list to store differs from `existing` as given (additions, or a normalized live list). */
  changed: boolean;
}

export interface MergeKeyOptions {
  /** List cap. Default LOREBOOK_MAX_KEYS, the number the contracts enforce. */
  max?: number;
  /**
   * Per-key length limit for the PROPOSED keys only (the rolling diff refuses
   * synonyms of 60+ characters). The live list keeps every key the contract
   * allows (LOREBOOK_KEY_MAX_CHARS): a merge never drops a curated long key.
   * Values above LOREBOOK_KEY_MAX_CHARS are clamped to it.
   */
  maxKeyChars?: number;
  /**
   * Additions stop once the list holds this many keys. Existing keys past it
   * are never dropped: it caps growth, not the list (the rolling diff's synonym
   * cap of 20). Default: no growth cap.
   */
  growthCap?: number;
}

/**
 * Merge proposed keys onto an entry's live list. The live list is normalized
 * first (the contract's per-key limit, never `maxKeyChars`) and keeps its order
 * and spelling; each proposed key that is new to it (case-insensitive) and
 * within `maxKeyChars` is appended while the growth cap allows; the result never
 * exceeds `max` (LOREBOOK_MAX_KEYS). Every cap that binds is reported so the
 * caller can name it in its run details. `existing` and `proposed` accept an
 * array, a stored JSON column or a single key string.
 */
export function mergeKeyLists(existing: unknown, proposed: unknown, options: MergeKeyOptions = {}): MergedKeys {
  const max = options.max ?? LOREBOOK_MAX_KEYS;
  // The per-key limit of the proposal; the live list is held to the contract's
  // own limit only (applying a synonym limit to the live list would drop curated
  // 60-500-character keys on the next merge).
  const maxKeyChars = Math.min(options.maxKeyChars ?? LOREBOOK_KEY_MAX_CHARS, LOREBOOK_KEY_MAX_CHARS);
  const live = normalizeKeyList(existing, { max, maxKeyChars: LOREBOOK_KEY_MAX_CHARS });
  const keys = [...live.keys];
  const seen = new Set(keys.map((k) => k.toLowerCase()));
  // Keys the live list already dropped (over the list cap) are not "new": a
  // merge must not re-add a key it could not keep.
  for (const k of live.overCap) seen.add(k.toLowerCase());
  const added: string[] = [];
  const overGrowth: string[] = [];
  const overCap = [...live.overCap];
  const overLong = [...live.overLong];
  const growthCap = options.growthCap;
  for (const raw of toKeyArray(proposed)) {
    if (typeof raw !== "string") continue;
    const key = raw.trim();
    if (!key) continue;
    if (key.length > maxKeyChars) { overLong.push(key); continue; }
    const folded = key.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    if (growthCap !== undefined && keys.length >= growthCap) { overGrowth.push(key); continue; }
    if (keys.length >= max) { overCap.push(key); continue; }
    keys.push(key);
    added.push(key);
  }
  const before = toKeyArray(existing);
  const changed = keys.length !== before.length || keys.some((k, i) => k !== before[i]);
  const cappedBy = overCap.length > 0 ? "max" : overGrowth.length > 0 ? "growth" : null;
  return { keys, capped: overCap.length > 0, overCap, overLong, added, overGrowth, cappedBy, changed };
}
