import { DEFAULT_EMBEDDING_MODEL, getConfiguredDefaultModelId } from "@tracyhill-rp/model-catalog";
import { describePresence } from "./characterPresence";
import { listActiveOffscreen } from "../world/offscreen";
import { CONTEXT_DEFAULT_MODEL_DIALS, CONTEXT_MODEL_ID_DIALS, CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS, type ContextSettings, type ContextPreviewEntry, type LorebookEntry } from "@tracyhill-rp/contracts";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import type { ResearcherUsage } from "./researcherActivator";
import type { HyDEUsage } from "./hydeQuery";

import type { LorebookRepository } from "./lorebookRepository";

import type { LorebookEmbeddingRepository } from "./lorebookEmbeddingRepository";
import type { EmbeddingService } from "./embeddingService";
import { defaultRetrievalScoringPool, type RetrievalScoringPool } from "./retrievalScoringPool";
import { runSemanticActivation } from "./semanticActivator";
import { runResearcherActivation } from "./researcherActivator";
import { generateHyDEQuery } from "./hydeQuery";
import { recordSystemEvent } from "../system/systemEvents";
import { pruneByBudget, type ScoredCandidate } from "./budgetPruner";
import { applyTrackerFreshnessHedge } from "./trackerFreshness";
import { renderRetrievedContext } from "./contextRenderer";
import { retrievalRuns } from "./retrievalMode";

// Built per call (not module-level) so the DEFAULT_MODEL_ID deployment override
// is honored at resolution time and stays testable. The override replaces every
// chat-model dial default; embedding + hydeModel (inherits researcherModel at
// call time) keep their shipped behavior. Session values always win.
//
// SINGLE-SOURCED (2026-09-02): the dial values come from the contracts'
// CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS (= the Zod defaults). This function used
// to carry its own literal table, and the two drifted — retrievalBudgetTokens
// resolved 16,000 here while the contract (and every client panel) said 4,000.
// Only the deployment-override layering for chat-model dials lives here now,
// and the dials it layers are the contract's CONTEXT_DEFAULT_MODEL_DIALS: the
// web Engine dialog applies the same list to show the same
// defaults, so neither side hand-copies it any more.
function buildDefaults(): ContextSettings {
  const configuredDefault = getConfiguredDefaultModelId();
  const defaults: ContextSettings = {
    ...CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS,
    // The frozen object shares its array instances; hand out fresh ones.
    disabledEntryIds: [...CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS.disabledEntryIds],
    playerCharacterKeys: [...CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS.playerCharacterKeys],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
  };
  if (configuredDefault) for (const dial of CONTEXT_DEFAULT_MODEL_DIALS) defaults[dial] = configuredDefault;
  return defaults;
}

export interface ContextAssemblyResult {
  retrievedSection: string | null;
  preview: ContextPreviewEntry[];
  debug: {
    keywordHits: number;
    semanticHits: number;
    researcherHits: number;
    absentContacts: number;
    coldInflations: number;
    droppedForBudget: number;
    totalTokens: number;
  };
  activationDelta: Map<string, { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }>;
  researcherUsage: ResearcherUsage | null;
  /** HyDE query-expansion call (semantic/hybrid, every user turn). Returned so
   *  chatService can account it as overhead beside the researcher — it was
   *  captured and thrown away for four months. */
  hydeUsage: HyDEUsage | null;
  /** Degradation warnings (e.g. "semantic retrieval failed — keyword-only this turn"). Surfaced in the context preview. */
  notes: string[];
  /** Informational notes for the turn's context information (the scene-presence note, characterPresence.ts). */
  infoNotes?: string[];
}

// A user Stop during assembly (2026-09-04): the chat turn's abort signal reaches
// every network phase (HyDE, the embedding query, the researcher) and is checked
// between phases, so the pre-stream wait ends inside the current in-flight call
// instead of after all of them. Thrown as an AbortError so chatService can tell
// a stop from a retrieval failure and record nothing.
/** At most this many present-unaware cores are forced per turn,
 *  in the scene's list order; past it the rest compete for the budget and the
 *  turn's context note names them. NOT PRESENT must never be forced in: that list
 *  tends to be long, and forcing it would be a catastrophic bug. The guarantee reads only the names the
 *  caller passes as present-unaware; this cap bounds even a long one. */
export const UNAWARE_CORE_CAP = 6;

function throwIfAssemblyStopped(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const error = new Error("context assembly stopped by the user");
  error.name = "AbortError";
  throw error;
}

export class ContextEngine {
  constructor(
    private readonly lorebook: LorebookRepository,
    private readonly embeddingRepo: LorebookEmbeddingRepository,
    private readonly embeddingService: EmbeddingService,
    private readonly runtimeForUser: ((userId: string) => ChatRuntime | null) | null,
    // Where the CPU-bound scoring phase runs (worker thread by default; see
    // retrievalScoringPool.ts). createApp passes the env-configured pool.
    private readonly scoring: RetrievalScoringPool = defaultRetrievalScoringPool,
  ) {}

