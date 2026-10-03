import { LOREBOOK_KNOWN_BY_MAX_NAMES, LOREBOOK_KNOWN_BY_NAME_MAX_CHARS } from "@tracyhill-rp/contracts";

/**
 * `knownBy` hygiene for every lorebook write.
 *
 * `knownBy` scopes an entry to the characters who know it: null or an empty list
 * is common knowledge, a list makes the entry narrator-only for any present
 * character not on it (contextRenderer.ts, names compared case-insensitively).
 * The contract had no bounds and the service and the rolling diff stored lists
 * as sent. Rules: trim every name, drop blank and non-text names, drop
 * case-insensitive repeats keeping the first spelling, cut a name past
 * LOREBOOK_KNOWN_BY_NAME_MAX_CHARS and keep the first LOREBOOK_KNOWN_BY_MAX_NAMES
 * names. Cutting never widens who may know an entry: a cut name still matches
 * nobody it did not match before, and a dropped surplus name only turns that
 * character into a non-knower (narrator-only for them), never the reverse. A list
 * that ends up empty is null, which the renderer already treats like `[]`.
 */
export interface NormalizedKnownBy {
  knownBy: string[] | null;
  /** Names cut to the length limit. */
  truncatedNames: number;
  /** Names past the list limit, left off. */
  droppedNames: number;
}

export function normalizeKnownBy(value: unknown): NormalizedKnownBy {
  const raw: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  let truncatedNames = 0;
  let droppedNames = 0;
  for (const item of raw) {
    if (typeof item !== "string") continue;
    let name = item.trim();
    if (!name) continue;
    if (name.length > LOREBOOK_KNOWN_BY_NAME_MAX_CHARS) { name = name.slice(0, LOREBOOK_KNOWN_BY_NAME_MAX_CHARS).trimEnd(); truncatedNames++; }
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    if (out.length >= LOREBOOK_KNOWN_BY_MAX_NAMES) { droppedNames++; continue; }
    out.push(name);
  }
  return { knownBy: out.length > 0 ? out : null, truncatedNames, droppedNames };
}
