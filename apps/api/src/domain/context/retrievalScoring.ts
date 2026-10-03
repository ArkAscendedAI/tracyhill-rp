// Retrieval scoring — the CPU-bound part of per-turn context assembly, as one
// pure, serializable job: keyword activation (with recursion and the fresh
// bonus), the cold-keyword remap of compressed triggers, and the scene-present
// character match. It has no database, network or logger dependency so it can
// run on a worker thread (retrievalScoringPool.ts) or inline; either way the
// engine gets identical data back and does the DB-facing bookkeeping itself.
//
// Why: until 2026-09-21 this work ran synchronously on the API's single event
// loop — 6 s per turn on one long campaign, 80–320 s on the larger books — and every
// other request from the browser (session switch, coding panels, polls) queued
// behind it.
import type { LorebookEntry } from "@tracyhill-rp/contracts";
import { PresenceResolver, type PresenceResolution } from "./characterPresence";
import { RegexBudget } from "./regexBudget";
import { ScanIndex } from "./scanIndex";
import { runKeywordActivation, matchesEntry, type FreshBuffers } from "./keywordActivator";

export interface ActivationStateRow { stickyRemaining: number; cooldownRemaining: number; lastActivatedTurn: number | null }
export interface ActivationDeltaRow { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }

/** Everything the scoring phase needs, as plain data (structured-clone safe). */
export interface RetrievalScoringJob {
  /** Enabled, non-sealed entries minus the session's disabled ids — full objects; recursion reads their content. */
  entries: LorebookEntry[];
  activationState: Array<[string, ActivationStateRow]>;
  /** The global-depth scan window (scanDepth×2 prior messages + the current turn). */
  scanBuffer: string;
  /** Windows for every distinct per-entry scanDepth in `entries` (the global depth included). */
  buffersByDepth: Array<[number, string]>;
  globalScanDepth: number;
  turnNumber: number;
  maxRecursion: number;
  playerCharacterKeys: string[];
  /** Pure semantic mode: constants/sticky/cooldown only, no keyword matching. */
  skipKeywordScan: boolean;
  fresh: FreshBuffers;
  /** Disabled source rows of compressed triggers, in repository order (cold-keyword remap). Empty when the keyword scan is off. */
  coldEntries: LorebookEntry[];
  coldToCompressed: Array<[string, string]>;
  /** Trimmed, non-empty scene-present character names. */
  presentNames: string[];
  /** Trimmed, non-empty present-unaware names, in the scene's list order, none of
   *  them also in presentNames. Their `characters`
   *  entries are matched per name so the engine can force their cores under its
   *  cap; they never take part in knownBy routing. Optional: a job without it
   *  matches none. */
  unawareNames?: string[];
}

export interface RetrievalScoringResult {
  /** Keyword-pass activations in the engine's historical order: constants, sticky carry-forward, keyword hits by pass. */
  activated: Array<{ entryId: string; score: number; source: "constant" | "sticky" | "keyword" }>;
  activationDelta: Array<[string, ActivationDeltaRow]>;
  /** Compressed triggers fired by one of their cold source entries' keys — deduped, in cold-row order. */
  coldParentIds: string[];
  /** `characters` entries matching a scene-present name. */
  scenePresentEntryIds: string[];
  /** How each present and present-unaware name resolved (characterPresence.ts): tier, entries, candidates. The
   *  engine turns the unresolved and ambiguous ones into context notes. */
  presence?: PresenceResolution[];
  /** Per present-unaware name, in list order: the `characters` entries it matches
   *  that no present name already matched. The engine applies the cap. */
  unawareEntryIds: Array<[string, string[]]>;
  /** Regex keys that could not be evaluated safely (pattern → reason). */
  regexProblems: Array<[string, string]>;
  timings: { keywordMs: number; coldMs: number; presentMs: number };
}

export function executeRetrievalScoring(job: RetrievalScoringJob): RetrievalScoringResult {
  const activationState = new Map(job.activationState);
  const buffersByDepth = new Map(job.buffersByDepth);
  const scanBufferForDepth = (depth: number): string => buffersByDepth.get(depth) ?? job.scanBuffer;
  const regexBudget = new RegexBudget();

  const t0 = performance.now();
  const keyword = runKeywordActivation(
    job.entries, activationState, job.scanBuffer, job.turnNumber, job.maxRecursion, job.playerCharacterKeys,
    job.skipKeywordScan, job.globalScanDepth, scanBufferForDepth, job.fresh, regexBudget,
  );
  const t1 = performance.now();
  const activated = [...keyword.activated.values()].map(hit => ({ entryId: hit.entry.id, score: hit.score, source: hit.source }));

  // Cold keyword remap: disabled source entries' keywords can trigger their parent
  // compressed trigger. Runs against the global window only (no recursion text),
  // exactly as the engine did inline.
  const coldParentIds: string[] = [];
  if (!job.skipKeywordScan && job.coldEntries.length > 0) {
    const coldToCompressed = new Map(job.coldToCompressed);
    const already = new Set(activated.map(a => a.entryId));
    const index = new ScanIndex(job.scanBuffer);
    for (const cold of job.coldEntries) {
      const parentId = coldToCompressed.get(cold.id);
      if (!parentId || already.has(parentId)) continue;
      if (matchesEntry(cold, index, regexBudget).matched) {
        coldParentIds.push(parentId);
        already.add(parentId);
      }
    }
  }
  const t2 = performance.now();

  // Scene-present character firmware: the entries that ARE the characters physically in the scene
  // must always be loaded, regardless of activation score. Resolved person by person (characterPresence.ts,
  // 2026-09-29): an entry that only mentions a present character, or carries their name as a key, is not
  // theirs and keeps competing on its own score.
  const presence: PresenceResolution[] = [];
  const resolver = job.presentNames.length > 0 || (job.unawareNames?.length ?? 0) > 0
    ? new PresenceResolver(job.entries, { playerNames: job.playerCharacterKeys })
    : null;
  const scenePresentEntryIds: string[] = [];
  if (resolver && job.presentNames.length > 0) {
    const resolved = resolver.resolveAll(job.presentNames, job.scanBuffer);
    scenePresentEntryIds.push(...resolved.entryIds);
    presence.push(...resolved.resolutions);
  }
  // Present-unaware characters (asleep, unconscious, overhearing) are in the
  // scene too, so their cores get the same guarantee. Resolved per name,
  // in list order, with the same resolver; only the names the caller passed are
  // read (never NOT PRESENT or the roster).
  const unawareEntryIds: Array<[string, string[]]> = [];
  if (resolver && job.unawareNames?.length) {
    const alreadyPresent = new Set(scenePresentEntryIds);
    for (const name of job.unawareNames) {
      const resolution = resolver.resolve(name, job.scanBuffer);
      presence.push(resolution);
      unawareEntryIds.push([name, resolution.entryIds.filter((id) => !alreadyPresent.has(id))]);
    }
  }
  const t3 = performance.now();

  return {
    activated,
    activationDelta: [...keyword.activationDelta.entries()],
    coldParentIds,
    scenePresentEntryIds,
    unawareEntryIds,
    presence,
    regexProblems: [...regexBudget.problems.entries()],
    timings: { keywordMs: t1 - t0, coldMs: t2 - t1, presentMs: t3 - t2 },
  };
}