  /** Offscreen-flow (2026-07-17): the active offscreen ledger for the per-turn
   *  NPC offscreen-memory block. Thin delegation so chatService needs no direct
   *  lorebook dependency. */
  listActiveOffscreen(userId: string, campaignId: string) {
    return listActiveOffscreen(this.lorebook, userId, campaignId);
  }

  isEnabled(session: { contextOverridesJson?: string | null }): boolean {
    return retrievalRuns(this.resolveSettings(session));
  }

  /** Settings are PER-SESSION, full stop. The Engine panel is the only surface that
   *  writes them and this is the only place they resolve.
   *
   *  There is deliberately NO campaign parameter. Campaign-scoped settings were
   *  retired by migration 0077, which folds them down into every session first so
   *  dropping the merge here is behaviour-preserving. A second scope is what let
   *  `playerCharacterKeys` be readable only from campaign defaults while its only
   *  editor sat in the campaign panel — invisible to the Engine panel, so it stayed
   *  at its `[]` default and the PC-exclusion guard never fired once — and let
   *  `npcAgendaEnabled` exist at both scopes with conflicting values on the same
   *  campaign. Do NOT reintroduce a campaign argument: a dial that cannot be seen
   *  where every other dial lives is a dial nobody can set. */
  resolveSettings(session: { contextOverridesJson?: string | null }): ContextSettings {
    const sessionOverrides = session.contextOverridesJson ? safeParseJson<Partial<ContextSettings>>(session.contextOverridesJson, {}) : {};
    // A blank model id means inherit. The contract normalizes
    // every NEW write; this covers overrides stored before it — the Android
    // sheet wrote hydeModel "" on every save, and `""` is not `??`-absent.
    if (sessionOverrides && typeof sessionOverrides === "object") {
      const raw = sessionOverrides as Record<string, unknown>;
      for (const dial of CONTEXT_MODEL_ID_DIALS) {
        if (typeof raw[dial] === "string" && (raw[dial] as string).trim() === "") delete raw[dial];
      }
    }
    const settings = { ...buildDefaults(), ...sessionOverrides };
    // Stored 0s predate the contract floor: 0 meant "whole history"
    // through the slice(-0) bug, never "current turn only". Clamp like the schema.
    settings.scanDepth = Math.max(1, Number.isFinite(settings.scanDepth) ? settings.scanDepth : 1);
    return settings;
  }

