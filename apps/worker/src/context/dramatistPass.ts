import { randomInt } from "node:crypto";
import type { EffortLevel } from "@tracyhill-rp/model-catalog";

import {
  dramatistProposalSchema,
  dramatistStateSchema,
  type DramatistProposal,
  type DramatistState,
} from "@tracyhill-rp/contracts";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { parseFirstJson } from "@tracyhill-rp/provider-runtime";

import type { CampaignRepository } from "../../../api/src/domain/campaigns/campaignRepository";
import type { CharacterDrivesRepository } from "../../../api/src/domain/chat/characterDrivesRepository";
import type { LorebookRepository } from "../../../api/src/domain/context/lorebookRepository";
import { estimateTokens } from "../../../api/src/domain/context/lorebookTokenEstimator";
import type { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";
import { recordSystemEvent } from "../../../api/src/domain/system/systemEvents";
import {
  buildDramatistInventory,
  validateDramatistSelection,
  type DramatistInventoryItem,
} from "../../../api/src/domain/world/dramatistInventory";
import {
  advanceDramatistState,
  EMPTY_DRAMATIST_STATE,
  resolveDramatistPacing,
  type DramatistIntensity,
  type PacingResolution,
} from "../../../api/src/domain/world/dramatistPacing";
import type { ScheduledBeatRepository } from "../../../api/src/domain/world/scheduledBeatRepository";
import { parseInWorldDate } from "../../../api/src/domain/world/worldClock";
import { createId } from "../../../api/src/lib/ids";
import { withDeadline, withRetry, WORKER_LLM_DEADLINE_MS } from "../pipeline/retryHelper";
import { workerThinkingModeFor } from "@tracyhill-rp/model-catalog";

const PROPOSE_SYSTEM = `You are THE DRAMATIST for an ongoing roleplay campaign. A deterministic pacing roll has granted permission and a maximum severity. Select at most ONE live inventory item and turn its established pressure into a playable beat, or DECLINE when the scene cannot carry it.

The roll is permission, never content. You may not invent a citation. Complications should create opposition, collide timers, or put an established plan under pressure. They must happen in the world, not merely be offered as an option.

HARD RULES:
1. Cite the selected inventory item's exact id. Only severity-0 texture may use null.
2. Severity may not exceed the grant or the citation's maxSeverity. If an escalation outruns its citation, write a telegraph instead.
3. Honor attempt-not-outcome: pressure can interrupt, expose, threaten, inconvenience, wound when grounded, or force a decision point; it cannot presuppose the player's failure or decide their response.
4. Never write the player character's voluntary action, dialogue, thoughts, choice, consent, or decision. The world may impose involuntary physical/sensory consequences while returning the floor at the decision point.
5. knownBy must contain only characters who could presently know.
6. Scene fit is mandatory. DECLINE rather than force a tonal wreck. Pressure defers; it never forces.
7. Output ONLY one JSON object, no prose or fences:
{"action":"fire","citationId":"thread:T12","description":"concrete playable beat","class":"texture|telegraph|complication","severity":0,"timing":"when_due|fire_during_scene","knownBy":[],"rationale":"grounding and fit"}
or {"action":"decline","reason":"why no live item fits now"}.`;

const VERIFY_SYSTEM = `You are an adversarial, refute-first CANON CHECKER. Validate grounding, not dramatic desirability. Missing evidence means refute. A proposal passes only when it preserves every hard boundary:
- citation is established and live; severity does not exceed its established ceiling;
- attempt-not-outcome: no presupposed player failure or involuntary voluntary choice;
- no player-character dialogue, thoughts, actions, consent, decisions, or authored will;
- knownBy is epistemically plausible;
- scene timing and tone can carry the event without wrecking the current beat;
- established canon, red lines, and campaign tone are not contradicted.

Output ONLY {"ok":true,"reason":"brief evidence"} or {"ok":false,"reason":"specific refutation"}.`;

export interface DramatistPassDetails {
  roll: number;
  bands: PacingResolution["bands"];
  modifiers: PacingResolution["modifiers"];
  grant: PacingResolution["grant"];
  inventorySize: number;
  selection: null | {
    citationInventoryId: string | null;
    citationType: string;
    citationId: string | null;
    class: string;
    severity: number;
    timing: string;
    description: string;
    downgraded: boolean;
  };
  gates: Array<{ lens: string; ok: boolean; reason: string }>;
  // "deduped": the gates passed but createIfNovel refused the beat —
  // the proposal re-derived one that already exists in some status. Nothing
  // armed, nothing booked as a fire. (Contract enum in
  // packages/contracts/src/world.ts must carry the value too.)
  outcome: "fizzle" | "decline" | "rejected" | "armed" | "deduped";
  reason: string | null;
  armedBeatId: string | null;
  schemeAdvance: { actor: string; fromStep: number; toStep: number; armedStepBeatId?: string | null } | null;
  state: DramatistState;
}

export interface DramatistPassDeps {
  campaigns: CampaignRepository;
  drives: CharacterDrivesRepository;
  lorebook: LorebookRepository;
  beats: ScheduledBeatRepository;
  runs: PipelineRunRepository;
}

export interface DramatistPassInput {
  run: { id: string; userId: string; campaignId: string };
  runtime: ChatRuntime;
  modelId: string;
  // Engine dial: explicit effort for effort-ladder models, else null.
  effort?: EffortLevel | null;
  // Engine dial (2026-09-09): "fast" when the dial is on and the Dramatist
  // model supports OpenAI fast mode (resolved by the caller), else undefined.
  speed?: "fast";
  intensity: DramatistIntensity;
  tickOrdinal: number;
  campaignStateJson: string | null;
  playerCharacterKeys: string[];
  threadIndexComment: string | null;
  storyNow: string;
  // Epoch of `storyNow` when the caller has it: year-less labels a
  // beat's `afterInworld` inherits are re-anchored to the campaign's year. It
  // is also the clock the scheme steps' not-before dates are read against
  // without it a dated step stays out of the inventory.
  storyNowEpoch?: number | null;
  sceneSnapshot: string;
  recentWindow: string;
  canonContext: string;
  signal?: AbortSignal;
  roll?: number;
  /** Synchronous durable-stage callback; commits with every canon write. */
  onSettled?: (result: DramatistPassDetails) => void;
}

export async function runDramatistPass(deps: DramatistPassDeps, input: DramatistPassInput): Promise<DramatistPassDetails> {
  const state = parseState(input.campaignStateJson);
  const roll = input.roll ?? randomInt(1, 101);
  const pacing = resolveDramatistPacing(roll, input.intensity, state);
  const inventory = buildDramatistInventory({
    threadIndexComment: input.threadIndexComment,
    beats: deps.beats.listForCampaign(input.run.campaignId, "pending"),
    drives: deps.drives.listForCampaign(input.run.campaignId),
    playerCharacterKeys: input.playerCharacterKeys,
    tickOrdinal: input.tickOrdinal,
    storyNowEpoch: input.storyNowEpoch ?? null,
  });
  const base = {
    roll: pacing.roll,
    bands: pacing.bands,
    modifiers: pacing.modifiers,
    grant: pacing.grant,
    inventorySize: inventory.length,
    selection: null,
    gates: [],
    armedBeatId: null,
  } satisfies Pick<DramatistPassDetails, "roll" | "bands" | "modifiers" | "grant" | "inventorySize" | "selection" | "gates" | "armedBeatId">;

  if (pacing.grant.kind === "fizzle") {
    return settleWithoutFire(deps, input, state, pacing.roll, inventory, base, "fizzle", "pacing roll granted ADVANCE only");
  }
  if (pacing.grant.kind !== "texture" && inventory.length === 0) {
    recordSystemEvent({
      userId: input.run.userId, source: "world_tick", severity: "info", campaignId: input.run.campaignId,
      message: "Dramatist chamber was empty — quiet scene logged; pressure advances without an invented citation",
      details: { roll: pacing.roll, grant: pacing.grant },
    });
    return settleWithoutFire(deps, input, state, pacing.roll, inventory, base, "fizzle", "empty live inventory");
  }

  const proposalText = await callModel(deps.runs, input, "propose", PROPOSE_SYSTEM,
    `<grant>${JSON.stringify(pacing.grant)}</grant>\n<intensity>${input.intensity}</intensity>\n<player_character_keys>${JSON.stringify(input.playerCharacterKeys)}</player_character_keys>\n<current_scene>${input.sceneSnapshot}</current_scene>\n<recent_window>${input.recentWindow}</recent_window>\n<live_inventory>\n${inventory.map(renderInventoryItem).join("\n\n")}\n</live_inventory>`);
  const proposalParsed = dramatistProposalSchema.safeParse(parseFirstJson<unknown>(proposalText, "{"));
  if (!proposalParsed.success) {
    recordSystemEvent({
      userId: input.run.userId, source: "world_tick", severity: "warn", campaignId: input.run.campaignId,
      message: "Dramatist proposal was not valid JSON/contract — converted to ADVANCE instead of failing open",
      details: { head: proposalText.slice(0, 300), issues: proposalParsed.error.issues.slice(0, 4) },
    });
    return settleWithoutFire(deps, input, state, pacing.roll, inventory, base, "rejected", "proposal contract invalid");
  }
  const checked = validateDramatistSelection(proposalParsed.data, pacing.grant, inventory);
  if (!checked.ok) {
    const outcome = proposalParsed.data.action === "decline" ? "decline" : "rejected";
    return settleWithoutFire(deps, input, state, pacing.roll, inventory, base, outcome, checked.reason);
  }

  const gates = await verifyProposal(deps.runs, input, checked.proposal, checked.item);
  const approvals = gates.filter((gate) => gate.ok).length;
  const passes = checked.proposal.severity === 3 ? approvals >= 2 : gates.length === 1 && approvals === 1;
  if (!passes) {
    recordSystemEvent({
      userId: input.run.userId, source: "world_tick", severity: "info", campaignId: input.run.campaignId,
      message: `Dramatist fire was refuted (${approvals}/${gates.length} gates approved) — converted to ADVANCE`,
      details: { citationId: checked.item?.citationId ?? null, severity: checked.proposal.severity, gates },
    });
    return settleWithoutFire(deps, input, state, pacing.roll, inventory, { ...base, gates }, "rejected", gates.filter((gate) => !gate.ok).map((gate) => gate.reason).join("; "));
  }

  const selection: DramatistPassDetails["selection"] = {
    citationInventoryId: checked.item?.id ?? null,
    citationType: checked.item?.citationType ?? "none",
    citationId: checked.item?.citationId ?? null,
    class: checked.proposal.class,
    severity: checked.proposal.severity,
    timing: checked.proposal.timing,
    description: checked.proposal.description,
    downgraded: checked.downgraded,
  };
  // Events are recorded AFTER the transaction below: the worker process
  // records them on a different connection than the one holding this
  // (IMMEDIATE) write transaction, so an insert from inside would
  // wait out busy_timeout and be lost.
  let dedupedEvent: Parameters<typeof recordSystemEvent>[0] | null = null;
  const settled = deps.lorebook.transact(() => {
    input.signal?.throwIfAborted();
    const finish = (result: DramatistPassDetails) => { input.onSettled?.(result); return result; };
    const armedBeatId = armBeat(deps, input, checked.proposal, checked.item);
    if (armedBeatId === null) {
      // Deduped: createIfNovel refused the description — the proposal
      // re-derived a beat that already exists in SOME status (played, dismissed,
      // or pending under another citation). Nothing landed, so nothing may be
      // booked as a fire: no ledger reset (that zeroed scenesSinceFire and
      // started the severity-2+ cooldown for a beat that will never play — the
      // world went quiet for the whole window), and no scheme step consumed
      // (its declared armsBeat would never arm either, with armStepBeat=false).
      // Pacing settles like a fizzle (the streak alert is exactly the signal a
      // Dramatist stuck re-deriving played beats should raise) but WITHOUT the
      // fizzle path's scheme ADVANCE.
      const nextState = advanceDramatistState(state, { roll: pacing.roll, firedSeverity: null, fizzled: true });
      deps.campaigns.updateDramatistState(input.run.campaignId, JSON.stringify(nextState));
      const reason = `proposal re-derived a beat that already exists ("${checked.proposal.description.slice(0, 80)}") — nothing new to arm`;
      dedupedEvent = {
        userId: input.run.userId, source: "world_tick", severity: "info", campaignId: input.run.campaignId,
        message: "Dramatist fire deduped against an existing beat — no beat armed, no ledger fire, no scheme step consumed",
        details: { citationId: checked.item?.citationId ?? null, severity: checked.proposal.severity, description: checked.proposal.description.slice(0, 200) },
      };
      return finish({ ...base, selection, gates, outcome: "deduped", reason, armedBeatId: null, schemeAdvance: null, state: nextState });
    }
    // The fired proposal IS this step's beat — do not double-arm the step's own
    // armsBeat on the fire path.
    const schemeAdvance = checked.item?.citationType === "scheme" ? advanceScheme(deps, input, checked.item, { armStepBeat: false }) : null;
    const nextState = advanceDramatistState(state, {
      roll: pacing.roll, firedSeverity: checked.proposal.severity as 0 | 1 | 2 | 3, fizzled: false,
    });
    deps.campaigns.updateDramatistState(input.run.campaignId, JSON.stringify(nextState));
    return finish({
      ...base,
      selection,
      gates,
      outcome: "armed",
      reason: null,
      armedBeatId,
      schemeAdvance,
      state: nextState,
    });
  });
  if (dedupedEvent) recordSystemEvent(dedupedEvent);
  return settled;
}

async function settleWithoutFire(
  deps: DramatistPassDeps,
  input: DramatistPassInput,
  state: DramatistState,
  roll: number,
  inventory: DramatistInventoryItem[],
  base: Pick<DramatistPassDetails, "roll" | "bands" | "modifiers" | "grant" | "inventorySize" | "selection" | "gates" | "armedBeatId">,
  outcome: "fizzle" | "decline" | "rejected",
  reason: string,
): Promise<DramatistPassDetails> {
  // Fizzles convert to offscreen ADVANCE work — and an advancing step that
  // defines an armsBeat sets its table: the telegraph/complication it
  // describes is armed sealed, so schemes cannot march silently to fruition
  // through quiet stretches (the tables-being-set intent).
  // The streak warning is recorded AFTER the transaction (see runDramatistPass:
  // the worker's event connection is not the transaction's connection).
  const result = deps.lorebook.transact(() => {
    input.signal?.throwIfAborted();
    // The least-recently-advanced cadence-eligible scheme steps forward:
    // `find` always took the first in inventory (drive-record order
    // = alphabetical), so with several sealed schemes one marched to
    // completion on every fizzle while the rest idled. A sealed record's
    // updatedAt moves only on advances (the drive worker never touches sealed
    // sheets; sealed sheets are 404 on /api/drives), so it is the advance
    // clock; ties keep inventory order.
    const scheme = leastRecentlyAdvancedScheme(deps, input.run.campaignId, inventory);
    const schemeAdvance = scheme ? advanceScheme(deps, input, scheme, { armStepBeat: true }) : null;
    const nextState = advanceDramatistState(state, { roll, firedSeverity: null, fizzled: true });
    deps.campaigns.updateDramatistState(input.run.campaignId, JSON.stringify(nextState));
    const settledResult: DramatistPassDetails = { ...base, outcome, reason, schemeAdvance, state: nextState };
    input.onSettled?.(settledResult);
    return settledResult;
  });
  if (result.state.fizzleStreak === 3 || (result.state.fizzleStreak > 3 && result.state.fizzleStreak % 5 === 0)) {
    recordSystemEvent({
      userId: input.run.userId, source: "world_tick", severity: "warn", campaignId: input.run.campaignId,
      message: `Dramatist has fizzled ${result.state.fizzleStreak} consecutive ticks — inspect Behind the Curtain for inventory/gate tuning`,
      details: { outcome, reason, inventorySize: inventory.length, roll },
    });
  }
  return result;
}

async function verifyProposal(
  runs: PipelineRunRepository,
  input: DramatistPassInput,
  proposal: Extract<DramatistProposal, { action: "fire" }>,
  item: DramatistInventoryItem | null,
): Promise<Array<{ lens: string; ok: boolean; reason: string }>> {
  const lenses = proposal.severity === 3
    ? ["canon grounding and citation ceiling", "player will plus attempt-not-outcome", "tone, timing, and scene fit"]
    : proposal.severity === 2
      ? ["extended: canon, ceiling, knownBy, player will, attempt-not-outcome, tone and scene fit"]
      : ["canon grounding, knownBy, player boundary, and scene fit"];
  const results: Array<{ lens: string; ok: boolean; reason: string }> = [];
  for (let index = 0; index < lenses.length; index += 1) {
    const lens = lenses[index]!;
    const text = await callModel(runs, input, `verify-${index + 1}`, `${VERIFY_SYSTEM}\n\nPRIMARY LENS: ${lens}.`,
      `<proposal>${JSON.stringify(proposal)}</proposal>\n<citation>${JSON.stringify(item)}</citation>\n<player_character_keys>${JSON.stringify(input.playerCharacterKeys)}</player_character_keys>\n<current_scene>${input.sceneSnapshot}</current_scene>\n<canon>${input.canonContext}</canon>`);
    const parsed = parseFirstJson<{ ok?: unknown; reason?: unknown }>(text, "{");
    results.push({
      lens,
      ok: parsed?.ok === true,
      reason: typeof parsed?.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "checker returned no valid supporting verdict",
    });
  }
  return results;
}

async function callModel(
  runs: PipelineRunRepository,
  input: DramatistPassInput,
  stage: string,
  systemPrompt: string,
  userContent: string,
): Promise<string> {
  let output = "";
  runs.heartbeat(input.run.id);
  await withDeadline(WORKER_LLM_DEADLINE_MS, `dramatist ${stage} call`, (deadlineSignal) => withRetry(() => input.runtime.streamChat({
    modelId: input.modelId,
    systemPrompt,
    messages: [{ role: "user", content: userContent, attachments: [] }],
    temperature: 0, thinkingMode: workerThinkingModeFor(input.modelId, input.effort ?? null), thinkingBudget: null, effort: input.effort ?? null, cacheTtl: "off",
    speed: input.speed,
    requestId: `dramatist-${input.run.id}-${stage}`, signal: deadlineSignal,
  }, { onStart: () => {}, onDelta: (delta) => { output += delta; }, onThinkingDelta: () => {}, onComplete: () => {} }), () => { output = ""; }, input.signal), input.signal);
  return output;
}

function armBeat(
  deps: DramatistPassDeps,
  input: DramatistPassInput,
  proposal: Extract<DramatistProposal, { action: "fire" }>,
  item: DramatistInventoryItem | null,
): string | null {
  const now = new Date().toISOString();
  const afterInworld = proposal.timing === "when_due" ? input.storyNow : null;
  const afterEpoch = afterInworld ? parseInWorldDate(afterInworld, input.storyNowEpoch ?? null) : null;
  const citationType = item?.citationType ?? "none";
  const citationId = item?.citationId ?? null;
  const sealed = item?.citationType === "scheme" || item?.sealed === true;
  if (item?.citationType === "beat" && deps.beats.updateFromDramatist(input.run.campaignId, item.citationId, {
    description: proposal.description, class: proposal.class, severity: proposal.severity, timing: proposal.timing,
    citationType, citationId, sourceTickRunId: input.run.id, afterInworld, afterEpoch, sealed,
  })) return item.citationId;
  const id = createId();
  // createIfNovel: the Dramatist re-derives its inventory from campaign state each
  // tick, so a proposal whose description matches an existing beat (any status) is
  // the same tension re-surfacing, not a new development. null = deduped, no beat.
  const wasNovel = deps.beats.createIfNovel({
    id, campaignId: input.run.campaignId, description: proposal.description,
    afterInworld, afterEpoch, sourceEventEntryId: null, sourceTickRunId: input.run.id,
    class: proposal.class, severity: proposal.severity, timing: proposal.timing,
    citationType, citationId, sealed: sealed ? 1 : 0, status: "pending", createdAt: now, updatedAt: now,
  });
  return wasNovel ? id : null;
}

/** The cadence-eligible scheme whose sealed record was advanced longest ago;
 *  inventory order breaks ties. Exported for tests. */
export function leastRecentlyAdvancedScheme(deps: Pick<DramatistPassDeps, "drives">, campaignId: string, inventory: DramatistInventoryItem[]): DramatistInventoryItem | null {
  const schemes = inventory.filter((item) => item.citationType === "scheme" && item.actor);
  if (schemes.length === 0) return null;
  const stamped = schemes.map((item, order) => ({ item, order, updatedAt: deps.drives.findByCharacter(campaignId, item.actor!)?.updatedAt ?? "" }));
  stamped.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.order - b.order));
  return stamped[0]!.item;
}

