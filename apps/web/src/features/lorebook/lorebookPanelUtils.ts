import { LOREBOOK_KEY_MAX_CHARS, LOREBOOK_MAX_KEYS, THREAD_INDEX_ENTRY_NAME, THREADS_TAG } from "@tracyhill-rp/contracts";
import type { CharacterCardImportResult, LorebookEntry, LorebookImportResult, LorebookPosition, SelectiveLogic, UpdateLorebookEntryRequest } from "@tracyhill-rp/contracts";

// Living World — offscreen/provisional markers live as JSON in the entry
// comment. The panel memoizes this per entry; it was called up to three
// times per row per render.
export type WorldMarker = { offscreen: boolean; provisional: boolean } & Record<string, unknown>;

export function worldMarkerOf(comment: string | null | undefined): WorldMarker | null {
  if (!comment) return null;
  try {
    const parsed = JSON.parse(comment);
    if (parsed && typeof parsed === "object" && parsed.offscreen === true) {
      return { ...parsed, offscreen: true, provisional: parsed.provisional === true };
    }
    return null;
  } catch { return null; }
}

// The Dramatist's sealed advance notes carry this tag. The server's getTags
// excludes sealed rows since 2026-09-02; this is the client-side
// belt for a tag list served by an older API instance, so the facet never
// reveals that sealed machinery exists.
const SEALED_ONLY_TAGS = new Set(["dramatist"]);

export function visibleTags(tags: string[] | undefined): string[] {
  return (tags ?? []).filter((tag) => tag.trim() !== "" && !SEALED_ONLY_TAGS.has(tag.toLowerCase()));
}

/**
 * The tag filter's options after "All tags" (`tagFilter` "" is no filter): the campaign's visible tags, and the tag
 * the list is filtered by first when the refreshed tags no longer hold it (a retag or delete removed its last use), so
 * the select shows what filters the list and "All tags" can clear it (Android's `lorebookTagChips`).
 */
export function lorebookTagOptions(tags: string[] | undefined, tagFilter: string): string[] {
  const shown = visibleTags(tags);
  return tagFilter && !shown.includes(tagFilter) ? [tagFilter, ...shown] : shown;
}

// What the editor should do when the SELECTED entry's full row changes under
// it — decided from the row the fields were seeded from vs. the row now loaded.
// Without this a History revert left the textarea holding
// the pre-revert draft and Save wrote it straight back.
//   seed         — the fields were not seeded from this entry yet: its full row
//                  just arrived after a selection (the list
//                  carries no text, so the click can no longer seed the fields;
//                  the panel fetches the full row and seeds when it lands).
//   reseed       — same entry, newer row, no unsaved edits: reload every field.
//   comment-only — the user has unsaved edits, their comment is untouched, and
//                  no other server field changed: refresh just the comment
//                  (the canon marker) and keep their edits.
//   stale        — unsaved edits AND a newer row: leave the draft, tell them.
//   none         — nothing changed, or no row is loaded.
// `listTexts` is the text each list field was seeded with: an update sends a list only when its text
// differs from it.
export type EditorSeed = { id: string; updatedAt: string; comment: string | null; fieldsFingerprint: string; listTexts: SeededListTexts };
export type EditorResyncPlan = "seed" | "reseed" | "comment-only" | "stale" | "none";

type EditorRow = Pick<LorebookEntry, "id" | "updatedAt" | "comment"> & Partial<LorebookEntry>;
function fieldsFingerprint(entry: EditorRow): string {
  return JSON.stringify([entry.name, entry.content, entry.keys, entry.keysSecondary, entry.tag, entry.position,
    entry.insertionOrder, entry.scanDepth, entry.selectiveLogic, entry.probability, entry.isConstant, entry.isEnabled,
    entry.sticky, entry.cooldown, entry.delay, entry.excludeRecursion, entry.preventRecursion, entry.delayUntilRecursion, entry.knownBy, entry.matchOptions]);
}
export function makeEditorSeed(entry: EditorRow): EditorSeed {
  return { id: entry.id, updatedAt: entry.updatedAt, comment: entry.comment, fieldsFingerprint: fieldsFingerprint(entry), listTexts: listTextsOf(entry) };
}