  async assembleForTurn(input: {
    userId: string;
    session: { id: string; contextOverridesJson?: string | null };
    campaign: { id: string };
    history: Array<{ role: string; content: string }>;
    userTurnText: string;
    dryRun: boolean;
    /** Characters present and aware: the scene-present guarantee AND knownBy routing. */
    presentCharacters?: string[];
    /** Characters present but unaware (asleep, unconscious, overhearing): their
     *  cores get the scene-present guarantee (capped, UNAWARE_CORE_CAP) and they
     *  never count as knowers in the renderer.
     *  Callers pass the session's present-unaware list only, through
     *  normalizePresentNames; never NOT PRESENT, the roster or its complement. */
    presentUnawareCharacters?: string[];
    /** false skips every network phase: HyDE, the query embedding and the
     *  researcher (the dry-run preview's "no network" mode). Default true. */
    network?: boolean;
    /** The chat turn's abort signal — see throwIfAssemblyStopped. Optional so the
     *  dry-run preview route and tools can call without one. */
    signal?: AbortSignal;
  }): Promise<ContextAssemblyResult> {
    const settings = this.resolveSettings(input.session);
    throwIfAssemblyStopped(input.signal);
    if (settings.mode === "off") {
      return { retrievedSection: null, preview: [], debug: { keywordHits: 0, semanticHits: 0, researcherHits: 0, absentContacts: 0, coldInflations: 0, droppedForBudget: 0, totalTokens: 0 }, activationDelta: new Map(), researcherUsage: null, hydeUsage: null, notes: [] };
    }

    // Load entries
    const campaignEntries = this.lorebook.listEnabledForCampaign(input.userId, input.campaign.id);
    const globalEntries = this.lorebook.listGlobalsForUser(input.userId);
    const allEntries: LorebookEntry[] = [...campaignEntries, ...globalEntries].map(toLorebookEntry);

    // Filter out per-session disabled entries
    const disabledSet = new Set(settings.disabledEntryIds);
    const entries = allEntries.filter(e => !disabledSet.has(e.id));

    // Build cold→compressed remap: cold entry embeddings can trigger their compressed parent
    const coldToCompressed = new Map<string, string>();
    const compressedEntryIds = new Set<string>();
    for (const e of entries) {
      if (e.compressedRefIds && e.compressedRefIds.length > 0) {
        compressedEntryIds.add(e.id);
        for (const coldId of e.compressedRefIds) coldToCompressed.set(coldId, e.id);
      }
    }

    // Build scan buffer from last N messages. The live chat path passes the
    // current user turn BOTH as the tail of `history` (it's already persisted)
    // and as `userTurnText`, while the preview route passes it only as
    // `userTurnText`. Dropping a trailing history entry that duplicates
    // userTurnText removes the live double-count and makes the live scan window
    // (scanDepth*2 priors + this turn) match the preview exactly — so the
    // preview no longer shows activations the real turn won't fire.
    const priorHistory = (() => {
      const last = input.history[input.history.length - 1];
      if (last && last.role === "user" && last.content === input.userTurnText) {
        return input.history.slice(0, -1);
      }
      return input.history;
    })();
    // Per-entry scanDepth override: the knob was stored/imported/
    // sortable but never consulted. Entries whose scanDepth differs from the
    // global get a buffer built for their own depth (cached per depth). The
    // global buffer is built through the SAME helper: the old separate
    // `priorHistory.slice(-settings.scanDepth * 2)` had no depth-0 guard, and
    // `slice(-0)` returns the whole history — Scan = 0 scanned every message
    // in the session and flooded the budget with every keyword entry ever named.
    const depthBufferCache = new Map<number, string>();
    const scanBufferForDepth = (depth: number): string => {
      let buf = depthBufferCache.get(depth);
      if (buf === undefined) {
        // depth 0 = scan only the current user turn (slice(-0) would return the
        // WHOLE history, so guard it).
        const msgs = depth > 0 ? priorHistory.slice(-depth * 2) : [];
        buf = msgs.map(m => m.content).join("\n") + "\n" + input.userTurnText;
        depthBufferCache.set(depth, buf);
      }
      return buf;
    };
    const scanBuffer = scanBufferForDepth(settings.scanDepth);
    // Fresh-relevance buffers (2026-09-02): the player's current
    // message and the reply it answers are matched separately from the window,
    // so a key named NOW outranks the same key mentioned eight messages ago.
    const lastAssistantText = [...priorHistory].reverse().find(m => m.role === "assistant")?.content ?? "";
    const freshBuffers = { userTurn: input.userTurnText, lastAssistant: lastAssistantText };

    // Load activation state
    const rawState = this.lorebook.getActivationState(input.session.id);
    const activationState = new Map(rawState.map(s => [s.entryId, { stickyRemaining: s.stickyRemaining, cooldownRemaining: s.cooldownRemaining, lastActivatedTurn: s.lastActivatedTurn }]));

    const turnNumber = Math.floor(input.history.length / 2) + 1;
    const candidates: ScoredCandidate[] = [];
    let keywordHits = 0, semanticHits = 0, researcherHits = 0;

    // Keyword activation. runKeywordActivation is the ONLY path that injects
    // CONSTANT entries (incl. the always-in-context thread index), carries STICKY
    // forward, and decrements COOLDOWN — so it must run in pure `semantic` mode
    // too, with the keyword-matching phase suppressed. Otherwise semantic mode
    // silently dropped constants/sticky and permanently blocked any cooled-down
    // entry (cooldown never ticked down).
    const activationDelta = new Map<string, { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }>();
    const keywordScanActive = settings.mode === "keyword" || settings.mode === "hybrid";
    const semanticActive = settings.mode === "semantic" || settings.mode === "hybrid";
    // HyDE query expansion is a network call; start it BEFORE the synchronous
    // keyword pass so the two genuinely overlap (the old code created and
    // awaited the promise back-to-back inside the semantic block while claiming
    // to run "in parallel with keyword"). generateHyDEQuery never rejects — it
    // records its own failure event and resolves { hypothesis: null }.
    const networkPhases = input.network !== false;
    const hydeRuntime = networkPhases && semanticActive && settings.hydeEnabled !== false && this.runtimeForUser ? this.runtimeForUser(input.userId) : null;
    // HyDE reads the deduped `priorHistory`: on a live turn the raw
    // history ends with the current user message, so HyDE saw it twice — once
    // in <recent_messages>, once as <current_user_turn> — while the preview
    // route (history without the pending turn) showed it the two messages
    // before. Now both paths hand HyDE the same window: the two messages
    // preceding the current turn, then the turn itself.
    const hydePromise = hydeRuntime
      ? generateHyDEQuery(hydeRuntime, settings.hydeModel ?? settings.researcherModel, input.userTurnText, priorHistory, input.userId, input.signal, settings.openaiFastModeEnabled)
      : Promise.resolve({ hypothesis: null, usage: null });
    let hydeUsage: HyDEUsage | null = null;
    // Keyword activation, the cold-keyword remap and the scene-present character
    // match run as ONE pure scoring job on the retrieval scoring worker (inline
    // when disabled or unavailable) while the HyDE request is in flight, so the
    // API thread stays free for other requests during the pass
    // (2026-09-21). The job takes the cold rows and one scan
    // window per distinct per-entry depth up front — cheap DB/string work here.
    const notes: string[] = [];
    const infoNotes: string[] = [];
    const depths = new Set<number>([settings.scanDepth]);
    for (const e of entries) depths.add(e.scanDepth);
    // Cold keyword remap input: disabled source entries' keywords can trigger their
    // parent CT. Only their keys/options matter, so the content is not shipped.
    const coldEntries = keywordScanActive && coldToCompressed.size > 0
      ? this.lorebook.findByIds(input.userId, [...coldToCompressed.keys()]).map(row => ({ ...toLorebookEntry(row), content: "" }))
      : [];
    const presentNames = (input.presentCharacters ?? []).map(n => n.trim()).filter(Boolean);
    // Present-unaware names in list order, deduplicated, minus anyone also aware.
    const presentLower = new Set(presentNames.map(n => n.toLowerCase()));
    const unawareNames: string[] = [];
    for (const raw of input.presentUnawareCharacters ?? []) {
      const name = raw.trim();
      if (!name || presentLower.has(name.toLowerCase()) || unawareNames.some(n => n.toLowerCase() === name.toLowerCase())) continue;
      unawareNames.push(name);
    }
    const scoring = await this.scoring.run({
      entries,
      activationState: [...activationState.entries()],
      scanBuffer,
      buffersByDepth: [...depths].map(depth => [depth, scanBufferForDepth(depth)] as [number, string]),
      globalScanDepth: settings.scanDepth,
      turnNumber,
      maxRecursion: 3,
      playerCharacterKeys: settings.playerCharacterKeys,
      skipKeywordScan: !keywordScanActive,
      fresh: freshBuffers,
      coldEntries,
      coldToCompressed: [...coldToCompressed.entries()],
      presentNames,
      unawareNames,
    });
    throwIfAssemblyStopped(input.signal);
    if (scoring.fallbackReason) {
      recordSystemEvent({
        userId: input.userId, campaignId: input.campaign.id, sessionId: input.session.id,
        source: "context_assembly", severity: "warn",
        message: `retrieval scoring worker unavailable — this turn scored on the API thread: ${scoring.fallbackReason}`,
        details: { elapsedMs: Math.round(scoring.elapsedMs) },
      });
    }
    const entryById = new Map(entries.map(e => [e.id, e]));
    for (const hit of scoring.result.activated) {
      const entry = entryById.get(hit.entryId);
      if (!entry) continue;
      candidates.push({ entry, score: hit.score, source: hit.source });
      if (hit.source === "keyword") keywordHits++;
    }
    for (const [id, delta] of scoring.result.activationDelta) activationDelta.set(id, delta);
    for (const parentCtId of scoring.result.coldParentIds) {
      const parentCt = entryById.get(parentCtId);
      if (!parentCt) continue;
      const ctState = activationState.get(parentCt.id);
      const ctTurnsSince = ctState?.lastActivatedTurn != null ? Math.max(0, turnNumber - ctState.lastActivatedTurn) : Infinity;
      const ctRecencyBoost = Math.max(0, 50 - ctTurnsSince);
      candidates.push({ entry: parentCt, score: 750 + ctRecencyBoost, source: "cold-keyword" });
      keywordHits++;
      if (!activationDelta.has(parentCtId)) {
        activationDelta.set(parentCtId, buildActivationDelta(parentCt, turnNumber));
      }
    }
    const scenePresentEntryIds = new Set(scoring.result.scenePresentEntryIds);
    // Present names that found no entry, loaded several people, or resolved by a guess: named for the turn so a
    // real miss shows at once (2026-09-29).
    const presenceNote = describePresence(scoring.result.presence ?? []);
    if (presenceNote) infoNotes.push(presenceNote);
    // Present-unaware cores join the scene-present guarantee, at most
    // UNAWARE_CORE_CAP entries per turn in the scene's list order.
    // A core the cap leaves out competes for the budget like any other entry,
    // and the turn's context note names whose.
    const unawareForced = new Set<string>();
    const unawareCapped: string[] = [];
    for (const [name, ids] of scoring.result.unawareEntryIds ?? []) {
      let leftOut = false;
      for (const id of ids) {
        if (scenePresentEntryIds.has(id) || unawareForced.has(id)) continue;
        if (unawareForced.size >= UNAWARE_CORE_CAP) { leftOut = true; continue; }
        unawareForced.add(id);
      }
      if (leftOut) unawareCapped.push(name);
    }
    for (const id of unawareForced) scenePresentEntryIds.add(id);
    if (unawareCapped.length > 0) {
      notes.push(`Present-unaware guarantee capped at ${UNAWARE_CORE_CAP} cores this turn (scene list order); not forced for ${unawareCapped.join(", ")}, whose entries competed for the retrieval budget instead.`);
    }
    if (scoring.result.regexProblems.length > 0) {
      const problems = scoring.result.regexProblems.slice(0, 10).map(([key, reason]) => ({ key, reason }));
      notes.push(`${scoring.result.regexProblems.length} lorebook regex key(s) could not be evaluated safely; remaining retrieval continued. Check the system indicator for details.`);
      recordSystemEvent({
        userId: input.userId, campaignId: input.campaign.id, sessionId: input.session.id,
        source: "context_assembly", severity: "warn", message: "Lorebook regex matching degraded: invalid or over-budget keys were skipped",
        details: { count: scoring.result.regexProblems.length, problems },
      });
    }

    // Semantic activation — joins the HyDE expansion started above the keyword
    // pass. Guarded: an embedding-provider outage must DEGRADE to keyword-only,
    // not throw away the whole assembly (2026-06-10 DNS outage — 14
    // turns silently ran with zero context).
    if (semanticActive && networkPhases) {
      try {
      const hydeResult = await hydePromise;
      throwIfAssemblyStopped(input.signal);
      hydeUsage = hydeResult.usage;
      const queryText = hydeResult.hypothesis ? `${input.userTurnText}\n\n${hydeResult.hypothesis}` : input.userTurnText;
      const queryVec = await this.embeddingService.embedQuery(queryText, settings.embeddingModel, input.userId, input.signal);
      throwIfAssemblyStopped(input.signal);
      if (queryVec) {
        // Scope the candidate pool to THIS campaign (+ global entries) so the
        // top-K slice isn't starved by a sibling campaign's vectors under the same
        // model. Cold→compressed remap still works: cold entries carry the same
        // campaign_id as their compressed parent.
        const allEmbeddings = this.embeddingRepo.listForCampaignAndModel(input.userId, input.campaign.id, settings.embeddingModel);
        const alreadyActivated = new Set(candidates.map(c => c.entry.id));
        const semanticResults = runSemanticActivation(queryVec, allEmbeddings, alreadyActivated, allEmbeddings.length, settings.semanticThreshold);
        let eligibleHits = 0;
        for (const hit of semanticResults) {
          if (eligibleHits >= settings.semanticTopK) break;
          const resolvedId = coldToCompressed.get(hit.entryId) ?? hit.entryId;
          const entry = entries.find(e => e.id === resolvedId);
          if (entry && !alreadyActivated.has(resolvedId)) {
            const semState = activationState.get(entry.id);
            // Cooldown applies to every activation path, not just keyword.
            if ((semState?.cooldownRemaining ?? 0) > 0) continue;
            const semTurnsSince = semState?.lastActivatedTurn != null ? Math.max(0, turnNumber - semState.lastActivatedTurn) : Infinity;
            const semRecencyBoost = Math.max(0, 50 - semTurnsSince);
            candidates.push({ entry, score: 900 + Math.round(hit.score * 100) + semRecencyBoost, source: "semantic" });
            semanticHits++;
            eligibleHits++;
            alreadyActivated.add(resolvedId);
            if (!activationDelta.has(entry.id)) {
              activationDelta.set(entry.id, buildActivationDelta(entry, turnNumber));
            }
          }
        }
      }
      } catch (err) {
        // A user Stop is not a degradation — let the AbortError out untouched.
        if (input.signal?.aborted) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        notes.push(`Semantic retrieval failed (${reason}) — keyword-only this turn`);
        // Skip the duplicate row when the embedding service already recorded
        // this exact failure (provider outages produced two error rows).
        if (!(err instanceof Error && (err as Error & { systemEventRecorded?: boolean }).systemEventRecorded)) {
          recordSystemEvent({
            userId: input.userId,
            source: "context_assembly",
            severity: "error",
            message: `semantic retrieval degraded to keyword-only: ${reason}`,
            campaignId: input.campaign.id,
            sessionId: input.session.id,
          });
        }
      }
    }

    // Researcher activation
    let researcherUsage: ResearcherUsage | null = null;
    if (settings.researcherEnabled && this.runtimeForUser && networkPhases) {
      const runtime = this.runtimeForUser(input.userId);
      const alreadyActivated = new Set(candidates.map(c => c.entry.id));
      throwIfAssemblyStopped(input.signal);
      const researcherResult = await runResearcherActivation(runtime, settings.researcherModel, entries, input.userTurnText, alreadyActivated, settings.researcherMaxPicks ?? 16, input.userId, input.signal, settings.openaiFastModeEnabled);
      throwIfAssemblyStopped(input.signal);
      researcherUsage = researcherResult.usage;
      for (const entryId of researcherResult.entryIds) {
        const entry = entries.find(e => e.id === entryId);
        if (entry) {
          if ((activationState.get(entry.id)?.cooldownRemaining ?? 0) > 0) continue;
          candidates.push({ entry, score: 1100, source: "researcher" });
          researcherHits++;
          if (!activationDelta.has(entry.id)) {
            activationDelta.set(entry.id, buildActivationDelta(entry, turnNumber));
          }
        }
      }
    }

    // Scene-present character firmware: characters physically in the scene must
    // always have their voice firmware loaded, regardless of activation score.
    // The precision-scoring activator otherwise lets specific event entries
    // outscore broad-key character firmware, leaving the model with the facts
    // about what a character did but no instructions on how they speak. The
    // name match itself ran in the scoring job above (scenePresentEntryIds).

    // Promote scene-present candidates and add any that didn't activate via keyword/semantic/researcher
    const seenIds = new Set<string>();
    const guaranteed: ScoredCandidate[] = [];
    const remaining: ScoredCandidate[] = [];
    for (const c of candidates) {
      if (seenIds.has(c.entry.id)) continue;
      seenIds.add(c.entry.id);
      if (scenePresentEntryIds.has(c.entry.id)) {
        guaranteed.push({ entry: c.entry, score: 1500, source: "scene-present" });
        if (!activationDelta.has(c.entry.id)) {
          activationDelta.set(c.entry.id, buildActivationDelta(c.entry, turnNumber));
        }
      } else {
        remaining.push(c);
      }
    }
    for (const entry of entries) {
      if (!scenePresentEntryIds.has(entry.id) || seenIds.has(entry.id)) continue;
      guaranteed.push({ entry, score: 1500, source: "scene-present" });
      seenIds.add(entry.id);
      if (!activationDelta.has(entry.id)) {
        activationDelta.set(entry.id, buildActivationDelta(entry, turnNumber));
      }
    }

    // Thread entries: when a pending-thread entry activates (via a real reference in the
    // recent turns), its FULL uncompressed entry is guaranteed into context — never budget-
    // pruned down to just its one-line Thread Index entry. Capped per turn so a turn that
    // name-drops many threads cannot blow the budget; beyond the cap they compete normally.
    // The constant Thread Index itself is force-included via the constant path already.
    // Capped by TOKENS since 2026-09-25 (settings.threadGuaranteeTokens): the
    // count cap alone let eight full-size thread entries (47.7k tokens on one long
    // campaign) exceed the whole retrieval budget and starve every scored entry.
    // Promotion walks threads in score order and skips any that would cross the
    // token cap (a smaller thread after a big one can still fit); skipped threads
    // compete normally. A count ceiling stays as a sanity bound.
    const THREAD_GUARANTEE_MAX_COUNT = 8;
    const threadTokenCap = Math.max(0, settings.threadGuaranteeTokens);
    const promotedThreads: ScoredCandidate[] = [];
    let promotedThreadTokens = 0;
    for (const c of remaining.filter(c => c.entry.tag === "threads" && c.source !== "constant").sort((a, b) => b.score - a.score)) {
      if (promotedThreads.length >= THREAD_GUARANTEE_MAX_COUNT) break;
      if (promotedThreadTokens + c.entry.tokensEstimate > threadTokenCap) continue;
      promotedThreads.push(c);
      promotedThreadTokens += c.entry.tokensEstimate;
    }
    if (promotedThreads.length > 0) {
      const promote = new Set(promotedThreads.map(c => c.entry.id));
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (promote.has(remaining[i].entry.id)) {
          guaranteed.push(remaining[i]);
          remaining.splice(i, 1);
        }
      }
    }

