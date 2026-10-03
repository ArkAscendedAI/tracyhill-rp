// One character, several spellings: the lorebook titles a core "Sheriff Doran Vale" while every scene
// names him "Doran Vale", and the drive worker used to open a second sheet for the variant (2026-09-27:
// the duplicate took the world tick's offscreen updates while the live sheet went stale, and the
// settled-facts canon check never matched his "Sheriff …" records). A leading title is dropped only when at
// least two name tokens remain, so "Judge Kesh" stays itself and can never collide with a bare "Kesh".
const HONORIFICS = new Set([
  "sheriff", "deputy", "detective", "officer", "sergeant", "sgt", "lieutenant", "lt", "captain", "capt", "chief", "agent",
  "reverend", "rev", "brother", "sister", "father", "pastor", "deacon", "bishop",
  "judge", "doctor", "dr", "nurse", "professor", "prof", "mr", "mrs", "ms", "miss", "mister",
  "sir", "lady", "lord", "madam", "king", "queen", "prince", "princess", "magister",
]);

export function characterNameKey(name: string): string {
  const tokens = name.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  while (tokens.length > 2 && HONORIFICS.has(tokens[0]!.toLocaleLowerCase().replace(/\.$/, ""))) tokens.shift();
  return tokens.join(" ").toLocaleLowerCase();
}

/** The name without its leading titles, as long as one word remains ("Mr Vale" → "Vale", "Sheriff" → "Sheriff").
 *  Unlike `characterNameKey`, it drops the title of a two-word name: for recognising a known person under a title
 *  (the player character's names), never for keying a sheet. */
export function withoutLeadingTitles(name: string): string {
  const tokens = name.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0]!.toLocaleLowerCase().replace(/\.$/, ""))) tokens.shift();
  return tokens.join(" ");
}

export function sameCharacter(a: string, b: string): boolean {
  return characterNameKey(a) === characterNameKey(b);
}

/** Map names seen in scenes onto existing drive-sheet names: an exact sheet wins; otherwise the ONE sheet
 *  whose key matches; otherwise the scene name stands (a new sheet). Also reports existing sheets that
 *  already share a key (duplicates to merge). */
export function resolveSheetNames(names: string[], existing: string[]): { names: string[]; duplicates: string[][] } {
  const exact = new Set(existing);
  const byKey = new Map<string, string[]>();
  for (const n of existing) byKey.set(characterNameKey(n), [...(byKey.get(characterNameKey(n)) ?? []), n]);
  const out: string[] = [];
  for (const n of names) {
    const resolved = exact.has(n) ? n : (byKey.get(characterNameKey(n))?.length === 1 ? byKey.get(characterNameKey(n))![0]! : n);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return { names: out, duplicates: [...byKey.values()].filter((group) => group.length > 1) };
}
