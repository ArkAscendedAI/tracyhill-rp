import { openaiFastModeFor, workerEffortFor } from "@tracyhill-rp/model-catalog";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

/**
 * World-state extraction — the PRODUCER for phases 3-5.
 * Adversarial World phase 7.
 *
 * ─── WHY A MODEL IS IN THIS LOOP AT ALL ──────────────────────────────────────
 *
 * Rule 2 of this system says the ceiling is code, never language. That rule is
 * about AUTHORITY: no model gets to decide how far the world goes. It is not a
 * claim that we can avoid reading prose — a threat is a speech act, a death is a
 * narrative event, and there is no regex for "did someone just get maimed". So
 * detection is necessarily a model pass, and the design question is not how to
 * avoid one but how to make its bias fail SAFE.
 *
 * BIAS-DIRECTION ANALYSIS (this is the load-bearing argument):
 *
 *   threats       a positivity-biased reader UNDER-detects them — it does not want
 *                 to commit the world to violence. Under-detection leaves today's
 *                 behaviour; over-detection would make the world attack over a
 *                 misread. Bias points the safe way.
 *   consequences  same direction, but a false positive is expensive: a recorded
 *                 death becomes authoritative state, is re-injected as settled
 *                 fact, and SELF-REINFORCES (the next variant is told to honour a
 *                 death that never happened). Hence the refute gate below.
 *   slights       under-detected, so grudge accrues slowly. Safe.
 *   warmth        OVER-detected — this is the disease itself. So this pass never
 *                 reports it, and trust is never raised from prose. Trust is
 *                 earned mechanically elsewhere; see adjustStanding's callers.
 *
 * WHAT THIS PASS MUST NOT BECOME. Not a judge of whether events SHOULD have
 * happened, not a softening detector, not a quality gate. It reads what is on the
 * page and reports it. Every judgement call in it is resolved toward reporting
 * nothing, because a missed threat costs a turn and an invented death costs a
 * campaign.
 */

export interface ExtractedThreat {
  /** Exact character name as it appears in the cast list. */
  source: string;
  target: string;
  /** The concrete act threatened, in the character's own terms. */
  act: string;
}

export interface ExtractedConsequence {
  kind: "death" | "maiming" | "loss" | "ruin";
  subject: string;
  detail: string;
}

export interface ExtractedSlight {
  /** The character who was slighted (NOT the one who gave offence). */
  character: string;
  /** 1 dismissal or insult, 2 betrayal or cruelty. */
  weight: 1 | 2;
  reason: string;
}

export interface ExtractedThreatOutcome {
  threatId: string;
  source: string;
  /** attempted = the character acted on it. defused = it can no longer happen. */
  outcome: "attempted" | "defused";
  note: string;
}

export interface WorldStateExtraction {
  threats: ExtractedThreat[];
  /** Armed fuses this turn settled. Without these an HONOURED threat still runs
   *  down to "expired", so the world would nag about follow-through that already
   *  happened — the fuse has to be closeable, not just armable. */
  threatOutcomes: ExtractedThreatOutcome[];
  consequences: ExtractedConsequence[];
  slights: ExtractedSlight[];
  usage: { modelId: string; inputTokens: number; outputTokens: number } | null;
  /** Set when the call or the parse failed, for the caller's system_event. */
  failure: string | null;
}

const EMPTY: WorldStateExtraction = { threats: [], threatOutcomes: [], consequences: [], slights: [], usage: null, failure: null };

/**
 * The epistemic discipline here mirrors EPISTEMIC_STATUS_RULE in the canon
 * writers, and it is the single most important part of this prompt. Long-form
 * prose is dense with dreams, memories, lies, predictions and offscreen report.
 * Without this the fuse fills up with flashbacks and the ledger records deaths
 * that happened in somebody's nightmare.
 */
