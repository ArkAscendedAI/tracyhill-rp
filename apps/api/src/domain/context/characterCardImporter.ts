import { createId } from "../../lib/ids";
import { estimateTokens } from "./lorebookTokenEstimator";
import type { LorebookRepository } from "./lorebookRepository";
import { capEntryName, duplicateKey, IMPORT_MAX_CONTENT_CHARS, mapStEntryToRow, parseSillyTavernLorebook, type RowMapContext } from "./lorebookImporter";

// ── SillyTavern character-card import ──────────────────────────────────────────
// A character card is ONE character (not a lorebook): name/description/personality/
// scenario/mes_example, and — in V2/V3 cards — an embedded `character_book`. The
// book is NOT the World Info file shape: per the chara_card_v2/v3 spec `entries`
// is an ARRAY of { keys, secondary_keys, enabled, insertion_order, position,
// extensions… } — parseSillyTavernLorebook normalizes both shapes, and
// every entry goes through the same row mapper as a lorebook import so the
// selective-logic/position/recursion/sticky/match-option dials survive.
//
// SAFETY (the load-bearing part): import is ADDITIVE and NEVER destructive.
//   - the character firmware entry is SKIPPED if a same-name `characters` entry
//     already exists (never overwrite curated canon);
//   - character_book entries are DEDUPED against existing entries (name + content
//     prefix) so a re-import doesn't duplicate;
//   - nothing existing is ever mutated. Re-importing the same card is a full skip.

export interface CharacterCardImportResult {
  characterName: string | null;
  createdCharacter: boolean;
  skippedCharacter: boolean;        // a same-name characters entry already existed
  createdBookEntries: number;
  skippedBookEntries: number;       // duplicates of existing entries
  warnings: string[];
}

// Card fields the firmware reads. `first_mes` (an opening message, not canon)
// and `system_prompt` (a card-level prompt override that would clobber the
// campaign's own) are deliberately NOT imported.
interface CardData {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  mes_example?: string;
  creator_notes?: string;
  tags?: string[];
  character_book?: unknown;
}

// mes_example is the strongest voice signal a card carries, but the firmware is
// a `characters` entry (guaranteed delivery — its size taxes every turn), so
// the sample is capped rather than folded in whole.
const MAX_EXAMPLE_DIALOGUE_CHARS = 2000;

/** A card whose shape cannot be read at all: not an object, or a `name` that is
 *  not text. LorebookService maps it to a 400 with this message — cards are
 *  hand-editable JSON (and PNG chunks decode to whatever they hold), and the
 *  old `data.name?.trim()` on a number or array was a TypeError → 500. */
export class CharacterCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterCardError";
  }
}

