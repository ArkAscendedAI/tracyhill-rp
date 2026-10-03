import { ARCHIVED_TAG, LOREBOOK_TAG_MAX_CHARS, THREADS_TAG } from "@tracyhill-rp/contracts";

/**
 * Tag hygiene for lorebook writes.
 *
 * Two tags carry lifecycle meaning and must never be chosen by a model or an
 * imported file: `threads` belongs to the thread tracker, which only touches
 * the ids in its own ledger (a stray `threads` row is frozen: the diff, the
 * consolidation pass and the audit refuse `threads` targets and archival
 * protects the tag, yet the row keeps activating by keyword), and `archived`
 * marks the compressed-trigger tier. Until this module only the rolling diff
 * enforced it (`sanitizeCreateTag` in rollingDiffWorker.ts); every machine or
 * import CREATE path now runs through `sanitizeCreateTag` below: the rolling
 * diff, the campaign audit and its ruling executor, the wizard and the lorebook
 * importer. Manual creates through the editor keep the owner's tag as typed.
 */
export const RESERVED_CREATE_TAGS: ReadonlySet<string> = new Set([THREADS_TAG, ARCHIVED_TAG]);

/** Where a reserved tag on a machine or import CREATE lands instead. */
export const RESERVED_TAG_FALLBACK = "events";

/**
 * A stored tag: trimmed, and null when blank or not text, so an empty string is
 * never stored (the tag picker once listed "" and the contract let it through).
 * A tag past the contract's LOREBOOK_TAG_MAX_CHARS is cut to it, so a machine
 * write can never create a row the editor's full-payload save would reject.
 * Case is kept as written.
 */
export function normalizeEntryTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  return trimmed.length > LOREBOOK_TAG_MAX_CHARS ? trimmed.slice(0, LOREBOOK_TAG_MAX_CHARS).trimEnd() : trimmed;
}

/** True for `threads` / `archived` in any case, surrounding whitespace ignored. */
export function isReservedCreateTag(tag: unknown): boolean {
  const normalized = normalizeEntryTag(tag);
  return normalized !== null && RESERVED_CREATE_TAGS.has(normalized.toLowerCase());
}

/**
 * The tag a machine-authored or imported CREATE lands with: normalized as
 * above, and a reserved lifecycle tag falls back to `events`. `retagged` is
 * true exactly when that fallback happened, so the caller can say so (a model
 * that emits a reserved tag is drifting; an imported file that carries one is
 * named in the import's errors). Same semantics as the rolling diff's original
 * `sanitizeCreateTag`, which now delegates here.
 */
export function sanitizeCreateTag(tag: unknown): { tag: string | null; retagged: boolean } {
  const normalized = normalizeEntryTag(tag);
  if (normalized === null) return { tag: null, retagged: false };
  if (RESERVED_CREATE_TAGS.has(normalized.toLowerCase())) return { tag: RESERVED_TAG_FALLBACK, retagged: true };
  return { tag: normalized, retagged: false };
}
