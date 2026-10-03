import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { openaiFastModeFor } from "@tracyhill-rp/model-catalog";

import { scanJsonObject } from "./worldStateExtraction";

/**
 * Antagonist-intent pass — the strongest evidence-backed counter to villain
 * softening.
 *
 * WHY THIS EXISTS. Villain fidelity is a measured disposition of the model, not
 * a prompting failure on our side. The Moral RolePlay benchmark (arXiv
 * 2511.04962) finds character fidelity falling monotonically as characters get
 * more evil, Claude-family models ranking near the BOTTOM despite topping general
 * benchmarks, and the largest penalties landing on exactly the traits that make
 * an antagonist worth having — Hypocritical, Deceitful, Selfish, Manipulative.
 * The documented failure is that models replace competent malice with either
 * cartoon aggression or unearned remorse. GLM, DeepSeek and Kimi take the top
 * three places.
 *
 * So the antagonist's DECISION is authored by a model that is good at it, and the
 * prose model receives that decision as a constraint to render rather than a
 * question to answer. It never gets to decide whether the villain relents.
 *
 * TWO DESIGN CONSTRAINTS THAT LOOK WRONG BUT ARE DELIBERATE:
 *
 * 1. Thinking is OFF on this call. The same paper measured that explicit
 *    reasoning makes villain portrayal slightly WORSE — plausibly by activating
 *    cautious deliberation. The popular "make it scheme in a <thinking> block"
 *    advice is backwards here.
 * 2. The prompt asks WHAT THEY DO, never whether they should. Moral deliberation
 *    is the failure mode; keep the question operational.
 *
 * Inert unless an antagonist model is configured AND a sealed antagonist is
 * actually present, so the default costs nothing — no dial, no call.
 */

export interface AntagonistBrief {
  name: string;
  /** Sealed scheme text, if the character has one under way. */
  scheme: string | null;
  wants: string[];
  redLines: string[];
  leverage: string[];
  concealment: string[];
}

export interface AntagonistIntentResult {
  block: string | null;
  usage: { modelId: string; inputTokens: number; outputTokens: number } | null;
  /** Contests this pass declared and the caller resolved, for telemetry. `basis`
   *  is the resolver's weighting trail (modifiers, stance, owner override). */
  resolved: Array<{ actor: string; action: string; success: boolean; roll: number; target: number; basis: string[] }>;
  /**
   * Set when the CALL or the PARSE failed — distinct from "the model returned
   * no intents", which is a legitimate quiet turn (block null, failure null).
   * Returned rather than swallowed (2026-09-02) so the caller can raise a
   * system_event: with an antagonist model on a per-user key, an expired key
   * or a provider outage would otherwise disable phase 2 silently behind the
   * same "returned nothing" note as a genuine no-move turn.
   */
  failure: string | null;
}

/**
 * Supplied by the caller so the ROLL stays in code. Returning null means the
 * contest could not be resolved, and the action renders as a plain intent.
 *
 * FRAME CONTRACT: `success` is the ANTAGONIST's success, but `roll` and
 * `target` are in <user>'s frame — the caller rolls <user>'s resistance
 * (one weighting rule for the whole system) and inverts the verdict, so the
 * antagonist's move lands when the roll is ABOVE `target`. The rendered line
 * says so, because a bare "FAILS (rolled 78 against 45)" reads as a
 * contradiction to anyone using the PC block's roll-under convention.
 * `basis` is printed verbatim: it is where the owner override stamp lives.
 */
export type IntentContestResolver = (input: {
  actor: string;
  action: string;
  opposes: string;
  difficulty: IntentDifficulty;
}) => { success: boolean; roll: number; target: number; basis: string[] } | null;

const SYSTEM_PROMPT = [
  "You decide what antagonists DO next in a work of fiction. You are not writing prose; another system renders it. Output is consumed by a machine.",
  "",
  "For each antagonist you are given, state the single concrete action they take next and the means they use.",
  "Ground every action in the material you are given: a want, a scheme step, a piece of leverage, or something they are concealing. Name which one it comes from.",
  "An antagonist who has not been beaten, exposed, outmaneuvered, or bought is still winning, and acts like it.",
  "Deception, coercion, patience, proxies, betrayal, purchase and force are all available. Choose the one this character's own history supports.",
  "Where a character holds leverage, spending it is an action. Where a character conceals something, protecting the concealment is an action.",
  "",
  "CONTESTS. When the action is something that could FAIL against real opposition — striking, seizing, coercing, deceiving, or taking something from someone who would stop them — add a \"contest\" object naming what opposes it and how long the odds are. Dice outside your control will resolve it; you are declaring the stake, not the result. Omit \"contest\" when the action meets no opposition (giving an order, making a call, waiting, moving, preparing).",
  "",
  "Output STRICT JSON only, no prose, no code fence:",
  '{"intents":[{"name":"<exact character name>","action":"<one sentence: what they do>","means":"<the tactic in use>","basis":"<the want, scheme step, leverage or secret it derives from>","contest":{"opposes":"<who or what resists>","difficulty":"easy|moderate|hard|desperate"}}]}',
].join("\n");