const describeValue = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`;

/** A text field of the card: strings pass, anything else is dropped with a warning. */
function textField(raw: Record<string, unknown>, field: "description" | "personality" | "scenario" | "mes_example" | "creator_notes", errors: string[]): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  errors.push(`card field "${field}" is not text (${describeValue(value)}) — ignored`);
  return undefined;
}

/** Normalize a V1 (flat) / V2 / V3 card into its data object. Every text field
 *  of the result is a string or absent; `errors` are soft warnings the
 *  import result carries; an unreadable card throws CharacterCardError. */
export function parseCharacterCard(json: unknown): { data: CardData; errors: string[] } {
  const errors: string[] = [];
  // Unwrap a route envelope { card: <json> } if present.
  const root = (json && typeof json === "object" && "card" in (json as object))
    ? (json as { card: unknown }).card
    : json;
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new CharacterCardError(`not a character card object (got ${describeValue(root)})`);
  const obj = root as { spec?: unknown; data?: unknown };
  // V2/V3 nest under `data`; V1 is flat.
  const raw = (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) ? (obj.data as Record<string, unknown>) : (root as Record<string, unknown>);
  if (raw.name !== undefined && raw.name !== null && typeof raw.name !== "string") {
    throw new CharacterCardError(`card "name" must be text (got ${describeValue(raw.name)})`);
  }
  const data: CardData = {
    name: typeof raw.name === "string" ? raw.name : undefined,
    description: textField(raw, "description", errors),
    personality: textField(raw, "personality", errors),
    scenario: textField(raw, "scenario", errors),
    mes_example: textField(raw, "mes_example", errors),
    creator_notes: textField(raw, "creator_notes", errors),
    // buildFirmwareComment keeps only the string members; a non-array is ignored there.
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined,
    // parseSillyTavernLorebook reads this shape-safely (asString/asStringArray).
    character_book: raw.character_book,
  };
  if (!data.name?.trim()) errors.push("card has no character name");
  return { data, errors };
}

/** Extract the embedded card JSON from a PNG's tEXt chunk (`ccv3` preferred, else `chara`). */
export function extractCardFromPng(png: Buffer): unknown | null {
  // PNG signature.
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 8 || !png.subarray(0, 8).equals(SIG)) return null;
  const texts = new Map<string, string>();
  let off = 8;
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > png.length) break;
    if (type === "tEXt") {
      const chunk = png.subarray(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      if (nul > 0) {
        const keyword = chunk.toString("latin1", 0, nul);
        const text = chunk.toString("latin1", nul + 1);
        texts.set(keyword, text);
      }
    }
    if (type === "IEND") break;
    off = dataEnd + 4; // skip CRC
  }
  const b64 = texts.get("ccv3") ?? texts.get("chara");
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Build the character firmware entry content from the card fields. */
function buildFirmware(data: CardData): string {
  const parts: string[] = [];
  if (data.description?.trim()) parts.push(data.description.trim());
  if (data.personality?.trim()) parts.push(`Personality: ${data.personality.trim()}`);
  if (data.scenario?.trim()) parts.push(`Scenario: ${data.scenario.trim()}`);
  const example = data.mes_example?.trim();
  if (example) {
    const clipped = example.length > MAX_EXAMPLE_DIALOGUE_CHARS ? `${example.slice(0, MAX_EXAMPLE_DIALOGUE_CHARS).trimEnd()}…` : example;
    parts.push(`Example dialogue (voice reference):\n${clipped}`);
  }
  return parts.join("\n\n");
}

/** Card note + generic card tags go to the COMMENT, never the activation keys —
 *  "female"/"fantasy"/"OC" as whole-word keys fired the firmware (and the
 *  scene-present name match) on ordinary prose. */
function buildFirmwareComment(data: CardData): string | null {
  const parts: string[] = [];
  const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === "string" && Boolean(t.trim())).map((t) => t.trim()) : [];
  if (tags.length) parts.push(`card tags: ${[...new Set(tags)].join(", ").slice(0, 300)}`);
  if (data.creator_notes?.trim()) parts.push(`card note: ${data.creator_notes.trim().slice(0, 300)}`);
  return parts.length ? parts.join("\n") : null;
}

export function importCharacterCard(
  repo: LorebookRepository,
  userId: string,
  campaignId: string,
  json: unknown,
): CharacterCardImportResult {
  const warnings: string[] = [];
  const { data, errors } = parseCharacterCard(json);
  warnings.push(...errors);
  // The same name cap as the contract and the World Info importer: a
  // card name past it made an entry no editor save could carry.
  const trimmedName = data.name?.trim();
  const name = trimmedName ? capEntryName(trimmedName, warnings) : trimmedName;
  if (!name) {
    return { characterName: null, createdCharacter: false, skippedCharacter: false, createdBookEntries: 0, skippedBookEntries: 0, warnings };
  }

  // Snapshot existing entries once for collision detection: the character
  // collides on NAME among `characters` entries (never overwrite curated
  // canon); book entries collide on name + content prefix (the importer-wide
  // duplicate rule). The name set used to hold EVERY row of the campaign: a
  // location, event, trigger or disabled row that shared
  // the name ("Kesh" the ship) blocked the character's entry while the reply
  // said the existing one was kept.
  const existing = repo.listAllForCampaign(userId, campaignId);
  const existingNames = new Set(existing.filter((e) => e.tag?.trim().toLowerCase() === "characters").map((e) => norm(e.name)));
  const existingDupes = new Set(existing.map((e) => duplicateKey(e.name, e.content)));

  const now = new Date().toISOString();
  const legacySource = `card-import-${now}`;
  const rows: Parameters<LorebookRepository["createMany"]>[0] = [];

  // 1) Character firmware entry — SKIP if a same-name entry exists.
  let createdCharacter = false;
  let skippedCharacter = false;
  let firmware = buildFirmware(data);
  if (existingNames.has(norm(name))) {
    skippedCharacter = true;
    warnings.push(`character "${name}" already has a characters entry — kept the existing one (not overwritten)`);
  } else if (firmware.trim()) {
    if (firmware.length > IMPORT_MAX_CONTENT_CHARS) {
      warnings.push(`character "${name}" firmware truncated from ${firmware.length} to ${IMPORT_MAX_CONTENT_CHARS} chars`);
      firmware = firmware.slice(0, IMPORT_MAX_CONTENT_CHARS);
    }
    rows.push({
      id: createId(), userId, campaignId,
      name, tag: "characters", content: firmware,
      comment: buildFirmwareComment(data),
      keys: JSON.stringify([name]), keysSecondary: "[]",
      selectiveLogic: "and_any", scanDepth: 4, position: "before_main", insertionOrder: 100,
      probability: 100, isConstant: 0, isEnabled: 1,
      sticky: 0, cooldown: 0, delay: 0,
      excludeRecursion: 0, preventRecursion: 0, delayUntilRecursion: 0,
      tokensEstimate: estimateTokens(firmware),
      knownBy: null, matchOptionsJson: null, legacySource,
      createdAt: now, updatedAt: now,
    });
    createdCharacter = true;
  } else {
    warnings.push(`character "${name}" had no description/personality/scenario — no firmware entry created`);
  }

  // 2) Embedded character_book → the shared ST row mapper, deduped against
  //    existing entries (and within this import).
  let createdBookEntries = 0;
  let skippedBookEntries = 0;
  if (data.character_book) {
    const { entries: bookEntries, errors: bookErrors, defaultScanDepth } = parseSillyTavernLorebook(data.character_book);
    warnings.push(...bookErrors);
    const ctx: RowMapContext = { userId, campaignId, now, legacySource, defaultTag: "lore", defaultScanDepth, errors: warnings };
    for (const entry of bookEntries) {
      const row = mapStEntryToRow(entry, ctx);
      if (!row) { skippedBookEntries++; continue; }
      const dupe = duplicateKey(row.name, row.content);
      if (existingDupes.has(dupe)) { skippedBookEntries++; continue; }
      rows.push(row);
      existingDupes.add(dupe);
      createdBookEntries++;
    }
  }

  if (rows.length > 0) repo.createMany(rows);
  return { characterName: name, createdCharacter, skippedCharacter, createdBookEntries, skippedBookEntries, warnings };
}
