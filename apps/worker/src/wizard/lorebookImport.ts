import { parseFirstJson } from "@tracyhill-rp/provider-runtime";
import { normalizeWizardCorpusName, type WizardLintFinding } from "@tracyhill-rp/contracts";

import type { ImportSourceEntry, LorebookCorpusEntry, StoredWizardImportSource } from "../../../api/src/domain/wizard/wizardRunRepository";
import { fillCharMacro, remainingMacros } from "../../../api/src/domain/wizard/sillyTavernImport";

// A SillyTavern lorebook converted into a campaign corpus. The model never rewrites an
// imported entry's text. It sorts the entries (pass 1), prepares each character the way the wizard prepares its own
// cast (pass 2: attire, drives, an antagonist's sealed scheme, and the native sections the text lacks), and writes the
// rule entries a native campaign starts with (pass 3). Everything here is pure; the worker runs the model calls.

export const IMPORT_TAGS = ["characters", "locations", "factions", "events", "lore", "rules"] as const;
export type ImportTag = (typeof IMPORT_TAGS)[number];

/** The rolling diff keeps a character entry under this many characters (rollingDiffWorker CHARACTER_ENTRY_MAX_CHARS). */
const CHARACTER_ENTRY_ADVISORY_CHARS = 12_000;
/** Native campaigns keep three to five constant entries; past this many the review says what they cost. */
const CONSTANT_ADVISORY_COUNT = 8;

// ── Prompts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function importSystemPromptNote(playerCharacterName: string): string {
  return [
    "This campaign comes from a lorebook the owner imported from SillyTavern, not from a wizard conversation. Wherever the instructions above refer to the wizard conversation, read the imported lorebook and the owner's notes instead. Take the content rating, tone, stakes and style from them. When they do not settle a point, write what the material most plainly implies and keep it specific to this world.",
    "",
    `The player character is ${playerCharacterName}. Write the first line as:`,
    `PLAYER_CHARACTER: ${playerCharacterName}`,
    "",
    "The lorebook stays the campaign's lorebook. Do not restate its entries in the system prompt.",
  ].join("\n");
}

export function importSortPrompt(playerCharacterName: string): string {
  const pc = playerCharacterName;
  return `You are converting a SillyTavern lorebook into the lorebook of a new TracyHill RP campaign. In this step you sort entries. You do not rewrite them.

The player character is ${pc}.

Return a JSON array with one object for every entry in <entries_to_sort>, in this shape:
{"index": 12, "tag": "characters", "character": "Elara Vane", "aspect": null, "primary": true, "playerCharacter": false, "antagonist": false}

"index": the entry's index, exactly as given.
"tag": the one tag that fits what the entry mainly describes. "characters" for a named person or creature. "locations" for a place. "factions" for an organization, family, people or group. "events" for something that happened or is happening. "lore" for history, magic, technology, religion, customs, money and the other workings of the world. "rules" for instructions about how the story is told: tone, style, content limits, game mechanics.
"character": when the entry is about one named character, that character's full name as the lorebook uses it most. Otherwise null.
"aspect": when the entry covers one part of a character, such as their past, their family or their powers, a short label for that part: "History", "Family", "Powers". null for the entry that is the character's main profile.
"primary": true only for the entry that describes who the character is: their appearance, personality or background. A character has one primary entry at most, and their other entries are false. An entry about one ability, item, spell, rule or event connected to a character is never primary, even when it is the only entry about them. For such an entry, choose the tag that fits its subject: "events" for their past, "lore" for their powers or customs, "factions" for their family or house, "rules" for a game mechanic.
"playerCharacter": true when the entry is about ${pc}, the player character.
"antagonist": true when the lorebook sets the character against ${pc} or against the people and places ${pc} cares about: a villain, an enemy, a rival working to defeat them.

<entry_index> lists every entry in the lorebook, so you can tell when a character has entries outside this batch. Return only the JSON array.`;
}