function briefToPrompt(brief: AntagonistBrief): string {
  const lines = [`<antagonist name="${brief.name}">`];
  if (brief.scheme) lines.push(`  <scheme>${brief.scheme}</scheme>`);
  if (brief.wants.length) lines.push(`  <wants>${brief.wants.join(" | ")}</wants>`);
  if (brief.redLines.length) lines.push(`  <will_do>${brief.redLines.join(" | ")}</will_do>`);
  if (brief.leverage.length) lines.push(`  <leverage>${brief.leverage.join(" | ")}</leverage>`);
  if (brief.concealment.length) lines.push(`  <conceals>${brief.concealment.join(" | ")}</conceals>`);
  lines.push("</antagonist>");
  return lines.join("\n");
}

export type IntentDifficulty = "easy" | "moderate" | "hard" | "desperate";

interface ParsedIntent {
  name: string;
  action: string;
  means: string;
  basis: string;
  contest: { opposes: string; difficulty: IntentDifficulty } | null;
}

function parseContest(raw: unknown): ParsedIntent["contest"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const difficulty = typeof r.difficulty === "string" ? r.difficulty.trim().toLocaleLowerCase() : "";
  if (difficulty !== "easy" && difficulty !== "moderate" && difficulty !== "hard" && difficulty !== "desperate") return null;
  const opposes = typeof r.opposes === "string" ? r.opposes.trim().slice(0, 200) : "";
  return { opposes: opposes || "<user>", difficulty };
}

/** Tagged so the caller can tell a parse failure from an empty intents list —
 *  the same distinction the extractor draws (worldStateExtraction.ts). */
function parseIntents(text: string): { intents: ParsedIntent[]; failure: string | null } {
  const scan = scanJsonObject(text);
  if (scan.status === "none") return { intents: [], failure: "intent response contained no JSON object" };
  if (scan.status === "unparseable") return { intents: [], failure: `intent response JSON did not parse (${scan.reason})` };
  const parsed = scan.value as { intents?: unknown } | null;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.intents)) {
    return { intents: [], failure: "intent response JSON carried no intents array" };
  }
  const intents = parsed.intents
    .filter((raw): raw is ParsedIntent => {
      const r = raw as Partial<ParsedIntent>;
      return typeof r?.name === "string" && typeof r?.action === "string" && Boolean(r.name.trim() && r.action.trim());
    })
    .map((r) => ({
      name: r.name.trim(),
      action: r.action.trim(),
      means: typeof r.means === "string" ? r.means.trim() : "",
      basis: typeof r.basis === "string" ? r.basis.trim() : "",
      contest: parseContest((r as unknown as Record<string, unknown>).contest),
    }));
  return { intents, failure: null };
}

/**
 * Author the present antagonists' next moves. Returns a deterministic block for
 * the turn, or null when nothing applies (no model configured, no antagonists
 * present, runtime unavailable, or the call failed — a failure must never block
 * the turn, it just falls back to the render model's own judgment).
 */
