import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { openaiFastModeFor } from "@tracyhill-rp/model-catalog";

import type { ContestedOutcome } from "./adversarialWorldRepository";
import { headAndTail, scanJsonObject } from "./worldStateExtraction";

/**
 * Contested actions — the PRODUCER for resolveContested.
 * Adversarial World phase 7.
 *
 * ─── THE ARCHITECTURAL POINT ─────────────────────────────────────────────────
 *
 * Commit-before-reveal reads like it needs two render passes (declare the stake,
 * resolve, then narrate) which would double latency on every contested turn. It
 * does not. The user's input is available BEFORE the render call, so:
 *
 *   user writes "I put my shoulder to the door"
 *     → cheap classifier says: contested, physical, hard
 *     → code rolls (CSPRNG) and weights by worldStance
 *     → the outcome is injected as a constraint the turn must render
 *
 * One pass. The render model never sees a choice point — it is told what happened
 * and writes it. That is the whole mechanism: models are documented fudging rolls
 * and retconning defeats, so the model must not be holding the dice.
 *
 * NPC-initiated contests come free from the antagonist-intent pass, which already
 * authors "what does she do, by what means" — see runAntagonistIntent's `contest`
 * field. Phases 2 and 3 compose.
 *
 * ─── AUTHORITY TRANSFER (the reason the framing matters) ──────────────────────
 *
 * Server-side resolution is not only an anti-fudging device, it is a PERMISSION
 * device. A positivity-biased model resists CHOOSING to hurt <user>, but readily
 * REPORTS a harm that something else already decided. So the injected block says
 * the mechanics resolved this and the turn's job is to render it faithfully —
 * the same framing that makes <antagonist_intent> work. The model is not being
 * asked to be cruel; it is being asked to be accurate.
 *
 * Bias direction on the classifier is favourable: a biased reader UNDER-detects
 * contests, and a missed contest just means the turn resolves the way it would
 * have before phase 7.
 */

export type ContestKind = "physical" | "social" | "stealth" | "deception";

export interface ClassifiedContest {
  kind: ContestKind;
  /** What <user> is attempting, in their own terms. */
  action: string;
  /** Who or what opposes it. Free text — may be a character, a group, or a thing. */
  opposition: string;
  /** Maps to a base success window before stance weighting. */
  difficulty: "easy" | "moderate" | "hard" | "desperate";
}

export interface ContestClassification {
  contest: ClassifiedContest | null;
  usage: { modelId: string; inputTokens: number; outputTokens: number } | null;
  failure: string | null;
}

/** Base success windows, pre-stance. resolveContested multiplies these by the
 *  stance bias, so at predatory (×0.6) a desperate attempt sits near the floor
 *  while an easy one is still usually fine — the dial changes the shape of the
 *  distribution rather than flipping everything to failure. */
const DIFFICULTY_TARGET: Record<ClassifiedContest["difficulty"], number> = {
  easy: 75,
  moderate: 55,
  hard: 40,
  desperate: 25,
};