const SYSTEM_PROMPT = [
  "You read one turn of collaborative fiction and report what MATERIALLY HAPPENED in the world. Your output is consumed by a machine and written to authoritative campaign state. You are not a critic, an editor, or a judge of whether events should have happened.",
  "",
  "REPORT ONLY events that occurred on the page, in the world, in this turn.",
  "",
  "NEVER report anything that is:",
  "- dreamt, imagined, hallucinated, foreseen, or remembered",
  "- hypothetical, predicted, feared, planned, or merely intended",
  "- spoken as a lie, a boast, a bluff, or a story told by a character",
  "- reported second-hand about events that happened elsewhere or earlier",
  "- described in a flashback, vision, illusion, or dream sequence",
  "",
  "When you cannot tell whether something is real in the world, report nothing. A missed event is harmless. An invented one corrupts the campaign permanently.",
  "",
  "THREATS. A threat is a named character stating or clearly implying that they will do specific harm to a named target. Report the concrete act. Do not report vague menace, atmosphere, insults without an act, or a character's private intention that was never expressed.",
  "",
  "CONSEQUENCES. Report only material, irreversible outcomes:",
  '- "death": the character is dead. Unambiguous and final. If they might be unconscious, dying, presumed dead, or missing, this is NOT a death.',
  '- "maiming": permanent physical damage — a lost limb, eye, or faculty; a disfiguring wound.',
  '- "loss": a permanent loss of something material — a place, a resource, a relationship ended by death or exile.',
  '- "ruin": a permanent loss of standing — reputation destroyed, position stripped, secret exposed beyond recovery.',
  "",
  "SLIGHTS. Report a character who was insulted, dismissed, betrayed, or treated with cruelty, and by what. Weight 1 for an insult or a dismissal, 2 for a betrayal or deliberate cruelty. Report the character who RECEIVED it. Never report warmth, kindness, gratitude, or approval — those are not tracked here.",
  "",
  'THREAT OUTCOMES. You may be given a list of threats already on record. For each one that this turn SETTLED, report it: "attempted" when the character actually moved on it (they struck, seized, exposed, took, or tried and failed), "defused" when it can no longer happen (they were stopped, bought off, satisfied, imprisoned, or the target is beyond reach). Report nothing for a threat that is merely still pending.',
  "",
  "Use exact names from the cast list. Ignore any character not on it.",
  "",
  "Output STRICT JSON only, no prose, no code fence. Every array is required; use [] when there is nothing to report:",
  '{"threats":[{"source":"","target":"","act":""}],"threatOutcomes":[{"threatId":"ID from threats_on_record","source":"","outcome":"attempted|defused","note":""}],"consequences":[{"kind":"death|maiming|loss|ruin","subject":"","detail":""}],"slights":[{"character":"","weight":1,"reason":""}]}',
].join("\n");

/**
 * Keep BOTH ends of a long passage. Producers read prose whose state changes
 * land at turn ENDINGS; the plain
 * head slice this replaced (2026-09-02) fed the extractor the opening of a long
 * turn and dropped a death written in its last paragraph — and the refuter,
 * handed the same head, could not see the body and refuted it (fail-closed by
 * design), so the ledger silently stayed wrong. The head stays for context
 * (who is in the scene); the tail takes the larger share because that is
 * where the events are. The elision marker tells the reader something is
 * missing rather than letting the two halves read as contiguous.
 */