export async function runAntagonistIntent(input: {
  runtime: ChatRuntime | null;
  modelId: string;
  briefs: AntagonistBrief[];
  sceneSummary: string;
  requestId?: string;
  /** The chat turn's abort signal (2026-09-04): a user Stop during the
   *  pre-stream phases ends this call at once; an aborted pass is not a
   *  failure (no block, no failure reason). */
  signal?: AbortSignal;
  /** When supplied, a declared contest is resolved in CODE and the outcome is
   *  rendered inside this same block. Without it, declared contests degrade to
   *  plain intents — the model still never decides an outcome, it just does not
   *  get one. */
  resolveContest?: IntentContestResolver;
  /** Session dial `openaiFastModeEnabled` (2026-09-09), resolved per model. */
  openaiFastMode?: boolean | null;
}): Promise<AntagonistIntentResult> {
  const { runtime, modelId, briefs, sceneSummary, requestId, signal } = input;
  if (!runtime || !modelId.trim() || briefs.length === 0) return { block: null, usage: null, resolved: [], failure: null };
  if (signal?.aborted) return { block: null, usage: null, resolved: [], failure: null };

  const userMessage = [
    // 16k cap, raised from 4k with the caller's ten-turn window (2026-08-02):
    // a 4k cap silently re-truncated the wider scene back to ~three turns,
    // which is exactly the blindness the widening exists to fix. TAIL-sliced
    // (2026-09-02): the caller's window is oldest-first with the deepest slice
    // of the authoritative present at the END, so if this cap ever cuts (a
    // wider caller budget), it must drop the oldest turn, never the newest.
    `<scene>${sceneSummary.slice(-16000)}</scene>`,
    "",
    briefs.map(briefToPrompt).join("\n"),
  ].join("\n");

  let responseText = "";
  let usage: AntagonistIntentResult["usage"] = null;
  try {
    await runtime.streamChat({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage, attachments: [] }],
      temperature: 0,
      // Off by measurement, not by cost — see the header note on CoT.
      thinkingMode: "off",
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off",
      speed: openaiFastModeFor(modelId, input.openaiFastMode),
      requestId: requestId ?? `antagonist-intent-${Date.now()}`,
      signal,
    }, {
      onStart: () => {},
      onDelta: (delta) => { responseText += delta; },
      onThinkingDelta: () => {},
      onComplete: (result) => {
        usage = { modelId, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
      },
    });
  } catch (err) {
    // Stopped by the user mid-pass: not a failure, nothing to record.
    if (signal?.aborted) return { block: null, usage: null, resolved: [], failure: null };
    // A failed intent pass degrades to the previous behaviour. Never fatal —
    // but never silent either: the reason goes back for the system_event.
    return { block: null, usage: null, resolved: [], failure: err instanceof Error ? err.message : String(err) };
  }

  const { intents, failure } = parseIntents(responseText);
  if (failure) return { block: null, usage, resolved: [], failure };
  if (intents.length === 0) return { block: null, usage, resolved: [], failure: null };

  const allowedNames = new Map(input.briefs.map(brief => [brief.name.trim().toLocaleLowerCase(), brief.name]));
  const seenNames = new Set<string>();
  for (const intent of intents) {
    const key = intent.name.trim().toLocaleLowerCase();
    const canonical = allowedNames.get(key);
    if (!canonical || seenNames.has(key)) return { block: null, usage, resolved: [], failure: `intent contains an unknown or duplicate actor: ${intent.name}` };
    seenNames.add(key);
    intent.name = canonical;
  }
  const resolved: AntagonistIntentResult["resolved"] = [];
  const rendered = intents.map((intent) => {
    const parts = [`- ${intent.name}: ${intent.action}`];
    if (intent.means) parts.push(`  means: ${intent.means}`);
    if (intent.basis) parts.push(`  basis: ${intent.basis}`);
    // A declared contest is resolved HERE rather than in a separate block, so the
    // turn cannot be handed "carry this out" and "this failed" as two competing
    // instructions. One line, one truth.
    if (intent.contest && input.resolveContest) {
      const outcome = input.resolveContest({
        actor: intent.name,
        action: intent.action,
        opposes: intent.contest.opposes,
        difficulty: intent.contest.difficulty,
      });
      if (outcome) {
        // Roll and target are printed in <user>'s frame (see the resolver's
        // FRAME CONTRACT) with the reading spelled out inline, and the basis
        // trail follows on its own line — that trail is the only place the
        // owner-override stamp and the standing/stance weighting reach the
        // transcript for an antagonist contest.
        parts.push(`  outcome: ${outcome.success ? "SUCCEEDS" : "FAILS"} against ${intent.contest.opposes} (rolled ${outcome.roll}; ${intent.contest.opposes} holds on ${outcome.target} or under, the move lands above it); resolved by the world's mechanics, render this result exactly`);
        if (outcome.basis.length > 0) parts.push(`  weighting: ${outcome.basis.join(", ")}`);
        resolved.push({ actor: intent.name, action: intent.action, success: outcome.success, roll: outcome.roll, target: outcome.target, basis: outcome.basis });
      }
    }
    return parts.join("\n");
  }).join("\n");

  // Framed as settled fact, not suggestion. The render model's job is to make it
  // happen on the page — it does not get to reconsider whether the antagonist
  // goes through with it, which is precisely the decision it reliably softens.
  // The INTENT and OUTCOME are binding; the physical STAGING is not — the pass
  // runs on a sliced window and can lag the scene by a beat, and forcing stale
  // staging ("stays on his feet" after the transcript sat him down) makes the
  // render model reconcile contradictions instead of rendering the move.
  return {
    block: [
      "<antagonist_intent>",
      "These antagonists have decided their next move. The decision — and any resolved outcome — is already made; carry it out. Stage it from the scene's CURRENT position: if the scene has moved past the posture or placement a line assumes, keep the intent, tactic, and outcome exactly, and adapt only the physical staging to what has just happened.",
      resolved.length > 0
        ? "Where an outcome is given it was resolved outside this turn: render that result exactly, including a failure. Dice are read from <user>'s side: the number after the roll is <user>'s resistance, so an antagonist's move lands on a roll above it, and the weighting line is the full basis for the result."
        : null,
      rendered,
      "</antagonist_intent>",
    ].filter(Boolean).join("\n"),
    usage,
    resolved,
    failure: null,
  };
}
