import type { LorebookCorpusActivation } from "@tracyhill-rp/contracts";

import { mapStEntryToRow, parseSillyTavernLorebook, type RowMapContext } from "../context/lorebookImporter";
import type { ImportSourceEntry } from "./wizardRunRepository";

// A SillyTavern lorebook turned into the source of a wizard import run. Every entry
// goes through the lorebook importer's own row mapper, so the import reads the same fields, caps and quirks as the
// Lorebook panel's import (World Info files, character card books, this app's own export). Then {{user}} and {{char}}
// are resolved: SillyTavern fills them in at send time, while a campaign here keeps names in its text.

/** Lorebooks larger than this are refused: every entry costs model calls in the conversion. */
export const IMPORT_MAX_ENTRIES = 2000;

const SELECTIVE_LOGIC = new Set(["and_any", "not_all", "not_any", "and_all"]);

export type PreparedSillyTavernImport = {
  entries: ImportSourceEntry[];
  // Entries in the file, before any were left out.
  total: number;
  // Why entries were left out ("3 entries had no text").
  leftOut: string[];
  // Field corrections the row mapper reported (a cut name, an invalid probability, …), kept for the review.
  notices: string[];
};

/**
 * Replaces SillyTavern's name macros: {{user}} (and the legacy <USER>) with the player character, {{char}} (and the
 * legacy <BOT>/<CHAR>) with the name the owner gave, when one was given. Left blank, {{char}} waits for the worker,
 * which fills it in entry by entry with the character the entry is about: lorebooks mostly use it that way (a
 * character's example lines are written "{{char}}: …"). Any other macro stays as written.
 */
export function resolveSillyTavernNames(text: string, names: { user: string; char: string }): string {
  const out = text.replace(/\{\{\s*user\s*\}\}/gi, names.user).replace(/<USER>/g, names.user);
  return names.char.trim() ? fillCharMacro(out, names.char) : out;
}

/** {{char}} (and the legacy <BOT>/<CHAR>) filled in with one name. */
export function fillCharMacro(text: string, name: string): string {
  return text.replace(/\{\{\s*char\s*\}\}/gi, name).replace(/<(?:BOT|CHAR)>/g, name);
}

/** The macros a text still carries after names are resolved ({{random::a::b}}, {{time}}, an unresolved {{char}}). */
export function remainingMacros(text: string): string[] {
  return [...new Set(text.match(/\{\{[^{}\n]{1,80}\}\}|<(?:BOT|CHAR)>/g) ?? [])];
}

export function prepareSillyTavernImport(json: unknown, names: { playerCharacterName: string; charName: string }): PreparedSillyTavernImport {
  // A character card (V2/V3) carries its lorebook as `character_book`; a World Info file is the book itself.
  const root = json as { data?: { character_book?: unknown }; character_book?: unknown } | null;
  const parsed = parseSillyTavernLorebook(root?.data?.character_book ?? root?.character_book ?? json);
  const leftOut: string[] = [];
  const notices: string[] = [];
  if (parsed.entries.length === 0) {
    return { entries: [], total: 0, leftOut: ["The file has no lorebook entries. Choose a SillyTavern World Info file or a character card with a lorebook."], notices: parsed.errors };
  }
  if (parsed.entries.length > IMPORT_MAX_ENTRIES) {
    return { entries: [], total: parsed.entries.length, leftOut: [`The lorebook has ${parsed.entries.length} entries; an import takes up to ${IMPORT_MAX_ENTRIES}. Split it in SillyTavern first.`], notices: [] };
  }
  const resolve = (text: string) => resolveSillyTavernNames(text, { user: names.playerCharacterName, char: names.charName });
  const errors: string[] = [...parsed.errors];
  const ctx: RowMapContext = { userId: "", campaignId: "", now: new Date().toISOString(), legacySource: "", defaultScanDepth: parsed.defaultScanDepth, errors };
  const entries: ImportSourceEntry[] = [];
  let empty = 0;
  parsed.entries.forEach((raw, index) => {
    const errorsBefore = errors.length;
    const row = mapStEntryToRow(raw, ctx);
    if (!row) {
      // The mapper skips an entry with no text silently and names the other skips (the thread tracker's index).
      if (errors.length === errorsBefore) empty += 1;
      else leftOut.push(...errors.slice(errorsBefore));
      return;
    }
    const matchOptions = row.matchOptionsJson ? JSON.parse(row.matchOptionsJson) as { caseSensitive?: boolean; matchWholeWords?: boolean } : {};
    const activation: LorebookCorpusActivation = {
      selectiveLogic: row.selectiveLogic && SELECTIVE_LOGIC.has(row.selectiveLogic) ? row.selectiveLogic as LorebookCorpusActivation["selectiveLogic"] : "and_any",
      probability: row.probability ?? 100,
      sticky: row.sticky ?? 0,
      cooldown: row.cooldown ?? 0,
      delay: row.delay ?? 0,
      excludeRecursion: row.excludeRecursion === 1,
      preventRecursion: row.preventRecursion === 1,
      delayUntilRecursion: row.delayUntilRecursion === 1,
      ...(matchOptions.caseSensitive ? { caseSensitive: true } : {}),
      ...(typeof matchOptions.matchWholeWords === "boolean" ? { matchWholeWords: matchOptions.matchWholeWords } : {}),
      enabled: row.isEnabled === 1,
    };
    entries.push({
      index,
      // A title can carry an author's spacing ("Borchi guild      *change key…*"); one space keeps it readable as a name.
      title: resolve(row.name).replace(/\s+/g, " ").trim(),
      content: resolve(row.content),
      keys: (JSON.parse(row.keys ?? "[]") as string[]).map(resolve),
      keysSecondary: (JSON.parse(row.keysSecondary ?? "[]") as string[]).map(resolve),
      isConstant: row.isConstant === 1,
      position: row.position ?? "before_main",
      insertionOrder: row.insertionOrder ?? 100,
      scanDepth: row.scanDepth ?? 4,
      activation,
      group: row.tag ?? null,
    });
  });
  if (empty > 0) leftOut.unshift(`${empty} ${empty === 1 ? "entry had" : "entries had"} no text.`);
  for (const message of errors) if (!leftOut.includes(message)) notices.push(message);
  if (entries.length === 0 && leftOut.length === 0) leftOut.push("No entry in the file has text to import.");
  return { entries, total: parsed.entries.length, leftOut, notices };
}