    // Cold inflation: activated compressed triggers ALWAYS get replaced with their full cold
    // entries when they activate. The compressed synopsis MUST NEVER be injected into context —
    // it's an internal retrieval-index artifact only. The per-campaign coldInflationWeightMultiplier
    // affects only the SCORE of the resulting inflated cold entries in budget competition:
    //   multiplier=1 -> equal to active entries
    //   <1          -> downweight; cold only wins budget when activation signal is strong
    //   0           -> cold enters at score 0 (deprioritized; likely pruned, but if budget allows
    //                  the full cold content still appears — never the compressed synopsis)
    //   >1          -> boost (rare; allowed up to 2.0)
    let coldInflations = 0;
    const coldMultiplier = settings.coldInflationWeightMultiplier;
    const activatedCompressedIds = new Set<string>();
    for (const c of [...guaranteed, ...remaining]) {
      if (compressedEntryIds.has(c.entry.id)) activatedCompressedIds.add(c.entry.id);
    }
    if (activatedCompressedIds.size > 0) {
      const allColdIds: string[] = [];
      for (const compId of activatedCompressedIds) {
        const comp = entries.find(e => e.id === compId);
        if (comp?.compressedRefIds) allColdIds.push(...comp.compressedRefIds);
      }
      if (allColdIds.length > 0) {
        const coldRows = this.lorebook.findByIds(input.userId, allColdIds);
        const coldEntries = coldRows.map(toLorebookEntry);
        const coldMap = new Map(coldEntries.map(e => [e.id, e]));

        // A compressed trigger whose cold source rows were all deleted resolves to
        // ZERO cold entries: it's dropped from context contributing nothing. That
        // used to be silent — record the dangling CTs as a note + system_event.
        const danglingCts = new Map<string, string>(); // entryId -> entryName
        const inflateInto = (list: ScoredCandidate[]): ScoredCandidate[] => {
          const result: ScoredCandidate[] = [];
          for (const c of list) {
            if (!activatedCompressedIds.has(c.entry.id)) { result.push(c); continue; }
            const comp = entries.find(e => e.id === c.entry.id);
            if (!comp?.compressedRefIds) { result.push(c); continue; }
            let resolved = 0;
            for (const coldId of comp.compressedRefIds) {
              const cold = coldMap.get(coldId);
              if (cold) {
                result.push({ entry: cold, score: c.score * coldMultiplier, source: "cold-inflate" });
                coldInflations++;
                resolved++;
              }
            }
            if (resolved === 0) danglingCts.set(c.entry.id, c.entry.name);
          }
          return result;
        };
        guaranteed.splice(0, guaranteed.length, ...inflateInto(guaranteed));
        remaining.splice(0, remaining.length, ...inflateInto(remaining));
        if (danglingCts.size > 0) {
          const names = [...danglingCts.values()].join(", ");
          notes.push(`Compressed trigger(s) activated but their cold source entries are missing — no content contributed: ${names}`);
          recordSystemEvent({
            userId: input.userId,
            source: "context_assembly",
            severity: "warn",
            message: `compressed trigger(s) with dangling cold refs contributed no content: ${names}`,
            campaignId: input.campaign.id,
            sessionId: input.session.id,
            details: { entryIds: [...danglingCts.keys()] },
          });
        }
      }
    }