export function importCharacterPrompt(playerCharacterName: string, addSections: boolean): string {
  const pc = playerCharacterName;
  const sections = addSections
    ? `"sections": the native sections this character's text does not already cover. Include a section only when the text lacks it, and write it from what the lorebook says about them.
"physical": three to five sentences on age, height, build, distinctive features, usual clothing and how they move. For ${pc} this is the only section you may write.
"voiceRegisters": two or three named registers, each on its own line in the form "(1) Register name: how they talk in that mode, their vocabulary and rhythm, and what they bring up."
"onPlayer": how this character sees ${pc}, whether they trust them, and how they act toward them.
"voiceAnchors": two or three lines this character would say, each on its own line in the form - *"the line"* (Register name; when they say it). Write them in the character's own voice as the lorebook gives it, as things a person says in the middle of a scene: plain speech a listener could repeat. No line ends on a maxim or on a threat turned into a quip, no line sets a denied idea against a stated one ("not this, but that"), and no line is a stock villain's or hero's phrase.
Return "sections": {} when the text already covers all four.`
    : `"sections": always {}. The owner chose to keep each character's text exactly as imported.`;
  return `You are converting a SillyTavern lorebook into the lorebook of a new TracyHill RP campaign. In this step you prepare each character in <characters> so the campaign can run them from the first turn. Their lorebook text is kept as written. You add what a native character entry has and theirs lacks.

The player character is ${pc}.

Return a JSON array with one object for every character in <characters>, in this shape:
{"name": "exact name as given", "startingAttire": "...", "startingDrives": {"wants": [], "goals": [], "redLines": [], "leverage": [], "concealment": [{"secret": "...", "behavior": "..."}], "offpageProject": "...", "dispositions": {"Other Name": "..."}}, "startingSchemes": [], "sections": {}}

Ground everything in the character's own entries and the rest of the lorebook. Where the lorebook is silent, write what the character as written implies. Never contradict an entry.

"startingAttire": one line of prose naming what they wear when the campaign opens: the visible layers, their footwear, and anything they carry or wear.

"startingDrives": leave it out for ${pc}. For everyone else:
"wants": up to three things they are pursuing this week. Specific and actionable, never a disposition such as "wants to help".
"goals": up to two aims that span the story.
"redLines": one to three entries, each naming what this character does to someone who obstructs them and the one line they hold even then. State the act, not the value.
"leverage": one to three concrete holds over a named other: a debt, a secret, a dependency, a threat they can make good on.
"concealment": one or two things they hide, each with the behavior they use to hide it.
"offpageProject": what they work at while off the page. Leave it out when nothing fits.
"dispositions": how they feel about up to six of the characters in <character_names>, one line each, keyed by those exact names.
This applies to allies and neutral characters as much as to antagonists. A character with nothing they will do to an obstacle and nothing to hide is a prop.

"startingSchemes": only for a character marked antagonist, and then exactly one scheme in this shape:
{"steps": [{"text": "a concrete off-page move", "armsBeat": {"description": "an observable consequence or warning sign", "class": "telegraph", "severity": 2, "timing": "when_due"}}], "currentStep": 0, "targetCitation": "an exact name from <entry_names>", "cadence": 6}
"class" is "telegraph" or "complication", "severity" is 1 to 3, "timing" is "when_due" or "fire_during_scene", and "armsBeat" may be null. Use three to six escalating steps grounded in the lorebook. Each step names the objective, the method, and who pays for it. "cadence" is 1 to 20. Never cite a name that is not in <entry_names>. Return "startingSchemes": [] for everyone else.

${sections}

Return only the JSON array.`;
}