export function planEditorResync(
  seeded: EditorSeed | null,
  incoming: EditorRow | null,
  dirty: boolean,
  editComment: string,
): EditorResyncPlan {
  if (!incoming) return "none";
  if (!seeded || seeded.id !== incoming.id) return "seed";
  if (seeded.updatedAt === incoming.updatedAt) return "none";
  if (!dirty) return "reseed";
  if (editComment === (seeded.comment ?? "") && fieldsFingerprint(incoming) === seeded.fieldsFingerprint) return "comment-only";
  return "stale";
}

/**
 * Why the bulk bar's keys cannot be appended as they are, or null: the bulk contract takes
 * at most LOREBOOK_MAX_KEYS keys of at most LOREBOOK_KEY_MAX_CHARS each, and answered more with a bare "invalid bulk
 * action". `keys` is the split, trimmed list the action sends.
 */
export function bulkKeysProblem(keys: readonly string[]): string | null {
  if (keys.length > LOREBOOK_MAX_KEYS) return `This list has ${keys.length} keys; one append can add at most ${LOREBOOK_MAX_KEYS}.`;
  const long = keys.findIndex((key) => key.length > LOREBOOK_KEY_MAX_CHARS);
  return long >= 0 ? `Key ${long + 1} is ${keys[long]!.length} characters; a key can be at most ${LOREBOOK_KEY_MAX_CHARS}.` : null;
}

// A bulk request may only carry entries that are in the list on screen.
// The selection is a Set of ids that used to
// survive a campaign switch, so "Disable"/"Delete" under campaign B posted
// campaign A's ids — and the server applied them (its own half of the fix
// scopes the route by campaign). Ids the current list does not contain are
// reported, never sent.
export function effectiveBulkSelection(selected: ReadonlySet<string>, loaded: ReadonlyArray<{ id: string }>): { ids: string[]; hidden: number } {
  const ids = loaded.filter((entry) => selected.has(entry.id)).map((entry) => entry.id);
  return { ids, hidden: selected.size - ids.length };
}

/**
 * The panel's error line when a bulk verb finds none of the selected entries in the list on screen, so nothing is sent.
 * Every bulk button is disabled in that state, so the line guards any other caller of `runBulk`. A plain
 * sentence (it was a dash pause).
 */
export const BULK_NONE_IN_LIST = "None of the selected entries are in the current list, so nothing was changed.";

/** Commas inside a regex literal (including character classes) are part of that key. */
export function splitKeyList(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let inRegex = false;
  let inClass = false;
  let escaped = false;
  for (const ch of raw) {
    if (!inRegex && ch === "/" && current.trim() === "") {
      inRegex = true;
    } else if (inRegex) {
      if (!escaped) {
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) inRegex = false;
      }
      escaped = ch === "\\" && !escaped;
    } else if (ch === ",") {
      out.push(current.trim()); current = ""; continue;
    }
    current += ch;
  }
  // A segment that opened with "/" and never closed is not a regex: the server reads a key as one only when
  // a second "/" follows the first (keywordActivator.matchKey), so it splits at its commas like plain text.
  // It used to swallow every later key into one.
  if (inRegex) out.push(...current.split(",").map((key) => key.trim()));
  else out.push(current.trim());
  return out.filter(Boolean);
}

/** The text the editor shows for a stored key list. */
export function keyListText(keys: ReadonlyArray<string>): string {
  return keys.join(", ");
}

/** The text the editor shows for a stored known-by list ("" = global). */
export function knownByText(knownBy: ReadonlyArray<string> | null | undefined): string {
  return knownBy ? knownBy.join(", ") : "";
}

/** Typed known-by text split into names: plain commas, blank = global (null). */
export function splitKnownBy(raw: string): string[] | null {
  return raw.trim() ? raw.split(",").map((name) => name.trim()).filter(Boolean) : null;
}

export type SeededListTexts = { keys: string; keysSecondary: string; knownBy: string };

/** The editor text of each list field, as the panel seeds it from a stored row. */
export function listTextsOf(entry: Partial<Pick<LorebookEntry, "keys" | "keysSecondary" | "knownBy">>): SeededListTexts {
  return { keys: keyListText(entry.keys ?? []), keysSecondary: keyListText(entry.keysSecondary ?? []), knownBy: knownByText(entry.knownBy) };
}