    // Budget pruning: scene-present entries are pre-included, remainder competes for what's left
    const guaranteedTokens = guaranteed.reduce((sum, c) => sum + c.entry.tokensEstimate, 0);
    const remainingBudget = Math.max(0, settings.retrievalBudgetTokens - guaranteedTokens);
    const pruned = pruneByBudget(remaining, remainingBudget);
    const finalIncluded = [...guaranteed, ...pruned.included];
    // Starvation visibility (2026-09-25): the guaranteed tier (scene-present
    // cores + promoted threads) is subtracted from the budget BEFORE scoring and
    // constants ride regardless, so an oversized tier silently drops every
    // scored entry. Measured on a long campaign: constants 12.3k + cores + threads
    // exceeded the 42k budget on ordinary turns for weeks with nothing said.
    // Now the turn's context note names the split and a throttled system event
    // carries the top costs; the size report / compaction tools are the cure.
    const constantTokens = pruned.included.filter(c => c.source === "constant").reduce((sum, c) => sum + c.entry.tokensEstimate, 0);
    const scenePresentTokens = guaranteed.filter(c => c.source === "scene-present").reduce((sum, c) => sum + c.entry.tokensEstimate, 0);
    const budget = settings.retrievalBudgetTokens;
    if (pruned.dropped.length > 0 && budget > 0 && remainingBudget < budget * 0.25) {
      const top = [...guaranteed, ...pruned.included.filter(c => c.source === "constant")]
        .sort((a, b) => b.entry.tokensEstimate - a.entry.tokensEstimate).slice(0, 5)
        .map(c => `${c.entry.name} ${c.entry.tokensEstimate}`);
      notes.push(`Retrieval starvation: guaranteed entries used ${guaranteedTokens} of the ${budget}-token retrieval budget (scene-present ${scenePresentTokens}, threads ${promotedThreadTokens}) with constants adding ${constantTokens}; ${pruned.dropped.length} scored entr${pruned.dropped.length === 1 ? "y was" : "ies were"} dropped. Largest: ${top.join(" · ")}. Split the largest entries into a core entry and satellite entries, or raise the retrieval budget.`);
      if (!input.dryRun) {
        recordSystemEvent({
          userId: input.userId,
          source: "context_assembly",
          severity: "info",
          message: "retrieval starvation: guaranteed entries left under a quarter of the retrieval budget for scored entries",
          campaignId: input.campaign.id,
          sessionId: input.session.id,
          details: { budget, guaranteedTokens, scenePresentTokens, threadTokens: promotedThreadTokens, constantTokens, dropped: pruned.dropped.length, top },
        });
      }
    }