/** The sealed advance note every scheme advance writes: the
 *  Dramatist's ADVANCE and the threat-clock fire share it, so Behind the
 *  Curtain's sealed trail shows every step regardless of which producer
 *  consumed it. Must run inside the caller's write transaction. */
export function writeSealedSchemeAdvanceNote(lorebook: LorebookRepository, input: { userId: string; campaignId: string; runId: string; characterName: string; stepText: string; fromStep: number; toStep: number; stepCount: number; targetCitation: string; reason: string }): void {
  const content = `SEALED SCHEME ADVANCE — ${input.characterName}\nStep ${input.fromStep + 1}/${input.stepCount}: ${input.stepText}`;
  const now = new Date().toISOString();
  // Scoped context: set for exactly this write and
  // restored after, so the tick's provenance never leaks onto whatever the
  // shared repository instance writes next.
  lorebook.withRevisionContext({ source: "world_tick", pipelineRunId: input.runId }, () => lorebook.create({
    id: createId(), userId: input.userId, campaignId: input.campaignId,
    name: `Sealed scheme advance — ${input.characterName}`,
    tag: "dramatist", content,
    comment: JSON.stringify({ sealedSchemeAdvance: true, sourceTickId: input.runId, actor: input.characterName, fromStep: input.fromStep, toStep: input.toStep, targetCitation: input.targetCitation, reason: input.reason }),
    keys: "[]", keysSecondary: "[]", selectiveLogic: "and_any", scanDepth: 0,
    position: "before_main", insertionOrder: 100, probability: 100,
    isConstant: 0, isEnabled: 1, sticky: 0, cooldown: 0, delay: 0,
    excludeRecursion: 1, preventRecursion: 1, delayUntilRecursion: 0,
    tokensEstimate: estimateTokens(content), knownBy: JSON.stringify([input.characterName]),
    matchOptionsJson: null, legacySource: null, sealed: 1, createdAt: now, updatedAt: now,
  }));
}