function sameList(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Whether a stored key list reads back unchanged from the editor's text. A key holding a comma, or a
 * slash that the text makes read as a regex, does not: the editor then says that an edit re-splits the
 * field. Leaving the field untouched keeps the stored list either way.
 */
export function keysSurviveTextEdit(keys: ReadonlyArray<string>): boolean {
  return sameList(splitKeyList(keyListText(keys)), keys);
}

/** Whether a stored known-by list reads back unchanged from the editor's text (a name with a comma does not). */
export function knownBySurvivesTextEdit(knownBy: ReadonlyArray<string> | null | undefined): boolean {
  return !knownBy?.length || sameList(splitKnownBy(knownByText(knownBy)) ?? [], knownBy);
}

/**
 * Whether the thread tracker owns an entry: "index" for the
 * constant Thread Index, whose comment holds the tracker's whole ledger (64k to 182k characters
 * on production) and whose text is re-rendered from it on every run; "thread" for a per-thread
 * entry the tracker rewrites when that thread changes. The editor shows both read-only: a save
 * of the index failed on the comment cap, and any edit would be overwritten by the next run.
 */
export function trackerOwnership(entry: Pick<LorebookEntry, "name" | "tag" | "isConstant">): "index" | "thread" | null {
  if (entry.isConstant && entry.name === THREAD_INDEX_ENTRY_NAME) return "index";
  // The workers compare the tag exactly, so the editor does too.
  if (entry.tag === THREADS_TAG) return "thread";
  return null;
}

/** The editor's field state, as typed (text fields raw, before trimming and splitting). */
export type EditorFieldValues = {
  name: string; content: string; tag: string; comment: string; keys: string; keysSecondary: string;
  position: string; insertionOrder: number; scanDepth: number; selectiveLogic: string; probability: number;
  isConstant: boolean; isEnabled: boolean; sticky: number; cooldown: number; delay: number;
  excludeRecursion: boolean; preventRecursion: boolean; delayUntilRecursion: boolean; knownBy: string;
};

/**
 * The payload the editor sends. `position` has no control since 2026-09-29 (context
 * assembly never reads it); the value the fields were seeded
 * with — the stored row's, or the contract default for a new entry — goes back
 * unchanged, so a save never rewrites it.
 *
 * Without a seed (a new entry) every field is sent. With the seed of the entry being
 * edited, the update leaves out each list (keys, secondary keys, known-by) whose text
 * is still the text it was seeded with, so the stored list stays exactly as it is:
 * the text cannot carry a key or name that holds a comma, or a leading-"/" literal,
 * and re-splitting it on an untouched save rewrote them. An edited
 * list is sent split as typed.
 */
export function buildEntryPayload(f: EditorFieldValues): ReturnType<typeof fullEntryPayload>;
export function buildEntryPayload(f: EditorFieldValues, seed: EditorSeed | null): UpdateLorebookEntryRequest;
export function buildEntryPayload(f: EditorFieldValues, seed?: EditorSeed | null): ReturnType<typeof fullEntryPayload> | UpdateLorebookEntryRequest {
  const payload = fullEntryPayload(f);
  if (!seed) return payload;
  const { keys, keysSecondary, knownBy, ...rest } = payload;
  return {
    ...rest,
    ...(f.keys !== seed.listTexts.keys ? { keys } : {}),
    ...(f.keysSecondary !== seed.listTexts.keysSecondary ? { keysSecondary } : {}),
    ...(f.knownBy !== seed.listTexts.knownBy ? { knownBy } : {}),
  };
}

function fullEntryPayload(f: EditorFieldValues) {
  return {
    name: f.name.trim(),
    content: f.content.trim(),
    tag: f.tag.trim() || null,
    comment: f.comment.trim() || null,
    keys: splitKeyList(f.keys),
    keysSecondary: splitKeyList(f.keysSecondary),
    position: f.position as LorebookPosition,
    insertionOrder: f.insertionOrder,
    scanDepth: f.scanDepth,
    selectiveLogic: f.selectiveLogic as SelectiveLogic,
    probability: f.probability,
    isConstant: f.isConstant,
    isEnabled: f.isEnabled,
    sticky: f.sticky,
    cooldown: f.cooldown,
    delay: f.delay,
    excludeRecursion: f.excludeRecursion,
    preventRecursion: f.preventRecursion,
    delayUntilRecursion: f.delayUntilRecursion,
    knownBy: splitKnownBy(f.knownBy),
  };
}

/**
 * What an import says back: a headline and the full list of problems, which the panel shows
 * in a collapsible list (the lorebook import showed only "N errors", and the card
 * import never showed its warnings at all).
 */
export type ImportReport = { headline: string; noun: "error" | "warning"; items: string[] };

/** How many problems an import report lists before "Show N more": the importer's list has no cap. */
export const IMPORT_REPORT_PREVIEW_ITEMS = 200;

/** The report items to render: the first IMPORT_REPORT_PREVIEW_ITEMS until the reader expands the list. */
export function importReportItemsShown(items: ReadonlyArray<string>, expanded: boolean): { shown: string[]; hidden: number } {
  if (expanded || items.length <= IMPORT_REPORT_PREVIEW_ITEMS) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, IMPORT_REPORT_PREVIEW_ITEMS), hidden: items.length - IMPORT_REPORT_PREVIEW_ITEMS };
}

