/**
 * Scene Tempo — the server-rolled pacing gear (2026-08-30,
 * mined from Realistic Frankenstein 2.0's Neutral Gear module).
 *
 * The problem it solves: the composer treats every turn as "something must
 * advance", so every reply takes the same escalating shape and quiet human
 * texture never happens. The preset's authors are explicit that a prose-only
 * fix fails — "nothing happens" must arrive as a rolled instruction, not a
 * choice the assistant persona makes against its own grain. So the ENGINE
 * rolls the gear:
 *
 *   NEUTRAL 40% — filler is the assignment; no plot may advance
 *   STEADY  40% — at most one beat moves
 *   DRIVE   20% — push; the most-dramatic option is correct here only
 *
 * Determinism is the same discipline as contested outcomes: the base gear is
 * hashed from the triggering user message id, so a regenerate re-renders the
 * same gear instead of re-rolling, and the whole gear HISTORY is recomputable
 * from the session's user-message ids — no stored state, nothing to migrate,
 * nothing to drift. Hysteresis (two NEUTRALs step the next turn up; three
 * STEADYs step the next turn up) folds over that recomputed history.
 *
 * The gear never outranks settled work: the caller floors NEUTRAL to STEADY
 * on turns carrying a contested resolution, an antagonist decision, or due
 * beats, and the block's closing line subordinates the gear to every settled
 * block above it. NEUTRAL suppresses plot, never <user>'s agency.
 */
import { createHash } from "node:crypto";

export type TempoGear = "NEUTRAL" | "STEADY" | "DRIVE";

const GEAR_ORDER: readonly TempoGear[] = ["NEUTRAL", "STEADY", "DRIVE"];

/** Uniform-enough d100 from a message id — same technique and rationale as the
 *  contested-outcome seededRoll (modulo bias far below one part in a million,
 *  stable forever). */
export function baseGearForMessageId(messageId: string): TempoGear {
  const digest = createHash("sha256").update(`scene-tempo:${messageId}`).digest();
  const v = digest.readUIntBE(0, 6) % 100;
  if (v < 40) return "NEUTRAL";
  if (v < 80) return "STEADY";
  return "DRIVE";
}

function stepUp(gear: TempoGear): TempoGear {
  const i = GEAR_ORDER.indexOf(gear);
  return GEAR_ORDER[Math.min(i + 1, GEAR_ORDER.length - 1)];
}

/** Pure hysteresis fold, exported for tests. Applied over the fold's OWN
 *  stepped outputs (hysteresis-stepped finals), not base rolls — so a step-up
 *  resets the streak and the whole history is reproducible from ids alone.
 *  Caller floors are NOT part of this history: a turn that rolled NEUTRAL but
 *  was floored to STEADY in chatService (contested result, antagonist decision,
 *  due beats) still counts as NEUTRAL here. Stateless by design; the gear the
 *  player saw on a floored turn is therefore not always the gear this fold
 *  sees (comment corrected 2026-09-02). */
export function foldGears(baseGears: TempoGear[]): TempoGear[] {
  const finals: TempoGear[] = [];
  for (const base of baseGears) {
    let gear = base;
    const n = finals.length;
    if (n >= 2 && finals[n - 1] === "NEUTRAL" && finals[n - 2] === "NEUTRAL") {
      gear = stepUp(gear);
    } else if (n >= 3 && finals[n - 1] === "STEADY" && finals[n - 2] === "STEADY" && finals[n - 3] === "STEADY") {
      gear = stepUp(gear);
    }
    finals.push(gear);
  }
  return finals;
}

export interface SceneTempoResult {
  /** The gear after hysteresis, before any caller floor. */
  gear: TempoGear;
  /** The raw hash roll for this turn (pre-hysteresis), for telemetry. */
  rolled: TempoGear;
}

/** Compute this turn's gear from the ordered user-message ids of the session,
 *  the current turn's id LAST. */
export function computeSceneTempo(orderedUserMessageIds: string[]): SceneTempoResult {
  const bases = orderedUserMessageIds.map(baseGearForMessageId);
  const finals = foldGears(bases);
  return { gear: finals[finals.length - 1], rolled: bases[bases.length - 1] };
}

const NEUTRAL_TEXT = `This reply advances no plot: no revelation, arrival, confession, crossed threshold, or completed pursuit. A scene that ends where it started, with nobody having decided anything, is a correct and complete reply, the last line included: it lands on something plain, with no ominous closer, no meaningful glance, no hook.
Exactly one small thing changes (posture, who holds the floor, the topic, an object's state, the light, an unfinished task). Change without escalation.
People talk about nothing in their own voices: they answer sideways, lose the thread, land a joke badly, stay absorbed in their own business, decline the emotional bait. Characters may talk to each other past <user>. Let dialogue carry most of the reply, and run shorter than a working turn.`;

const STEADY_TEXT = `At most one beat moves. Follow what the scene's current state makes natural, never what would be most dramatic. Normal proportions.`;

const DRIVE_TEXT = `Push. Prefer the highest-impact development consistent with established facts: escalation, arrival, reveal, completion, collision. This is the only gear where the most-dramatic option is the right pick.`;

const GEAR_TEXT: Record<TempoGear, string> = {
  NEUTRAL: NEUTRAL_TEXT,
  STEADY: STEADY_TEXT,
  DRIVE: DRIVE_TEXT,
};

export function buildSceneTempoBlock(gear: TempoGear): string {
  return `<scene_tempo gear="${gear}">
The engine rolled this turn's gear: ${gear}. The roll stands; a more interesting alternative does not override it.
${GEAR_TEXT[gear]}
Regardless of gear: <user>'s direct actions and questions are answered in full, and every settled block above (contested outcomes, established consequences, due events, antagonist decisions, a scene spotlight) is carried out completely. The gear shapes everything else.
</scene_tempo>`;
}