export function importRulesPrompt(playerCharacterName: string): string {
  const pc = playerCharacterName;
  return `You are converting a SillyTavern lorebook into the lorebook of a new TracyHill RP campaign. A campaign built here starts with four rule entries, and the imported lorebook may not have them. Write the ones it lacks.

The player character is ${pc}.

1. "Player Character Presentation" (isConstant true): ${pc}'s physical description and how the world reads them at first sight. Durable facts only: who knows what about them right now does not belong here.
2. "Tone Enforcement" (isConstant true): concrete examples of how this campaign's tone reads in practice, what to avoid, and how humor and gravity sit together here.
3. "Phrase Blacklist" (isConstant true): phrases the prose must never use. Always include "little did they know", "unbeknownst to", "a chill ran down their spine", "time seemed to slow", "the world would never be the same", adverb-heavy dialogue tags and explaining subtext. Add bans that fit this setting.
4. "Social Dynamics" (isConstant false): how people here size up ${pc}, the social rules ${pc} keeps or breaks, and what sets off social consequences.

Each one must still be true 500 turns from now. Keep each constant entry under 300 tokens. None may describe how the player and the narrator take turns, tell the world to wait for the player, or say how a reply must end.

When an entry in the lorebook already does one of these jobs, do not write that rule. Return the entry's title as "covers" instead.

Return a JSON array with one object per rule, in one of these shapes:
{"name": "Tone Enforcement", "content": "...", "keys": ["tone", "style", "prose", "writing", "narration"], "isConstant": true}
{"name": "Phrase Blacklist", "covers": "Writing Style Guide"}

Keys: Player Character Presentation uses ${pc}'s name and nicknames. Tone Enforcement uses ["tone", "style", "prose", "writing", "narration"]. Phrase Blacklist uses ["banned", "avoid", "never", "blacklist", "writing rules"]. Social Dynamics uses ["reputation", "respect", "social", "authority", "judgment"].

Return only the JSON array.`;
}

// ── Formatting and batching ──────────────────────────────────────────────────────────────────────────────────────────

function entryHeading(entry: ImportSourceEntry): string {
  const flags = [entry.isConstant ? "always on" : null, entry.activation.enabled ? null : "off", entry.keys.length > 0 ? `keys: ${entry.keys.slice(0, 12).join(", ")}` : null].filter(Boolean);
  return `[${entry.index}] ${entry.title}${flags.length > 0 ? ` (${flags.join("; ")})` : ""}`;
}

/**
 * The lorebook as prompt text within a character budget: always-on entries first (they usually carry the world and
 * its rules), then the rest in SillyTavern's order. Entries past the budget are named at the end, so the model knows
 * they exist.
 */
export function formatLorebookForPrompt(entries: ImportSourceEntry[], budgetChars: number, perEntryMaxChars = Infinity): string {
  const ordered = [...entries].sort((a, b) => Number(b.isConstant) - Number(a.isConstant) || a.insertionOrder - b.insertionOrder || a.index - b.index);
  const parts: string[] = [];
  let used = 0;
  const left: string[] = [];
  for (const entry of ordered) {
    const content = entry.content.length > perEntryMaxChars ? `${entry.content.slice(0, perEntryMaxChars)} [continues]` : entry.content;
    const block = `${entryHeading(entry)}\n${content}`;
    if (used + block.length + 2 > budgetChars) { left.push(entry.title); continue; }
    parts.push(block);
    used += block.length + 2;
  }
  if (left.length > 0) parts.push(`(${left.length} more entries are not shown here: ${left.slice(0, 200).join("; ")}${left.length > 200 ? "; …" : ""})`);
  return parts.join("\n\n");
}