    // Activation state is INCLUSION-scoped
    // (2026-09-02). Until now every candidate — including the
    // ones the budget pruner dropped — stamped lastActivatedTurn and armed its
    // sticky/cooldown, so on a saturated corpus 124 of 127 entries read as
    // "active every turn": the archival gate and the stale sweep could never see
    // a never-delivered entry as stale, and the recency boost rewarded candidacy
    // rather than continuity. Now only entries that actually reached the model
    // (guaranteed or budget-included; a cold entry counts for its compressed
    // trigger) write a timestamp or arm sticky/cooldown. Tick-downs still apply
    // to everything: a cooling entry keeps cooling and a carried sticky keeps
    // decrementing whether or not it fit this turn.
    const includedIds = new Set<string>();
    for (const c of finalIncluded) {
      includedIds.add(c.entry.id);
      if (c.source === "cold-inflate") {
        const parent = coldToCompressed.get(c.entry.id);
        if (parent) includedIds.add(parent);
      }
    }
    const candidateSource = new Map<string, ScoredCandidate["source"]>();
    for (const c of candidates) if (!candidateSource.has(c.entry.id)) candidateSource.set(c.entry.id, c.source);
    for (const [id, delta] of [...activationDelta]) {
      if (includedIds.has(id)) continue;
      const source = candidateSource.get(id);
      if (source === undefined) continue; // a pure cooldown tick — keep
      if (source === "sticky") {
        // Carried forward but not delivered: keep the decrement, not the timestamp.
        if (delta.stickyRemaining !== undefined) activationDelta.set(id, { stickyRemaining: delta.stickyRemaining });
        else activationDelta.delete(id);
        continue;
      }
      activationDelta.delete(id); // activated but pruned: no timestamp, no arming
    }