export function headAndTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const elided = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${elided} characters elided …]\n${text.slice(-tail)}`;
}

/** Deliberately narrow: only the newest exchange. A wider window re-reports
 *  events from earlier turns that were already recorded, and the fingerprint
 *  guard should not be the only thing standing between us and duplicates. */
export function buildExtractionInput(input: {
  userTurn: string;
  assistantTurn: string;
  cast: string[];
  armedThreats?: Array<{ id: string; sourceCharacter: string; target: string; statedAct: string }>;
}): string {
  const armed = input.armedThreats ?? [];
  return [
    `<cast>${input.cast.join(" | ")}</cast>`,
    "",
    ...(armed.length > 0
      ? [
          "<threats_on_record>",
          ...armed.map((t) => `- [${t.id}] ${t.sourceCharacter} → ${t.target}: ${t.statedAct}`),
          "</threats_on_record>",
          "",
        ]
      : []),
    "<previous_user_turn>",
    headAndTail(input.userTurn, 2000, 2000),
    "</previous_user_turn>",
    "",
    "<turn_to_read>",
    headAndTail(input.assistantTurn, 4000, 8000),
    "</turn_to_read>",
  ].join("\n");
}

/**
 * Locate and parse the first COMPLETE JSON object in a model reply.
 *
 * Balanced-brace scan, replacing the greedy `\{[\s\S]*\}` (2026-09-02). The
 * greedy match ran from the first `{` to the LAST `}`, so a reply truncated by
 * the output cap after any nested `}`, valid JSON followed by prose containing
 * a brace, or two objects in one reply all "matched" and then failed
 * JSON.parse — and the caller, which tested the same regex to decide whether
 * the response was a failure, saw braces and reported a quiet turn. The result
 * is tagged so "no JSON at all" and "JSON that did not parse" are both visible
 * as degradations; neither may look like nothing happened.
 *
 * A balanced span that fails to parse (prose braces before the JSON) is skipped
 * and the scan resumes at the next `{`; a span that never closes is a
 * truncated reply.
 */
type JsonScan =
  | { status: "parsed"; value: unknown }
  | { status: "none" }
  | { status: "unparseable"; reason: string };

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function scanJsonObject(text: string): JsonScan {
  let start = text.indexOf("{");
  if (start < 0) return { status: "none" };
  let firstFailure: string | null = null;
  while (start >= 0) {
    const end = balancedEnd(text, start);
    if (end < 0) {
      return { status: "unparseable", reason: firstFailure ?? "JSON object never closed — truncated reply" };
    }
    try {
      return { status: "parsed", value: JSON.parse(text.slice(start, end + 1)) };
    } catch (err) {
      firstFailure ??= err instanceof Error ? err.message : String(err);
    }
    start = text.indexOf("{", start + 1);
  }
  return { status: "unparseable", reason: firstFailure ?? "no balanced JSON object parsed" };
}

function cleanName(value: unknown, cast: Set<string>): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Case-insensitive match back onto the canonical cast spelling: the extractor
  // is reading prose, and prose does not agree with the roster about casing.
  for (const name of cast) {
    if (name.toLocaleLowerCase() === trimmed.toLocaleLowerCase()) return name;
  }
  return null;
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

const NO_EVENTS: Omit<WorldStateExtraction, "usage" | "failure"> = { threats: [], threatOutcomes: [], consequences: [], slights: [] };

/**
 * Parse the extractor's reply. `failure` is the PARSE verdict — set whenever
 * the reply did not yield the JSON shape the prompt demands — so the caller
 * raises a system_event on it instead of recording a quiet turn. Before
 * 2026-09-02 the caller derived failure from "does the text contain braces",
 * which a truncated or prose-wrapped reply satisfies while parsing to nothing.
 */
export function parseExtraction(text: string, cast: string[]): Omit<WorldStateExtraction, "usage"> {
  const scan = scanJsonObject(text);
  if (scan.status === "none") return { ...NO_EVENTS, failure: "extraction response contained no JSON object" };
  if (scan.status === "unparseable") return { ...NO_EVENTS, failure: `extraction response JSON did not parse (${scan.reason})` };
  const parsed = scan.value as
    | { threats?: unknown; threatOutcomes?: unknown; consequences?: unknown; slights?: unknown }
    | null;
  // The prompt requires all four arrays. An object carrying none of them is a
  // different reply shape (a refusal object, a wrapped answer, the wrong
  // model) and is a degradation, not a quiet turn.
  if (!parsed || typeof parsed !== "object"
    || ![parsed.threats, parsed.threatOutcomes, parsed.consequences, parsed.slights].some(Array.isArray)) {
    return { ...NO_EVENTS, failure: "extraction response JSON carried none of the required arrays (threats/threatOutcomes/consequences/slights)" };
  }
  for (const [field, value] of Object.entries(parsed)) {
    if (["threats", "threatOutcomes", "consequences", "slights"].includes(field)
      && (!Array.isArray(value) || value.some(member => !member || typeof member !== "object" || Array.isArray(member)))) {
      return { ...NO_EVENTS, failure: `extraction ${field} contains an invalid member or is not an array` };
    }
  }
  const castSet = new Set(cast.map((n) => n.trim()).filter(Boolean));

  const threats: ExtractedThreat[] = (Array.isArray(parsed.threats) ? parsed.threats : []).flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const source = cleanName(r.source, castSet);
    const act = shortText(r.act, 1000);
    // The target may legitimately be the player character, who is not on the NPC
    // cast list — so it is free text, while the source must be a known character
    // (something has to burn the fuse, and only cast members take turns).
    const target = shortText(r.target, 200);
    if (!source || !act || !target) return [];
    return [{ source, target, act }];
  });

  const consequences: ExtractedConsequence[] = (Array.isArray(parsed.consequences) ? parsed.consequences : []).flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const kind = typeof r.kind === "string" ? r.kind.trim().toLocaleLowerCase() : "";
    if (kind !== "death" && kind !== "maiming" && kind !== "loss" && kind !== "ruin") return [];
    const subject = shortText(r.subject, 200);
    const detail = shortText(r.detail, 2000);
    if (!subject || !detail) return [];
    return [{ kind, subject, detail }];
  });

  const slights: ExtractedSlight[] = (Array.isArray(parsed.slights) ? parsed.slights : []).flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const character = cleanName(r.character, castSet);
    const reason = shortText(r.reason, 300);
    if (!character || !reason) return [];
    const weight = r.weight === 2 ? 2 : 1;
    return [{ character, weight, reason: reason }];
  });

  const threatOutcomes: ExtractedThreatOutcome[] = (Array.isArray(parsed.threatOutcomes) ? parsed.threatOutcomes : []).flatMap((raw) => {
    const r = raw as Record<string, unknown>;
    const source = cleanName(r.source, castSet);
    const outcome = typeof r.outcome === "string" ? r.outcome.trim().toLocaleLowerCase() : "";
    if (!source || (outcome !== "attempted" && outcome !== "defused")) return [];
    const threatId = shortText(r.threatId, 200);
    if (!threatId) return [];
    return [{ threatId, source, outcome, note: shortText(r.note, 300) ?? outcome }];
  });

  return { threats, threatOutcomes, consequences, slights, failure: null };
}

/**
 * Read the turn. Never throws: a failed extraction degrades to "nothing
 * happened", which is the same as the pre-phase-7 behaviour. The failure string
 * is returned rather than swallowed so the caller can raise a system_event —
 * silent degradation in a passive subsystem is the thing this codebase has been
 * burned by repeatedly.
 */
export async function extractWorldState(input: {
  runtime: ChatRuntime | null;
  modelId: string;
  userTurn: string;
  assistantTurn: string;
  cast: string[];
  armedThreats?: Array<{ id: string; sourceCharacter: string; target: string; statedAct: string }>;
  /** Engine → Pipeline `workerEffort`. Resolves to the model's top rung by
   *  default, and is null on families where thinking (not effort) is the knob. */
  workerEffort?: string | null;
  /** Session dial `openaiFastModeEnabled` (2026-09-09), resolved per model. */
  openaiFastMode?: boolean | null;
  requestId?: string;
  signal?: AbortSignal;
}): Promise<WorldStateExtraction> {
  const { runtime, modelId, cast } = input;
  if (!runtime || !modelId.trim() || !input.assistantTurn.trim() || cast.length === 0) return EMPTY;

  let responseText = "";
  let usage: WorldStateExtraction["usage"] = null;
  try {
    await runtime.streamChat({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildExtractionInput(input), attachments: [] }],
      temperature: 0,
      // REASONING ON (2026-07-29). This pass writes authoritative
      // campaign state off a reading of prose, so accuracy dominates: a missed
      // event costs a turn, a misread one corrupts canon. It runs AFTER the reply
      // is on screen, so its latency is invisible unless turns are sent minutes
      // apart — and they are not.
      //
      // "adaptive" is the one value that means "think" across every family: on
      // Anthropic and the bridges only "off" disables thinking; z.ai, DeepSeek,
      // Xiaomi and Moonshot map adaptive to {type:"enabled"}; the effort-ladder
      // providers (OpenAI/xAI/Fireworks/CodexBridge) take their depth from `effort`
      // below, which workerEffortFor pins to the model's top rung.
      thinkingMode: "adaptive",
      thinkingBudget: null,
      effort: workerEffortFor(modelId, input.workerEffort ?? "model-max"),
      cacheTtl: "off",
      speed: openaiFastModeFor(modelId, input.openaiFastMode),
      requestId: input.requestId ?? `world-extract-${Date.now()}`,
      signal: input.signal,
    }, {
      onStart: () => {},
      onDelta: (delta) => { responseText += delta; },
      onThinkingDelta: () => {},
      onComplete: (result) => {
        usage = { modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
      },
    });
  } catch (err) {
    return { ...EMPTY, failure: err instanceof Error ? err.message : String(err) };
  }

  // `failure` comes from the parse itself (parseExtraction): an unparseable
  // response is a real degradation (wrong model, refusal, truncation) and must
  // not look like a quiet turn.
  return { ...parseExtraction(responseText, cast), usage };
}

const REFUTE_SYSTEM = [
  "You are checking a claim that a character DIED in a passage of fiction, before that death is written to permanent campaign state. Default to REFUTING.",
  "",
  "The claim survives ONLY if the passage puts the death beyond doubt: the character is dead, in the world, now, on the page.",
  "",
  "REFUTE if the passage shows any of:",
  "- the character unconscious, dying, gravely wounded, or fading",
  "- the death presumed, feared, reported, assumed, or implied rather than shown",
  "- the character missing, taken, fallen, or lost without a body",
  "- the death occurring in a dream, vision, memory, hypothetical, or lie",
  "- any route by which the character could still be alive",
  "",
  "A death written to state cannot be undone by rewriting the scene. If you are not certain, refute.",
  "",
  'Output STRICT JSON only: {"refuted":true|false,"reason":"<one sentence>"}',
].join("\n");

/**
 * Adversarial gate on the one class where a false positive is expensive. Deaths
 * only: maiming, loss and ruin are recoverable enough that a wrong row is worth
 * the saved call, and the owner can dismiss any of them.
 *
 * Fails CLOSED — if the gate cannot run, the death is refuted. A death we decline
 * to record is a death the next turn can record again; a death we invent is
 * permanent.
 */
export async function refuteDeath(input: {
  runtime: ChatRuntime | null;
  modelId: string;
  subject: string;
  detail: string;
  passage: string;
  workerEffort?: string | null;
  openaiFastMode?: boolean | null;
  requestId?: string;
  signal?: AbortSignal;
}): Promise<{ refuted: boolean; reason: string }> {
  const { runtime, modelId } = input;
  if (!runtime || !modelId.trim()) return { refuted: true, reason: "no runtime available to verify the death" };

  let text = "";
  try {
    await runtime.streamChat({
      modelId,
      systemPrompt: REFUTE_SYSTEM,
      messages: [{
        role: "user",
        content: [
          `<claim>${input.subject} died: ${input.detail}</claim>`,
          "",
          "<passage>",
          // Same window as the extractor's <turn_to_read>, so the refuter sees
          // the paragraph the claim came from rather than a head slice that
          // ends before the body hits the floor.
          headAndTail(input.passage, 4000, 8000),
          "</passage>",
        ].join("\n"),
        attachments: [],
      }],
      temperature: 0,
      // Reasoning on here too, and for a stronger reason than the extractor: this
      // is the gate standing between a misread sentence and a permanent, self-
      // reinforcing death in the ledger. Same post-stream position, same invisible
      // latency.
      thinkingMode: "adaptive",
      thinkingBudget: null,
      effort: workerEffortFor(modelId, input.workerEffort ?? "model-max"),
      cacheTtl: "off",
      speed: openaiFastModeFor(modelId, input.openaiFastMode),
      requestId: input.requestId ?? `death-refute-${Date.now()}`,
      signal: input.signal,
    }, {
      onStart: () => {},
      onDelta: (delta) => { text += delta; },
      onThinkingDelta: () => {},
      onComplete: () => {},
    });
  } catch (err) {
    return { refuted: true, reason: `verification failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const scan = scanJsonObject(text);
  const parsed = scan.status === "parsed" ? (scan.value as { refuted?: unknown; reason?: unknown }) : null;
  if (!parsed || typeof parsed.refuted !== "boolean") {
    return { refuted: true, reason: "verification returned no verdict" };
  }
  return {
    refuted: parsed.refuted,
    reason: shortText(parsed.reason, 300) ?? (parsed.refuted ? "refuted" : "confirmed"),
  };
}

/** Stable identity for a threat, so a menace restated across three turns arms one
 *  fuse instead of three. Mirrors the audit's fingerprint discipline. */
export function threatFingerprint(source: string, target: string, act: string): string {
  // Unicode-aware like consequenceFingerprint: the ASCII
  // class stripped every non-Latin letter, so "Éowyn" printed as "owyn" and two
  // Cyrillic antagonists with different acts collapsed into one fuse.
  const norm = (s: string) => s.toLocaleLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
  return `${norm(source)}→${norm(target)}:${norm(act)}`;
}

/** Death dedupes by subject; other consequences also include the detail so
 *  distinct losses or injuries do not collapse into one historical event. */
export function consequenceFingerprint(kind: string, subject: string, detail = ""): string {
  const normalize = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // A person can die once, but lose several things or suffer distinct injuries.
  return `${kind}:${normalize(subject)}${kind === "death" ? "" : `:${normalize(detail)}`}`;
}
