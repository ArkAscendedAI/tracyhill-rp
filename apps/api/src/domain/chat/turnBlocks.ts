import type { ContextSettings } from "@tracyhill-rp/contracts";

import { retrievalRuns } from "../context/retrievalMode";
import { contentHonestyApplies } from "../world/contentHonesty";
import { clampStance } from "../world/gritContract";

/**
 * The per-turn blocks prepended to the newest user message, and the settings
 * gates that decide whether each may fire. One module
 * for both readers: the live turn (chatService.runAssistantTurn builds `parts`
 * through `orderTurnBlocks` and asks `turnBlockAllowed` before composing a
 * block) and the Engine dialog's Injected-text viewer (promptFragments.ts lists
 * its per-turn fragments in TURN_BLOCK_ORDER and takes each "active" flag from
 * the same gate). Before this the viewer hand-copied the order and the gates,
 * and six of them had drifted.
 *
 * A gate says whether the session's dials let the block fire. `null` means no
 * dial controls it: the block fires on campaign state alone (a comms reference,
 * a due beat, a recorded consequence, a spotlight marker, offscreen facts).
 * Campaign state and the plan kind are checked where the block is built; the
 * plan-kind rules are exported below so both readers name them the same way.
 */
export const TURN_BLOCK_ORDER = [
  "retrieved_context",
  "character_agendas",
  "absent_contacts",
  "offscreen_memory",
  "clock_pressure",
  "contested_outcome",
  "consequences",
  "character_attire",
  "due_beats",
  "antagonist_intent",
  "scene_tempo",
  "spotlight",
  "style_gate",
  "content_honesty_escalation",
  "player_authority",
] as const;
export type TurnBlockId = (typeof TURN_BLOCK_ORDER)[number];

export type TurnBlockModel = { id: string; provider: string } | null | undefined;
type Gate = (settings: ContextSettings, model: TurnBlockModel) => boolean;

export const TURN_BLOCK_GATES: Record<TurnBlockId, Gate | null> = {
  retrieved_context: (s) => retrievalRuns(s),
  character_agendas: (s) => Boolean(s.npcAgendaEnabled),
  // A comms reference in the last exchange (hasCommsReference); no dial.
  absent_contacts: null,
  // Present, present-unaware or comms-pulled characters with offscreen facts; no dial.
  offscreen_memory: null,
  // The same threshold the repository applies (buildClockBlock returns null below 2).
  clock_pressure: (s) => clampStance(s.worldStance) >= 2,
  contested_outcome: (s) => Boolean(s.contestedOutcomesEnabled) && clampStance(s.worldStance) >= 2,
  // Renders whenever the campaign's ledger holds rows, at any stance or dial.
  consequences: null,
  // Attire tracking alone: the block reads the stored records whether or not
  // the scene validator is on to write new ones.
  character_attire: (s) => Boolean(s.attireTrackingEnabled),
  // Every due beat fires, whoever armed it (the Dramatist, a filled threat
  // clock, a hand-added beat); the Dramatist switch only stops new arming.
  due_beats: null,
  antagonist_intent: (s) => Boolean(s.antagonistModel?.trim()),
  scene_tempo: (s) => Boolean(s.sceneTempoEnabled),
  // A spotlight marker on the user turn; no dial.
  spotlight: null,
  style_gate: (s) => Boolean(s.characterIntegrityEnabled),
  content_honesty_escalation: (s, model) => Boolean(s.contentHonestyEnabled) && Boolean(model) && contentHonestyApplies(model!),
  player_authority: (s) => (s.playerCharacterKeys?.length ?? 0) > 0,
};

/** Whether the session's dials let the block fire (true for the blocks no dial controls). */
export function turnBlockAllowed(id: TurnBlockId, settings: ContextSettings | null | undefined, model?: TurnBlockModel): boolean {
  const gate = TURN_BLOCK_GATES[id];
  if (!gate) return true;
  return settings ? gate(settings, model) : false;
}

/** The contest classifier runs on a fresh send and a regenerate, never on a continue. */
export function contestRunsForPlan(kind: "append" | "variant" | "continue"): boolean {
  return kind !== "continue";
}

/** The antagonist-intent pass runs once per user turn: a regenerate or continue re-renders without it. */
export function antagonistRunsForPlan(kind: "append" | "variant" | "continue"): boolean {
  return kind === "append";
}

/** The composed blocks in wire order; absent or empty blocks are skipped. */
export function orderTurnBlocks(blocks: Partial<Record<TurnBlockId, string | null | undefined>>): string[] {
  const parts: string[] = [];
  for (const id of TURN_BLOCK_ORDER) {
    const block = blocks[id];
    if (block) parts.push(block);
  }
  return parts;
}