    // Constant-freshness guard: a stale Thread Index must declare its own
    // staleness in-context instead of asserting an old world as truth.
    const freshnessNote = applyTrackerFreshnessHedge(finalIncluded, turnNumber, {
      userId: input.userId,
      campaignId: input.campaign.id,
      // A dry-run preview neither records the staleness event nor moves its
      // re-alert throttle: the event belongs to the live turn.
      recordEvents: !input.dryRun,
    });
    if (freshnessNote) notes.push(freshnessNote);

    // Render with scene-aware knowledge scoping. Aware characters only: a
    // present-unaware character cannot perceive the scene, so it never counts
    // as a knower and never unlocks restricted canon for the table.
    const retrievedSection = renderRetrievedContext(finalIncluded, input.presentCharacters ?? []);

    // Build preview entries
    const preview: ContextPreviewEntry[] = [
      ...finalIncluded.map(c => ({ entryId: c.entry.id, name: c.entry.name, tag: c.entry.tag, source: c.source, score: c.score, tokenCost: c.entry.tokensEstimate, included: true })),
      ...pruned.dropped.map(c => ({ entryId: c.entry.id, name: c.entry.name, tag: c.entry.tag, source: c.source, score: c.score, tokenCost: c.entry.tokensEstimate, included: false })),
    ];