const SYSTEM_PROMPT = [
  "You read one turn written by a player in collaborative fiction and decide whether it attempts something that could FAIL. Your output is consumed by a machine that resolves the outcome with dice; you never decide the outcome yourself.",
  "",
  "A turn is CONTESTED only when there is GENUINE UNCERTAINTY: real opposition acting against the attempt right now, a capability being pushed past anything the character has demonstrated, or stakes the character cannot control. Forcing, striking, seizing, sneaking, lying, intimidating, seducing, persuading against someone's interest — when something real resists.",
  "",
  "A turn is NOT contested when the player is:",
  "- talking, asking, answering, or reacting",
  "- moving, looking, waiting, or resting without hazard",
  "- doing something their competence makes routine",
  "- exercising an established capability the scene shows them wielding at this scale — a master healer healing, a teleporter teleporting, a titan lifting. Raw power exercised on a passive target is DEMONSTRATION, not contest, no matter how dramatic the prose. It becomes contested only when an ACTIVE countermeasure, ward, or rival power resists it in this scene",
  "- doing something nobody and nothing opposes",
  "- describing a feeling, a thought, or an intention",
  "",
  "The dice exist for unknowns, not for drama. A contest you invent where the character's demonstrated power makes the outcome effectively certain does not create tension — it creates an outcome the fiction cannot explain. When in doubt, answer not contested. A missed contest costs nothing; a roll on routine competence is intrusive and wrong.",
  "",
  "KIND: physical (force, violence, athletics), social (persuasion, intimidation, seduction), stealth (moving or acting unseen), deception (lying, disguise, forgery).",
  "",
  "DIFFICULTY, judged against what the player character can plausibly do:",
  '- "easy": likely to work, but failure is possible',
  '- "moderate": a real coin-toss',
  '- "hard": the opposition has the advantage',
  '- "desperate": long odds; it would take luck',
  "",
  "Output STRICT JSON only, no prose, no code fence:",
  '{"contested":false} or {"contested":true,"kind":"physical|social|stealth|deception","action":"<what they attempt>","opposition":"<who or what resists>","difficulty":"easy|moderate|hard|desperate"}',
].join("\n");

export function parseContest(text: string): ClassifiedContest | null {
  const scan = scanJsonObject(text);
  return scan.status === "parsed" ? contestFromParsed(scan.value) : null;
}

function contestFromParsed(value: unknown): ClassifiedContest | null {
  const parsed = value as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object" || parsed.contested !== true) return null;
  const kind = typeof parsed.kind === "string" ? parsed.kind.trim().toLocaleLowerCase() : "";
  if (kind !== "physical" && kind !== "social" && kind !== "stealth" && kind !== "deception") return null;
  const difficulty = typeof parsed.difficulty === "string" ? parsed.difficulty.trim().toLocaleLowerCase() : "";
  if (difficulty !== "easy" && difficulty !== "moderate" && difficulty !== "hard" && difficulty !== "desperate") return null;
  const action = typeof parsed.action === "string" ? parsed.action.trim().slice(0, 400) : "";
  if (!action) return null;
  const opposition = typeof parsed.opposition === "string" ? parsed.opposition.trim().slice(0, 200) : "";
  return { kind, action, opposition: opposition || "the situation", difficulty };
}

export function baseTargetFor(contest: ClassifiedContest): number {
  return DIFFICULTY_TARGET[contest.difficulty];
}

/**
 * Classify the player's turn. Never throws — a failure means the turn resolves
 * without a contest, which is the pre-phase-7 behaviour.
 */
export async function classifyContestedAction(input: {
  runtime: ChatRuntime | null;
  modelId: string;
  userTurn: string;
  sceneSummary: string;
  requestId?: string;
  /** The chat turn's abort signal (2026-09-04): a user Stop during the
   *  pre-stream phases ends this call at once; an aborted classification is
   *  "not contested", not a failure. */
  signal?: AbortSignal;
  /** Session dial `openaiFastModeEnabled` (2026-09-09), resolved per model. */
  openaiFastMode?: boolean | null;
}): Promise<ContestClassification> {
  const { runtime, modelId } = input;
  if (!runtime || !modelId.trim() || !input.userTurn.trim() || input.signal?.aborted) {
    return { contest: null, usage: null, failure: null };
  }

  let text = "";
  let usage: ContestClassification["usage"] = null;
  try {
    await runtime.streamChat({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          // TAIL-sliced (2026-09-02). The caller builds a six-turn window whose
          // messages are each tail-sliced (state changes land at
          // turn endings) and whose NEWEST turn sits at the end — up to ~6.1k
          // chars. The old `slice(0, 3000)` kept the first ~3 turns and dropped
          // the authoritative present, so the classifier judged the action
          // against a scene three turns stale. The cap sits above the caller's
          // budget; when it does cut, it cuts the oldest turn first.
          `<scene>${input.sceneSummary.slice(-8000)}</scene>`,
          "",
          "<player_turn>",
          headAndTail(input.userTurn, 2000, 2000),
          "</player_turn>",
        ].join("\n"),
        attachments: [],
      }],
      temperature: 0,
      // This one runs BEFORE the render call, so it is on the critical path for
      // perceived latency. Kept deliberately cheap and mechanical.
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      speed: openaiFastModeFor(modelId, input.openaiFastMode),
      requestId: input.requestId ?? `contest-classify-${Date.now()}`,
      signal: input.signal,
    }, {
      onStart: () => {},
      onDelta: (delta) => { text += delta; },
      onThinkingDelta: () => {},
      onComplete: (result) => {
        usage = { modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
      },
    });
  } catch (err) {
    if (input.signal?.aborted) return { contest: null, usage: null, failure: null };
    return { contest: null, usage: null, failure: err instanceof Error ? err.message : String(err) };
  }

  // A reply with no parseable JSON is a degradation (wrong model, refusal,
  // truncation), reported as `failure` so the caller's note distinguishes it
  // from a genuine "not contested" — the same rule as the extractor.
  const scan = scanJsonObject(text);
  if (scan.status === "none") return { contest: null, usage, failure: "classifier response contained no JSON object" };
  if (scan.status === "unparseable") return { contest: null, usage, failure: `classifier response JSON did not parse (${scan.reason})` };
  return { contest: contestFromParsed(scan.value), usage, failure: null };
}

