import type { ContextSettings, ContextPreviewEntry, LorebookEntry } from "@tracyhill-rp/contracts";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import type { ResearcherUsage } from "./researcherActivator";

import type { LorebookRepository } from "./lorebookRepository";

import type { LorebookEmbeddingRepository } from "./lorebookEmbeddingRepository";
import type { EmbeddingService } from "./embeddingService";
import { runKeywordActivation, matchesEntry } from "./keywordActivator";
import { runSemanticActivation } from "./semanticActivator";
import { runResearcherActivation } from "./researcherActivator";
import { generateHyDEQuery } from "./hydeQuery";
import { recordSystemEvent } from "../system/systemEvents";
import { pruneByBudget, type ScoredCandidate } from "./budgetPruner";
import { renderRetrievedContext } from "./contextRenderer";

const DEFAULTS: ContextSettings = {
  mode: "keyword",
  retrievalBudgetTokens: 16000,
  semanticTopK: 20,
  semanticThreshold: 0.25,
  scanDepth: 4,
  contextBudgetTokens: 200000,
  guaranteedMessageCount: 20,
  embeddingModel: "openai:text-embedding-3-large",
  researcherEnabled: true,
  researcherModel: "claude-sonnet-4-6-bridge",
  researcherMaxPicks: 16,
  hydeEnabled: true,
  hydeModel: undefined,
  rollingEnabled: true,
  rollingCadence: 4,
  rollingModel: "claude-haiku-4-5-bridge",
  sceneValidatorEnabled: true,
  sceneValidatorModel: "claude-haiku-4-5-bridge",
  sceneValidatorAutoRegen: true,
  attireTrackingEnabled: true,
  attireStaleTurnThreshold: 10,
  pipelineAutoEnabled: true,
  rollingDiffCharThreshold: 17000,
  repetitionCharThreshold: 50000,
  syspromptAuditCharThreshold: 100000,
  maxAntiRepetitionRules: 80,
  antiRepArchiveAfter: 5,
  previewEnabled: false,
  disabledEntryIds: [],
  playerCharacterKeys: [],
  coldInflationWeightMultiplier: 0.6,
  fastModeEnabled: false,
};

export interface ContextAssemblyResult {
  retrievedSection: string | null;
  preview: ContextPreviewEntry[];
  debug: {
    keywordHits: number;
    semanticHits: number;
    researcherHits: number;
    coldInflations: number;
    droppedForBudget: number;
    totalTokens: number;
  };
  activationDelta: Map<string, { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }>;
  researcherUsage: ResearcherUsage | null;
  /** Degradation warnings (e.g. "semantic retrieval failed — keyword-only this turn"). Surfaced in the context preview. */
  notes: string[];
}

export class ContextEngine {
  constructor(
    private readonly lorebook: LorebookRepository,
    private readonly embeddingRepo: LorebookEmbeddingRepository,
    private readonly embeddingService: EmbeddingService,
    private readonly runtimeForUser: ((userId: string) => ChatRuntime | null) | null,
  ) {}

  isEnabled(session: { contextOverridesJson?: string | null }, campaign: { contextDefaultsJson?: string | null } | null): boolean {
    const settings = this.resolveSettings(session, campaign);
    return settings.mode !== "off";
  }

  resolveSettings(session: { contextOverridesJson?: string | null }, campaign: { contextDefaultsJson?: string | null } | null): ContextSettings {
    const campaignDefaults = campaign?.contextDefaultsJson ? safeParseJson(campaign.contextDefaultsJson, {}) : {};
    const sessionOverrides = session.contextOverridesJson ? safeParseJson(session.contextOverridesJson, {}) : {};
    return { ...DEFAULTS, ...campaignDefaults, ...sessionOverrides };
  }