    return {
      retrievedSection,
      preview,
      debug: {
        keywordHits,
        semanticHits,
        researcherHits,
        absentContacts: 0,
        coldInflations,
        droppedForBudget: pruned.dropped.length,
        totalTokens: guaranteedTokens + pruned.totalTokens,
      },
      // dryRun: hand back an EMPTY activation delta so even a caller that blindly
      // commits it mutates nothing (no sticky/cooldown/lastActivatedTurn writes).
      // assembleForTurn itself performs no DB writes; the only mutation channel is
      // this returned delta + the caller's commitActivationState, so emptying it
      // here makes a preview fully side-effect-free without burning a turn.
      activationDelta: input.dryRun ? new Map() : activationDelta,
      researcherUsage,
      hydeUsage,
      notes,
      infoNotes,
    };
  }

  async commitActivationState(sessionId: string, delta: Map<string, { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }>): Promise<void> {
    // One transaction for the whole delta. Each row is
    // still a PARTIAL update — coalescing to 0/null was the destructive-overwrite
    // bug that erased cooldown and recency state.
    this.lorebook.upsertActivationStates(sessionId, delta);
  }
}

// Build the activation-state delta for a freshly-activated entry. Cooldown is
// armed here so EVERY activation path (semantic / researcher / scene-present /
// cold-keyword), not just the keyword path, sets cooldownRemaining — otherwise a
// cooldown>0 entry re-activates every turn via those paths because nothing ever
// armed its cooldown.
function buildActivationDelta(entry: LorebookEntry, turnNumber: number): { stickyRemaining: number; lastActivatedTurn: number; cooldownRemaining?: number } {
  const delta: { stickyRemaining: number; lastActivatedTurn: number; cooldownRemaining?: number } = {
    stickyRemaining: entry.sticky,
    lastActivatedTurn: turnNumber,
  };
  if (entry.cooldown > 0) delta.cooldownRemaining = entry.cooldown;
  return delta;
}

type LorebookRow = ReturnType<LorebookRepository["findByIds"]>[number];
function toLorebookEntry(row: LorebookRow): LorebookEntry {
  return {
    id: row.id,
    userId: row.userId,
    campaignId: row.campaignId,
    name: row.name,
    tag: row.tag,
    content: row.content,
    comment: row.comment,
    keys: safeParseJson(row.keys, []),
    keysSecondary: safeParseJson(row.keysSecondary, []),
    // Stored as free text; the repository writes only contract values.
    selectiveLogic: row.selectiveLogic as LorebookEntry["selectiveLogic"],
    scanDepth: row.scanDepth,
    position: row.position as LorebookEntry["position"],
    insertionOrder: row.insertionOrder,
    probability: row.probability,
    isConstant: row.isConstant === 1,
    isEnabled: row.isEnabled === 1,
    sticky: row.sticky,
    cooldown: row.cooldown,
    delay: row.delay,
    excludeRecursion: row.excludeRecursion === 1,
    preventRecursion: row.preventRecursion === 1,
    delayUntilRecursion: row.delayUntilRecursion === 1,
    tokensEstimate: row.tokensEstimate,
    knownBy: row.knownBy ? safeParseJson(row.knownBy, null) : null,
    matchOptions: row.matchOptionsJson ? safeParseJson(row.matchOptionsJson, null) : null,
    legacySource: row.legacySource,
    compressedRefIds: row.compressedRefIds ? safeParseJson(row.compressedRefIds, null) : null,
    sealed: row.sealed === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

