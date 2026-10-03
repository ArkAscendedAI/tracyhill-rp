import { isArchiveTrigger } from "../../../api/src/domain/context/archiveTriggers";
import { parseOffscreenMarker } from "../../../api/src/domain/world/offscreen";
import type { HeldOpReason } from "./heldOps";

/** The workers that apply a model-proposed DISABLE. */
export type DisablingWorker = "rolling_diff" | "campaign_audit";

export interface DisableTarget {
  tag: string | null;
  comment: string | null;
  isConstant: number;
  compressedRefIds: string | null;
}

/**
 * The one predicate that decides a worker DISABLE: null when the worker may
 * disable the entry, otherwise the
 * held-op reason (heldOps.ts) the op is held under.
 *
 * Every worker: constants (the Thread Index) and `threads` entries belong to
 * the tracker; an archive trigger (non-empty `compressedRefIds`) is the only
 * way back into context for the cold rows it lists, so disabling it strands
 * them. A writer that wants one gone re-parents its cold rows onto a
 * surviving trigger in the same transaction
 * (`LorebookRepository.reparentArchiveTrigger`); neither the diff nor the audit
 * has such a trigger to hand, so they hold the op.
 *
 * Rolling diff: only `events` entries and
 * offscreen entries (a comment carrying the offscreen marker, provisional or
 * confirmed) may be disabled. Anything else (characters, locations, factions,
 * lore, rules, untagged rows) is held as `protected-tag` for hand curation; the
 * prompt's "never disable persistent world-building" rule had no code behind
 * it. The campaign audit keeps its refute-first DISABLE for those tags.
 */
export function workerDisableRefusal(entry: DisableTarget, worker: DisablingWorker): HeldOpReason | null {
  if (entry.isConstant) return "constant";
  const tag = (entry.tag ?? "").trim().toLowerCase();
  if (tag === "threads") return "thread";
  if (isArchiveTrigger(entry)) return "archive-trigger";
  if (worker === "rolling_diff" && tag !== "events" && !parseOffscreenMarker(entry.comment)) return "protected-tag";
  return null;
}