/**
 * The injected constraint. Authority-transfer register: the mechanics resolved
 * this, the turn renders it. Note what is absent — no "consider whether", no
 * "you may", and no invitation to soften a failure into a near-miss. The roll and
 * target ride along so a result is auditable after the fact from the transcript
 * alone.
 */
export function buildContestedBlock(input: {
  contest: ClassifiedContest;
  outcome: ContestedOutcome;
  playerName: string;
}): string {
  const { contest, outcome, playerName } = input;
  const verdict = outcome.success ? "SUCCEEDS" : "FAILS";
  const consequence = outcome.success
    ? "Render it working, and render what it costs or sets in motion."
    : "Render the failure as it happens and let it land. The attempt does not partly work, and it is not deferred to a later try in this same moment.";
  const lines = [
    "<contested_outcome>",
    "This was resolved by the world's mechanics before this turn was written. It is not a judgement call and not open to reconsideration. Render the result exactly as given.",
    `- ${playerName} attempts: ${contest.action}`,
    `- Opposition: ${contest.opposition}`,
    `- Result: ${verdict} (rolled ${outcome.roll} against ${outcome.target})`,
  ];
  if (outcome.basis.length > 0) lines.push(`- Weighting: ${outcome.basis.join(", ")}`);
  lines.push(consequence, "</contested_outcome>");
  return lines.join("\n");
}

// NPC-side contests are rendered INSIDE <antagonist_intent> (antagonistIntent.ts),
// one line per intent, so the turn is never handed "carry this out" and "this
// failed" as two competing blocks. The standalone `buildNpcContestedBlock` that
// used to live here had no caller but its own test and was removed 2026-09-02.

/**
 * Standing modifiers for social contests. Trust makes persuasion easier, grudge
 * makes it harder, and neither touches a physical contest — a friendly guard is
 * no easier to overpower.
 *
 * Deliberately asymmetric in magnitude: grudge bites harder than trust helps,
 * because the failure this whole system exists to prevent is a world that warms
 * up too easily.
 */
export function standingModifiers(input: {
  kind: ContestKind;
  trust: number;
  grudge: number;
  characterName: string;
}): { label: string; value: number }[] {
  if (input.kind === "physical" || input.kind === "stealth") return [];
  const mods: { label: string; value: number }[] = [];
  const trustBonus = Math.min(10, Math.round(input.trust / 8));
  const grudgePenalty = Math.min(20, Math.round(input.grudge / 4));
  if (trustBonus > 0) mods.push({ label: `${input.characterName} trusts <user>`, value: trustBonus });
  if (grudgePenalty > 0) mods.push({ label: `${input.characterName} holds a grudge`, value: -grudgePenalty });
  return mods;
}
