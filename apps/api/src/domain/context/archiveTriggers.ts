/**
 * Archive triggers.
 *
 * The archival worker compresses stale entries into one trigger entry whose
 * `compressed_ref_ids` lists the source rows it disabled ("cold rows"). The
 * trigger is the cold rows' way back into context: when it activates, the
 * engine replaces it with the full cold rows (its own synopsis is never
 * injected), and the cold rows' keys and vectors remap to it. A disabled
 * trigger therefore strands its cold rows: disabled rows nobody points at, no
 * keyword remap, no inflation, no signal (measured 2026-09-28: 43 disabled
 * triggers stranding 157 cold rows on one campaign).
 *
 * Rule for every worker: no writer disables or merges away an archive
 * trigger unless its cold rows are re-parented onto a surviving trigger in the
 * same transaction (`LorebookRepository.reparentArchiveTrigger`); otherwise the
 * op is held with reason `archive-trigger`. A trigger is recognized by its
 * non-empty `compressedRefIds`, never by its tag (a tag can be edited).
 */

/** The cold row ids an entry's `compressedRefIds` names: stored JSON text or an
 *  array; malformed, null or non-array values yield []. Non-text members and
 *  blanks are dropped; order is kept and repeats are removed. */
export function parseCompressedRefIds(value: unknown): string[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    try { raw = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** True when the entry is an archive trigger: its `compressedRefIds` names at
 *  least one cold row. Accepts a database row (JSON text) or a contract entry
 *  (array). */
export function isArchiveTrigger(entry: { compressedRefIds?: unknown } | null | undefined): boolean {
  if (!entry) return false;
  return parseCompressedRefIds(entry.compressedRefIds).length > 0;
}

/** Why a re-parent could not run; the caller holds its op with reason `archive-trigger`. */
export type ReparentRefusal =
  | "missing"
  | "same-entry"
  | "other-campaign"
  | "not-a-trigger"
  | "target-not-a-trigger"
  | "target-disabled";

export type ReparentArchiveTriggerResult =
  | { ok: true; fromId: string; toId: string; moved: string[] }
  | { ok: false; reason: ReparentRefusal; detail: string };