function advanceScheme(deps: DramatistPassDeps, input: DramatistPassInput, item: DramatistInventoryItem, opts: { armStepBeat: boolean }): { actor: string; fromStep: number; toStep: number; armedStepBeatId: string | null } | null {
  if (!item.actor) return null;
  const record = deps.drives.findByCharacter(input.run.campaignId, item.actor);
  const scheme = record?.scheme;
  if (!record || !scheme) return null;
  const step = scheme.steps[scheme.currentStep];
  if (!step) return null;
  const nextScheme = { ...scheme, currentStep: Math.min(scheme.steps.length, scheme.currentStep + 1) };
  deps.drives.upsert({
    campaignId: record.campaignId, characterName: record.characterName, sheet: record.sheet,
    turn: record.lastUpdatedTurn, messageId: record.lastUpdatedMessageId, source: "dramatist",
    sealed: true, scheme: nextScheme, reason: `Dramatist tick ${input.run.id}`, recordHistory: false,
  });
  const now = new Date().toISOString();
  writeSealedSchemeAdvanceNote(deps.lorebook, {
    userId: input.run.userId, campaignId: input.run.campaignId, runId: input.run.id, characterName: record.characterName,
    stepText: step.text, fromStep: scheme.currentStep, toStep: nextScheme.currentStep, stepCount: scheme.steps.length, targetCitation: scheme.targetCitation,
    reason: opts.armStepBeat ? "dramatist advance (fizzle/decline converted to offscreen work)" : "dramatist fire",
  });
  // An offscreen advance arms the completed step's declared consequence as a
  // sealed beat; a fire path passes armStepBeat=false because the adjudicated
  // proposal already armed the beat for this step.
  let armedStepBeatId: string | null = null;
  if (opts.armStepBeat && step.armsBeat) {
    const afterInworld = step.armsBeat.timing === "when_due" ? input.storyNow : null;
    const candidateId = createId();
    // createIfNovel: the clock producer can consume the same step (both paths
    // advance it), and a step whose declared consequence already exists as a beat
    // must not arm a second copy of it.
    const wasNovel = deps.beats.createIfNovel({
      id: candidateId, campaignId: input.run.campaignId, description: step.armsBeat.description,
      afterInworld, afterEpoch: afterInworld ? parseInWorldDate(afterInworld, input.storyNowEpoch ?? null) : null,
      sourceEventEntryId: null, sourceTickRunId: input.run.id,
      class: step.armsBeat.class, severity: step.armsBeat.severity, timing: step.armsBeat.timing,
      citationType: "scheme", citationId: record.characterName, sealed: 1,
      status: "pending", createdAt: now, updatedAt: now,
    });
    armedStepBeatId = wasNovel ? candidateId : null;
  }
  return { actor: record.characterName, fromStep: scheme.currentStep, toStep: nextScheme.currentStep, armedStepBeatId };
}

function renderInventoryItem(item: DramatistInventoryItem): string {
  return `${item.id} | type=${item.citationType} | maxSeverity=${item.maxSeverity} | actor=${item.actor ?? "—"} | knownBy=${JSON.stringify(item.knownBy)}\n${item.label}\n${item.detail}`;
}

function parseState(raw: string | null): DramatistState {
  if (!raw) return { ...EMPTY_DRAMATIST_STATE };
  try {
    const parsed = dramatistStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { ...EMPTY_DRAMATIST_STATE };
  } catch {
    return { ...EMPTY_DRAMATIST_STATE };
  }
}