export function lorebookImportReport(result: LorebookImportResult): ImportReport {
  return {
    headline: `Imported ${result.imported} entr${result.imported === 1 ? "y" : "ies"}${result.skipped ? `, skipped ${result.skipped}` : ""}`,
    noun: "error",
    items: result.errors,
  };
}

export function characterCardImportReport(r: CharacterCardImportResult): ImportReport {
  const bits = [
    r.createdCharacter ? `created ${r.characterName}` : r.skippedCharacter ? `${r.characterName} kept (already existed)` : "no character entry",
    `${r.createdBookEntries} book entr${r.createdBookEntries === 1 ? "y" : "ies"}${r.skippedBookEntries ? ` (+${r.skippedBookEntries} dupes skipped)` : ""}`,
  ];
  return { headline: `Card import: ${bits.join(" · ")}`, noun: "warning", items: r.warnings };
}

/**
 * The list pages 1,000 rows at a time by offset; when rows change between two pages (or, before
 * the server's id tiebreaker, when rows tie on the sort column) a page can skip rows and the load
 * ends short of the route's `total`. It used to end short silently; the panel says so.
 */
export function describeShortLoad(loaded: number, total: number): string | null {
  if (loaded >= total) return null;
  return `Loaded ${loaded} of ${total} entries. Some rows were missed while the list loaded; reload to get them all.`;
}

/** The line the panel shows when a rebuild returns `{ indexed, total }`. */
export function describeRebuildResult(result: { indexed: number; total: number }, staleOnly: boolean, campaignName: string): string {
  if (staleOnly) {
    return `Embeddings for ${campaignName}, stale and missing only: ${result.indexed} entr${result.indexed === 1 ? "y" : "ies"} embedded; ${result.total} enabled in all.`;
  }
  // A full rebuild sends every enabled entry, so a shortfall is a failure the embedding
  // service recorded (no provider key, a provider error, a store error).
  const shortfall = result.indexed < result.total ? " The rest were not embedded; System events has the reason." : "";
  return `Embeddings for ${campaignName}, all entries: ${result.indexed} of ${result.total} enabled entries embedded.${shortfall}`;
}

// Field names of the create/update contract → the labels the editor shows:
// a client-side parse failure names the field instead of the
// server's "invalid lorebook entry update".
const LOREBOOK_FIELD_LABELS: Record<string, string> = {
  name: "Name", tag: "Tag", content: "Content", comment: "Comment", keys: "Key", keysSecondary: "Secondary key",
  knownBy: "Known by", scanDepth: "Scan depth", insertionOrder: "Insertion order", probability: "Probability",
  sticky: "Sticky turns", cooldown: "Cooldown turns", delay: "Delay turns", position: "Position", selectiveLogic: "Selective logic",
};

export function lorebookFieldLabel(path: ReadonlyArray<string | number>): string {
  const [head, index] = path;
  const base = LOREBOOK_FIELD_LABELS[String(head)] ?? (head == null ? "Entry" : String(head));
  return typeof index === "number" ? `${base} #${index + 1}` : base;
}
