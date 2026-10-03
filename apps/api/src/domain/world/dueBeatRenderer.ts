import type { BeatRow } from "./scheduledBeatRepository";

// Three buckets, keyed on CLASS and SEVERITY, never on timing alone. Before
// this, everything that was not a fire_during_scene
// complication fell into the "texture … never wounds" paragraph, including the
// severity-2 `when_due` complications the adversarial-world clock producer arms
// for every filled scheme clock — the Dramatist's main producer was delivering
// its real consequences to the composer under an instruction that they may only
// "inconvenience". The design sharpens fire_during_scene complications with
// the mid-scene clause and keeps TEXTURE light; it never downgrades a when_due
// complication to texture semantics.
//   urgent       = complication + fire_during_scene → HAPPENS mid-scene, now.
//   developments = every other complication, and anything severity ≥ 2 → HAPPENS
//                  in this reply (due story-time has passed), may wound within
//                  the PC-will boundary, no mid-scene interruption mandate.
//   light        = texture, and telegraphs below severity 2 → weave in, never wounds.
function isUrgent(beat: BeatRow): boolean {
  return beat.class === "complication" && beat.timing === "fire_during_scene";
}
function isDevelopment(beat: BeatRow): boolean {
  return !isUrgent(beat) && (beat.class === "complication" || beat.severity >= 2);
}
function line(beat: BeatRow): string {
  return `- [${beat.class.toUpperCase()} · severity ${beat.severity}] ${beat.description}${beat.afterInworld ? ` (due ~${beat.afterInworld})` : ""}`;
}

export function renderDueBeatsDirective(beats: BeatRow[]): string | null {
  if (beats.length === 0) return null;
  const urgent = beats.filter(isUrgent);
  const developments = beats.filter(isDevelopment);
  const light = beats.filter((beat) => !isUrgent(beat) && !isDevelopment(beat));
  const parts = [
    "These are authoritative world developments, to be rendered as fact rather than read as suggestions or meta-text.",
  ];
  if (urgent.length > 0) {
    parts.push(
      "This HAPPENS in this reply, mid-scene, as an event in motion. It lands as fact, with no offer, no question and no delay. Land it, then return the floor at the player's decision point.",
      ...urgent.map(line),
    );
  }
  if (developments.length > 0) {
    parts.push(
      "These are due now and HAPPEN in this reply: real developments with real cost, landed as established fact at the first point this reply allows, never deferred to a later turn and never softened into rumor. They may wound or cost within the player-will boundary; never author the player's response or decide the player character's actions:",
      ...developments.map(line),
    );
  }
  if (light.length > 0) {
    parts.push(
      "Weave these in naturally when the scene gives an opening. Texture may inconvenience but never wounds or authors the player's response; a telegraph foreshadows without resolving:",
      ...light.map(line),
    );
  }
  return parts.join("\n");
}