/** Every entry in one line each: index, title and the start of its text, within a budget. */
export function formatEntryIndex(entries: ImportSourceEntry[], budgetChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const excerpt = entry.content.replace(/\s+/g, " ").slice(0, 90);
    const line = `[${entry.index}] ${entry.title}: ${excerpt}`;
    if (used + line.length + 1 > budgetChars) {
      lines.push(`(${entries.length - lines.length} more entries)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** Batches by count and by total text, keeping the lorebook's order. A single oversize item gets its own batch. */
export function batchBySize<T>(items: T[], sizeOf: (item: T) => number, maxChars: number, maxCount: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemSize = sizeOf(item);
    if (current.length > 0 && (current.length >= maxCount || size + itemSize > maxChars)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The lorebook budget for one prompt: a share of the model's context, in characters (about four per token). */
export function lorebookBudgetChars(contextTokens: number, share = 0.45): number {
  return Math.max(40_000, Math.min(600_000, Math.floor(contextTokens * share) * 4));
}

// ── Pass 1: sorting ──────────────────────────────────────────────────────────────────────────────────────────────────

export type ImportSort = {
  tag: ImportTag;
  character: string | null;
  aspect: string | null;
  primary: boolean;
  playerCharacter: boolean;
  antagonist: boolean;
};

const cleanName = (value: unknown, max = 120): string | null => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : null);

/** The model's sort of one batch, by entry index; entries it skipped or garbled are absent. */
export function parseSortResponse(text: string, batch: ImportSourceEntry[]): Map<number, ImportSort> {
  const wanted = new Set(batch.map((entry) => entry.index));
  const out = new Map<number, ImportSort>();
  const parsed = parseFirstJson<unknown[]>(text, "[");
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const index = typeof raw.index === "number" ? raw.index : Number.parseInt(String(raw.index ?? ""), 10);
    if (!wanted.has(index) || out.has(index)) continue;
    const tag = typeof raw.tag === "string" && (IMPORT_TAGS as readonly string[]).includes(raw.tag.trim().toLowerCase()) ? raw.tag.trim().toLowerCase() as ImportTag : "lore";
    out.set(index, {
      tag,
      character: cleanName(raw.character),
      aspect: cleanName(raw.aspect, 60),
      primary: raw.primary === true,
      playerCharacter: raw.playerCharacter === true,
      antagonist: raw.antagonist === true,
    });
  }
  return out;
}

// ── Naming and tags ──────────────────────────────────────────────────────────────────────────────────────────────────

export type PlannedEntry = {
  source: ImportSourceEntry;
  name: string;
  tag: ImportTag;
  // Set on a character's primary entry: the name the cast knows them by.
  character: string | null;
  // The character the entry is about, primary or satellite: who {{char}} means in it when the owner left it blank.
  subject: string | null;
  playerCharacter: boolean;
  antagonist: boolean;
};

export type ImportPlan = {
  entries: PlannedEntry[];
  // Entries the model did not sort (imported as lore).
  unsorted: number;
};

/** A title without any word of the character's name: "Al Cravel, Julius" for "Julius Juukulius" → "Al Cravel". */
export function stripCharacterWords(title: string, character: string): string {
  const words = character.split(/\s+/).filter((word) => word.length > 1).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return title.trim();
  return title
    .replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?:['’]s)?(?![\\p{L}\\p{N}])`, "giu"), " ")
    .replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, "")
    .replace(/\s*,\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A satellite's aspect from its title: the title without the character's name ("Elara's History" → "History"). */
export function stripCharacterName(title: string, character: string): string {
  const pattern = new RegExp(character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return title
    .replace(pattern, " ")
    .replace(/^\s*['’]s\b/i, "")
    .replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, "")
    .replace(/^[([]\s*(.*?)\s*[)\]]$/, "$1")
    .trim();
}

/**
 * Deterministic names and tags after sorting. One primary entry per character carries the "characters" tag and the
 * character's name (the player character's as the owner typed it). A character's other entries become satellites
 * named "<Character> — <aspect>", the shape the drive canon check and the presence resolver read as the same subject.
 * Every name ends up distinct, so approval never meets two entries with one name.
 */
export function planImportedCorpus(entries: ImportSourceEntry[], sorts: Map<number, ImportSort>, playerCharacterName: string): ImportPlan {
  let unsorted = 0;
  const pcKey = normalizeWizardCorpusName(playerCharacterName);
  const resolved = entries.map((entry) => {
    const sort = sorts.get(entry.index);
    if (!sort) unsorted += 1;
    const base: ImportSort = sort ?? { tag: "lore", character: null, aspect: null, primary: false, playerCharacter: false, antagonist: false };
    const character = base.playerCharacter ? playerCharacterName : base.character;
    const playerCharacter = base.playerCharacter || (character !== null && normalizeWizardCorpusName(character) === pcKey);
    return { entry, sort: { ...base, character: playerCharacter ? playerCharacterName : character, playerCharacter } };
  });

  // One primary per character: the model's choice, else the entry titled with the name, else the longest.
  const groups = new Map<string, typeof resolved>();
  for (const item of resolved) {
    if (!item.sort.character) continue;
    const key = normalizeWizardCorpusName(item.sort.character);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  // A profile only: an entry the model called the character's main profile, else one titled with their name. A
  // character whose entries are all about a power, an item or a rule gets no primary rather than having one of those
  // renamed into a profile (a real book's "Plot Armour" mechanics entry became the player character's profile so).
  // Among profiles, one that is on beats one that is off, and the longest wins a tie.
  const primaryOf = new Map<string, number>();
  for (const [key, items] of groups) {
    const longest = (list: typeof items) => [...list].sort((a, b) => b.entry.content.length - a.entry.content.length)[0];
    const on = (list: typeof items) => list.filter((item) => item.entry.activation.enabled);
    const flagged = items.filter((item) => item.sort.primary);
    const titled = items.filter((item) => normalizeWizardCorpusName(item.entry.title) === key);
    const choice = longest(on(flagged)) ?? longest(flagged) ?? longest(on(titled)) ?? longest(titled);
    if (choice) primaryOf.set(key, choice.entry.index);
  }

  const used = new Set<string>();
  const unique = (name: string) => {
    let candidate = name.trim().slice(0, 200) || "Untitled entry";
    let n = 2;
    while (used.has(normalizeWizardCorpusName(candidate))) candidate = `${name.trim().slice(0, 190)} (${n++})`;
    used.add(normalizeWizardCorpusName(candidate));
    return candidate;
  };
  // Primary names first, so a satellite or an unrelated entry never takes a character's name.
  const names = new Map<number, string>();
  for (const item of resolved) {
    const character = item.sort.character;
    if (character && primaryOf.get(normalizeWizardCorpusName(character)) === item.entry.index) names.set(item.entry.index, unique(character));
  }
  const planned: PlannedEntry[] = resolved.map((item) => {
    const character = item.sort.character;
    const key = character ? normalizeWizardCorpusName(character) : null;
    const isPrimary = key !== null && primaryOf.get(key) === item.entry.index;
    if (isPrimary) {
      return { source: item.entry, name: names.get(item.entry.index)!, tag: "characters", character, subject: character, playerCharacter: item.sort.playerCharacter, antagonist: item.sort.antagonist && !item.sort.playerCharacter };
    }
    // A character's other entries are satellites; an entry the model tagged "characters" without a named subject
    // describes no one the cast can track, so it becomes lore.
    const tag: ImportTag = item.sort.tag === "characters" ? "lore" : item.sort.tag;
    const aspect = character ? item.sort.aspect || stripCharacterName(item.entry.title, character) || "Notes" : null;
    // Two satellites with one aspect ("Powers") take their own title's words before a number: "Al Clarista, Julius"
    // is Julius's "Al Clarista".
    const ownWords = character ? stripCharacterWords(item.entry.title, character) : "";
    const preferred = character ? `${character} — ${aspect}` : item.entry.title;
    const name = character && used.has(normalizeWizardCorpusName(preferred)) && ownWords && !used.has(normalizeWizardCorpusName(`${character} — ${ownWords}`))
      ? unique(`${character} — ${ownWords}`)
      : unique(preferred);
    return { source: item.entry, name, tag, character: null, subject: character, playerCharacter: false, antagonist: false };
  });
  return { entries: planned, unsorted };
}

// ── Pass 2: characters ───────────────────────────────────────────────────────────────────────────────────────────────

export type CharacterPreparation = {
  startingAttire?: string;
  startingDrives?: unknown;
  startingSchemes?: unknown;
  sections: { physical?: string; voiceRegisters?: string; onPlayer?: string; voiceAnchors?: string };
};

/** The model's preparation of one batch of characters, by normalized name. */
export function parseCharacterResponse(text: string, names: string[]): Map<string, CharacterPreparation> {
  const wanted = new Set(names.map(normalizeWizardCorpusName));
  const out = new Map<string, CharacterPreparation>();
  const parsed = parseFirstJson<unknown[]>(text, "[");
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const key = typeof raw.name === "string" ? normalizeWizardCorpusName(raw.name) : "";
    if (!wanted.has(key) || out.has(key)) continue;
    const rawSections = raw.sections && typeof raw.sections === "object" ? raw.sections as Record<string, unknown> : {};
    const section = (field: string) => (typeof rawSections[field] === "string" && rawSections[field].trim() ? rawSections[field].trim().slice(0, 4000) : undefined);
    out.set(key, {
      startingAttire: typeof raw.startingAttire === "string" && raw.startingAttire.trim() ? raw.startingAttire.trim().slice(0, 1000) : undefined,
      startingDrives: raw.startingDrives,
      startingSchemes: raw.startingSchemes,
      sections: { physical: section("physical"), voiceRegisters: section("voiceRegisters"), onPlayer: section("onPlayer"), voiceAnchors: section("voiceAnchors") },
    });
  }
  return out;
}

/** The sections appended under an imported character's own text, in the native order, and their labels. */
export function appendCharacterSections(content: string, sections: CharacterPreparation["sections"], playerCharacterName: string, isPlayerCharacter: boolean): { content: string; added: string[] } {
  const blocks: string[] = [];
  const added: string[] = [];
  if (sections.physical) { blocks.push(`**Physical:** ${sections.physical}`); added.push("Physical"); }
  if (!isPlayerCharacter) {
    if (sections.voiceRegisters) { blocks.push(`**Voice Registers:**\n${sections.voiceRegisters}`); added.push("Voice Registers"); }
    if (sections.onPlayer) { blocks.push(`**On ${playerCharacterName}:** ${sections.onPlayer}`); added.push(`On ${playerCharacterName}`); }
    if (sections.voiceAnchors) { blocks.push(`**Voice Anchors:**\n${sections.voiceAnchors}`); added.push("Voice Anchors"); }
  }
  return { content: blocks.length > 0 ? `${content.trimEnd()}\n\n${blocks.join("\n\n")}` : content, added };
}

// ── Pass 3: rules ────────────────────────────────────────────────────────────────────────────────────────────────────

export type GeneratedRule = { name: string; content: string; keys: string[]; isConstant: boolean };
export type CoveredRule = { name: string; covers: string };

export function parseRulesResponse(text: string): { rules: GeneratedRule[]; covered: CoveredRule[] } {
  const parsed = parseFirstJson<unknown[]>(text, "[");
  const rules: GeneratedRule[] = [];
  const covered: CoveredRule[] = [];
  if (!Array.isArray(parsed)) return { rules, covered };
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const name = cleanName(raw.name, 200);
    if (!name) continue;
    if (typeof raw.covers === "string" && raw.covers.trim()) { covered.push({ name, covers: raw.covers.trim().slice(0, 200) }); continue; }
    if (typeof raw.content !== "string" || !raw.content.trim()) continue;
    const keys = Array.isArray(raw.keys) ? raw.keys.filter((key): key is string => typeof key === "string" && key.trim().length > 0).map((key) => key.trim()) : [];
    rules.push({ name, content: raw.content.trim(), keys: keys.length > 0 ? keys : [name], isConstant: raw.isConstant === true });
  }
  return { rules, covered };
}

// ── Advisories ───────────────────────────────────────────────────────────────────────────────────────────────────────

const advisory = (code: string, location: string, message: string): WizardLintFinding => ({ code, scope: "corpus", location, message, excerpt: "", line: null });

/** What the review should say about the converted corpus that no lint covers. */
export function importAdvisories(source: StoredWizardImportSource, corpus: LorebookCorpusEntry[], unsorted: number): WizardLintFinding[] {
  const findings: WizardLintFinding[] = source.notices.slice(0, 50).map((notice) => advisory("import_notice", "Import", notice));
  if (source.notices.length > 50) findings.push(advisory("import_notice", "Import", `${source.notices.length - 50} more import notes like these.`));
  if (unsorted > 0) findings.push(advisory("import_unsorted", "Import", `The model did not sort ${unsorted} ${unsorted === 1 ? "entry" : "entries"}, so ${unsorted === 1 ? "it was" : "they were"} imported as lore. Retag them in the Lorebook panel after approval if needed.`));
  // One line per macro, however many entries carry it: a book written for a card can use {{char}} in every entry.
  const macroUses = new Map<string, string[]>();
  for (const entry of corpus) {
    if (entry.origin?.kind !== "imported") continue;
    for (const macro of remainingMacros(entry.content)) macroUses.set(macro, [...(macroUses.get(macro) ?? []), entry.name]);
  }
  for (const [macro, names] of macroUses) {
    const listed = `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
    const isChar = /char\b|<BOT>|<CHAR>/i.test(macro);
    findings.push(advisory("import_macro_kept", "Import", isChar
      ? `Kept ${macro} as written in ${names.length} ${names.length === 1 ? "entry" : "entries"} that ${names.length === 1 ? "is" : "are"} about no one character (${listed}). Edit ${names.length === 1 ? "it" : "them"} in the Lorebook panel after approval, or re-run the import with a name for {{char}}.`
      : `Kept ${macro} as written in ${names.length} ${names.length === 1 ? "entry" : "entries"} (${listed}): this app does not fill in SillyTavern macros.`));
  }
  for (const entry of corpus) {
    if (entry.origin?.kind !== "imported") continue;
    if (entry.tag === "characters" && entry.content.length > CHARACTER_ENTRY_ADVISORY_CHARS) {
      findings.push(advisory("import_long_character_entry", entry.name, `This character entry is ${entry.content.length.toLocaleString("en-US")} characters. The campaign's upkeep keeps a character entry under ${CHARACTER_ENTRY_ADVISORY_CHARS.toLocaleString("en-US")} and moves older history into "${entry.name} — …" entries; consider splitting it after approval.`));
    }
  }
  const constants = corpus.filter((entry) => entry.isConstant && entry.activation?.enabled !== false);
  if (constants.length > CONSTANT_ADVISORY_COUNT) {
    const tokens = Math.round(constants.reduce((sum, entry) => sum + entry.content.length, 0) / 4);
    findings.push(advisory("import_many_constants", "Import", `${constants.length} entries are always on, about ${tokens.toLocaleString("en-US")} tokens on every turn. Campaigns built here keep three to five; turn the rest into keyed entries in the Lorebook panel if turns run short of room.`));
  }
  return findings;
}

/**
 * The corpus entry for an imported source entry, before preparation: its own text, keys and trigger settings. When
 * the owner left {{char}} blank, an entry about a character gets that character's name for it.
 */
export function importedCorpusEntry(planned: PlannedEntry, charName = ""): LorebookCorpusEntry {
  const source = planned.source;
  const fill = (text: string) => (!charName.trim() && planned.subject ? fillCharMacro(text, planned.subject) : text);
  const keys = source.keys.map(fill);
  // A character's primary entry answers to the character's name, whatever its keys were.
  if (planned.character && !keys.some((key) => key.trim().toLowerCase() === planned.character!.trim().toLowerCase())) keys.unshift(planned.character);
  return {
    name: planned.name,
    tag: planned.tag,
    content: fill(source.content),
    keys: keys.length > 0 ? keys : [planned.name],
    keysSecondary: source.keysSecondary.map(fill),
    isConstant: source.isConstant,
    position: source.position,
    insertionOrder: source.insertionOrder,
    scanDepth: source.scanDepth,
    activation: source.activation,
    origin: { kind: "imported", source: source.title },
  };
}
