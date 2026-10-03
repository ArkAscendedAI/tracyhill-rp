// The 🎭 spotlight popover's effective character.
//
// The stored choice (`spotlightChar`, written only by the select's onChange)
// used to be sent verbatim: `spotlightChar || presentNames[0] || …`. When the
// chosen NPC later left the scene and had no drive sheet, the option list no
// longer contained the name, the controlled <select> displayed its first
// option (the first present character) — and "Hand the scene" still sent the
// stale name, so the server generated a beat for an absent character. The
// choice is now derived from the CURRENT options, so the select shows exactly
// what will be sent.
export function resolveSpotlightChoice(stored: string, presentNames: readonly string[], options: readonly string[]): string {
  // No options at all → the popover shows a free-text input bound to `stored`.
  if (!options.length) return stored;
  if (options.includes(stored)) return stored;
  return presentNames[0] ?? options[0] ?? "";
}