  async assembleForTurn(input: {
    userId: string;
    session: { id: string; contextOverridesJson?: string | null };
    campaign: { id: string; contextDefaultsJson?: string | null };
    history: Array<{ role: string; content: string }>;
    userTurnText: string;
    dryRun: boolean;
    presentCharacters?: string[];
  }): Promise<ContextAssemblyResult> {
    const settings = this.resolveSettings(input.session, input.campaign);
    if (settings.mode === "off") {
      return { retrievedSection: null, preview: [], debug: { keywordHits: 0, semanticHits: 0, researcherHits: 0, coldInflations: 0, droppedForBudget: 0, totalTokens: 0 }, activationDelta: new Map(), researcherUsage: null, notes: [] };
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

    // Build scan buffer from last N messages
    const scanMessages = input.history.slice(-settings.scanDepth * 2);
    const scanBuffer = scanMessages.map(m => m.content).join("\n") + "\n" + input.userTurnText;

    // Load activation state
    const rawState = this.lorebook.getActivationState(input.session.id);
    const activationState = new Map(rawState.map(s => [s.entryId, { stickyRemaining: s.stickyRemaining, cooldownRemaining: s.cooldownRemaining, lastActivatedTurn: s.lastActivatedTurn }]));

    const turnNumber = Math.floor(input.history.length / 2) + 1;
    const candidates: ScoredCandidate[] = [];
    let keywordHits = 0, semanticHits = 0, researcherHits = 0;

    // Keyword activation
    const activationDelta = new Map<string, { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }>();
    if (settings.mode === "keyword" || settings.mode === "hybrid") {
      const kwResult = runKeywordActivation(entries, activationState, scanBuffer, turnNumber, 3, settings.playerCharacterKeys);
      for (const [, hit] of kwResult.activated) {
        candidates.push({ entry: hit.entry, score: hit.score, source: hit.source });
        if (hit.source === "keyword") keywordHits++;
      }
      for (const [id, delta] of kwResult.activationDelta) activationDelta.set(id, delta);

      // Cold keyword remap: disabled source entries' keywords can trigger their parent CT
      if (coldToCompressed.size > 0) {
        const coldIds = [...coldToCompressed.keys()];
        const coldRows = this.lorebook.findByIds(input.userId, coldIds);
        const alreadyActivated = new Set(candidates.map(c => c.entry.id));
        for (const row of coldRows) {
          const coldEntry = toLorebookEntry(row);
          const parentCtId = coldToCompressed.get(coldEntry.id);
          if (!parentCtId || alreadyActivated.has(parentCtId)) continue;
          const match = matchesEntry(coldEntry, scanBuffer);
          if (match.matched) {
            const parentCt = entries.find(e => e.id === parentCtId);
            if (parentCt) {
              const ctState = activationState.get(parentCt.id);
              const ctTurnsSince = ctState?.lastActivatedTurn != null ? Math.max(0, turnNumber - ctState.lastActivatedTurn) : Infinity;
              const ctRecencyBoost = Math.max(0, 50 - ctTurnsSince);
              candidates.push({ entry: parentCt, score: 750 + ctRecencyBoost, source: "cold-keyword" as any });
              keywordHits++;
              alreadyActivated.add(parentCtId);
              if (!activationDelta.has(parentCtId)) {
                activationDelta.set(parentCtId, { stickyRemaining: parentCt.sticky, lastActivatedTurn: turnNumber });
              }
            }
          }
        }
      }
    }

    // Semantic activation — with HyDE query expansion in parallel with keyword.
    // Guarded: an embedding-provider outage must DEGRADE to keyword-only, not
    // throw away the whole assembly (2026-06-10 Pi-hole DNS incident — 14 prod
    // turns silently ran with zero context).
    const notes: string[] = [];
    if ((settings.mode === "semantic" || settings.mode === "hybrid") && this.embeddingService) {
      try {
      const hydeRuntime = this.runtimeForUser ? this.runtimeForUser(input.userId) : null;
      const hydePromise = settings.hydeEnabled !== false && hydeRuntime
        ? generateHyDEQuery(hydeRuntime, settings.hydeModel ?? settings.researcherModel, input.userTurnText, input.history, input.userId)
        : Promise.resolve({ hypothesis: null, usage: null });
      const hydeResult = await hydePromise;
      const queryText = hydeResult.hypothesis ? `${input.userTurnText}\n\n${hydeResult.hypothesis}` : input.userTurnText;
      const queryVec = await this.embeddingService.embedQuery(queryText, settings.embeddingModel, input.userId);
      if (queryVec) {
        const allEmbeddings = this.embeddingRepo.listForUserAndModel(input.userId, settings.embeddingModel);
        const alreadyActivated = new Set(candidates.map(c => c.entry.id));
        const semanticResults = runSemanticActivation(queryVec, allEmbeddings, alreadyActivated, settings.semanticTopK, settings.semanticThreshold);
        for (const hit of semanticResults) {
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
            if (!activationDelta.has(entry.id)) {
              activationDelta.set(entry.id, { stickyRemaining: entry.sticky, lastActivatedTurn: turnNumber });
            }
          }
        }
      }
      } catch (err) {
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
    if (settings.researcherEnabled && this.runtimeForUser) {
      const runtime = this.runtimeForUser(input.userId);
      const alreadyActivated = new Set(candidates.map(c => c.entry.id));
      const researcherResult = await runResearcherActivation(runtime, settings.researcherModel, entries, input.userTurnText, alreadyActivated, settings.researcherMaxPicks ?? 16, input.userId);
      researcherUsage = researcherResult.usage;
      for (const entryId of researcherResult.entryIds) {
        const entry = entries.find(e => e.id === entryId);
        if (entry) {
          if ((activationState.get(entry.id)?.cooldownRemaining ?? 0) > 0) continue;
          candidates.push({ entry, score: 1100, source: "researcher" });
          researcherHits++;
          if (!activationDelta.has(entry.id)) {
            activationDelta.set(entry.id, { stickyRemaining: entry.sticky, lastActivatedTurn: turnNumber });
          }
        }
      }
    }

    // Scene-present character firmware: characters physically in the scene must
    // always have their voice firmware loaded, regardless of activation score.
    // The precision-scoring activator otherwise lets specific event entries
    // outscore broad-key character firmware, leaving the model with the facts
    // about what a character did but no instructions on how they speak.
    const presentNames = (input.presentCharacters ?? []).map(n => n.trim()).filter(Boolean);
    const scenePresentEntryIds = new Set<string>();
    if (presentNames.length > 0) {
      for (const entry of entries) {
        if (entry.tag !== "characters") continue;
        if (entryMatchesPresentChar(entry, presentNames)) scenePresentEntryIds.add(entry.id);
      }
    }

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
          activationDelta.set(c.entry.id, { stickyRemaining: c.entry.sticky, lastActivatedTurn: turnNumber });
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
        activationDelta.set(entry.id, { stickyRemaining: entry.sticky, lastActivatedTurn: turnNumber });
      }
    }

    // Thread entries: when a pending-thread entry activates (via a real reference in the
    // recent turns), its FULL uncompressed entry is guaranteed into context — never budget-
    // pruned down to just its one-line Thread Index entry. Capped per turn so a turn that
    // name-drops many threads cannot blow the budget; beyond the cap they compete normally.
    // The constant Thread Index itself is force-included via the constant path already.
    const THREAD_GUARANTEE_CAP = 8;
    const promotedThreads = remaining
      .filter(c => c.entry.tag === "threads" && c.source !== "constant")
      .sort((a, b) => b.score - a.score)
      .slice(0, THREAD_GUARANTEE_CAP);
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

        const inflateInto = (list: ScoredCandidate[]): ScoredCandidate[] => {
          const result: ScoredCandidate[] = [];
          for (const c of list) {
            if (!activatedCompressedIds.has(c.entry.id)) { result.push(c); continue; }
            const comp = entries.find(e => e.id === c.entry.id);
            if (!comp?.compressedRefIds) { result.push(c); continue; }
            for (const coldId of comp.compressedRefIds) {
              const cold = coldMap.get(coldId);
              if (cold) {
                result.push({ entry: cold, score: c.score * coldMultiplier, source: "cold-inflate" as any });
                coldInflations++;
              }
            }
          }
          return result;
        };
        guaranteed.splice(0, guaranteed.length, ...inflateInto(guaranteed));
        remaining.splice(0, remaining.length, ...inflateInto(remaining));
      }
    }

    // Budget pruning: scene-present entries are pre-included, remainder competes for what's left
    const guaranteedTokens = guaranteed.reduce((sum, c) => sum + c.entry.tokensEstimate, 0);
    const remainingBudget = Math.max(0, settings.retrievalBudgetTokens - guaranteedTokens);
    const pruned = pruneByBudget(remaining, remainingBudget);
    const finalIncluded = [...guaranteed, ...pruned.included];

    // Render with scene-aware knowledge scoping
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
        coldInflations,
        droppedForBudget: pruned.dropped.length,
        totalTokens: guaranteedTokens + pruned.totalTokens,
      },
      activationDelta,
      researcherUsage,
      notes,
    };
  }

  async commitActivationState(sessionId: string, delta: Map<string, { stickyRemaining?: number; cooldownRemaining?: number; lastActivatedTurn?: number | null }>): Promise<void> {
    for (const [entryId, updates] of delta) {
      // Pass the delta through as a PARTIAL — coalescing to 0/null here was the
      // destructive-overwrite bug that erased cooldown and recency state.
      this.lorebook.upsertActivationState(sessionId, entryId, updates);
    }
  }
}

function toLorebookEntry(row: any): LorebookEntry {
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
    selectiveLogic: row.selectiveLogic as any,
    scanDepth: row.scanDepth,
    position: row.position as any,
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Match a character lorebook entry against scene-present names. Entry names
// often carry trailing role annotations (e.g. "Spike — William the Bloody"),
// so we strip the first " — "/" - " segment before comparing. We also check
// the entry's primary keys, which usually include the canonical short name.
function entryMatchesPresentChar(entry: LorebookEntry, presentNames: string[]): boolean {
  const entryName = entry.name.toLowerCase();
  const baseName = entryName.split(/\s+[—-]\s+/)[0]!.trim();
  const keys = entry.keys.map(k => k.toLowerCase());
  for (const present of presentNames) {
    const p = present.toLowerCase();
    if (entryName === p || baseName === p) return true;
    if (entryName.includes(p) || p.includes(baseName)) return true;
    if (keys.includes(p)) return true;
    if (keys.some(k => p.includes(k) && k.length >= 4)) return true;
  }
  return false;
}
