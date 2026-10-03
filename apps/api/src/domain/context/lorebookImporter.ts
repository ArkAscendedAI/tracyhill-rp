import { ARCHIVED_TAG, LOREBOOK_KEY_MAX_CHARS, LOREBOOK_MAX_KEYS, LOREBOOK_NAME_MAX_CHARS, THREADS_TAG, THREAD_INDEX_ENTRY_NAME } from "@tracyhill-rp/contracts";

import { createId } from "../../lib/ids";
import { estimateTokens } from "./lorebookTokenEstimator";
import { normalizeEntryTag, sanitizeCreateTag } from "./lorebookTags";
import { normalizeKnownBy } from "./lorebookKnownBy";
import { normalizeKeyList } from "./lorebookKeys";
import type { LorebookRepository } from "./lorebookRepository";

// SillyTavern *World Info file* entry shape ({ entries: { "<uid>": {...} } }).
// The Character Card V2/V3 `character_book` shape is DIFFERENT (an ARRAY of
// entries with `keys`/`secondary_keys`/`enabled`/`insertion_order` and the ST
// extras nested under `extensions`) — normalizeBookEntry() folds it onto this
// interface so both importers share one row mapper (the card path used to read
// the WI names and imported every real card's book with no keys, always
// enabled, order 100).
export interface STEntry {
  uid?: number;
  key?: string[];
  keysecondary?: string[];
  // Native extras carried by our own "json" export format — absent in real ST
  // files, passed through so an export→import round-trip is lossless.
  name?: string;
  exportId?: string;
  compressedRefIds?: string[] | null;
  knownBy?: string[] | null;
  comment?: string;
  content?: string;
  constant?: boolean;
  selectiveLogic?: number;
  order?: number;
  position?: number;
  disable?: boolean;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  delayUntilRecursion?: boolean | number;
  probability?: number;
  scanDepth?: number | null;
  sticky?: number | null;
  cooldown?: number | null;
  delay?: number | null;
  group?: string;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  addMemo?: boolean;
  displayIndex?: number;
  // SillyTavern's switches for the two dials below: `useProbability: false`
  // means the probability is ignored (the entry always fires) and `selective:
  // false` means the secondary keys are ignored. Card books carry
  // `extensions.useProbability` and the spec's top-level `selective`.
  useProbability?: boolean;
  selective?: boolean;
  [key: string]: unknown;
}

interface STLorebook {
  entries?: Record<string, STEntry> | unknown[];
  originalData?: { entries?: Record<string, STEntry> | unknown[] };
  // character_book (V2/V3 spec) book-level scan depth — the per-entry default.
  scan_depth?: number;
}

// Character Card V2/V3 spec `character_book.entries[]` member. ST's own
// convertWorldInfoToCharacterBook() writes the WI-only dials (position index,
// recursion flags, probability, sticky/cooldown/delay, match options, group,
// selectiveLogic) under `extensions` using snake_case names.
interface SpecBookEntry {
  id?: number;
  keys?: unknown;
  secondary_keys?: unknown;
  comment?: unknown;
  name?: unknown;
  content?: unknown;
  constant?: unknown;
  selective?: unknown;
  insertion_order?: unknown;
  enabled?: unknown;
  position?: unknown; // "before_char" | "after_char"
  extensions?: Record<string, unknown> | null;
}

const SELECTIVE_LOGIC_MAP: Record<number, string> = {
  0: "and_any",
  1: "not_all",
  2: "not_any",
  3: "and_all",
};

const POSITION_MAP: Record<number, string> = {
  0: "before_main",
  1: "after_main",
  2: "top",
  3: "bottom",
  4: "before_main",
  5: "before_main",
};

// Mirrors createLorebookEntryRequestSchema's caps — an import must not create
// rows the manual editor could never have.
export const IMPORT_MAX_CONTENT_CHARS = 100_000;
export const IMPORT_MAX_KEYS = LOREBOOK_MAX_KEYS;

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/** Internal result: the contract shape plus the ids created (for targeted re-embed). */
export interface ImportOutcome extends ImportResult {
  createdIds: string[];
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((k): k is string => typeof k === "string" && Boolean(k.trim())).map((k) => k.trim()) : [];
const asNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const asBool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Fold a Character Card V2/V3 `character_book` entry onto the WI entry shape.
 * Spec names win; the WI names are read as a fallback because some exporters
 * emit both, and ST's `extensions` block carries the WI-only dials.
 */
export function normalizeBookEntry(raw: unknown, errors: string[] = []): STEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as SpecBookEntry & STEntry;
  const ext = (e.extensions && typeof e.extensions === "object") ? e.extensions : {};
  const numeric = (field: string, ...values: unknown[]): number | undefined => {
    const value = values.find(value => value != null);
    if (value === undefined) return undefined;
    const parsed = asNumber(value);
    if (parsed === undefined) errors.push(`entry "${asString(e.name) ?? asString(e.comment) ?? "Unnamed Entry"}" invalid ${field}; using its default`);
    return parsed;
  };
  const specPosition = asString(e.position);
  const position = specPosition === "after_char" ? 1
    : specPosition === "before_char" ? 0
    : numeric("position", ext.position, e.position);
  const enabled = asBool(e.enabled);
  return {
    uid: asNumber(e.id) ?? asNumber(e.uid),
    key: e.keys !== undefined ? asStringArray(e.keys) : asStringArray(e.key),
    keysecondary: e.secondary_keys !== undefined ? asStringArray(e.secondary_keys) : asStringArray(e.keysecondary),
    name: asString(e.name),
    knownBy: Array.isArray(e.knownBy) ? e.knownBy : null,
    comment: asString(e.comment),
    content: asString(e.content),
    constant: asBool(e.constant),
    selective: asBool(e.selective) ?? asBool(ext.selective),
    useProbability: asBool(ext.useProbability) ?? asBool(e.useProbability),
    selectiveLogic: numeric("selectiveLogic", ext.selectiveLogic, e.selectiveLogic),
    order: numeric("order", e.insertion_order, e.order),
    position,
    disable: enabled !== undefined ? !enabled : asBool(e.disable),
    excludeRecursion: asBool(ext.exclude_recursion) ?? asBool(e.excludeRecursion),
    preventRecursion: asBool(ext.prevent_recursion) ?? asBool(e.preventRecursion),
    delayUntilRecursion: asBool(ext.delay_until_recursion) ?? asNumber(ext.delay_until_recursion) ?? (e.delayUntilRecursion as boolean | number | undefined),
    probability: numeric("probability", ext.probability, e.probability),
    scanDepth: numeric("scanDepth", ext.scan_depth, e.scanDepth),
    sticky: numeric("sticky", ext.sticky, e.sticky),
    cooldown: numeric("cooldown", ext.cooldown, e.cooldown),
    delay: numeric("delay", ext.delay, e.delay),
    group: asString(ext.group) ?? asString(e.group),
    caseSensitive: asBool(ext.case_sensitive) ?? asBool(e.caseSensitive),
    matchWholeWords: asBool(ext.match_whole_words) ?? asBool(e.matchWholeWords),
    displayIndex: numeric("displayIndex", ext.display_index, e.displayIndex),
  };
}

export function parseSillyTavernLorebook(json: unknown): { entries: STEntry[]; errors: string[]; defaultScanDepth?: number } {
  const errors: string[] = [];
  const data = json as STLorebook;
  // The web client posts { campaignId, format, data: <file> } — unwrap the
  // envelope so UI imports (and export→import round-trips) find the entries.
  const envelope = (json as { data?: STLorebook } | null)?.data;
  const book = data?.entries ? data : data?.originalData?.entries ? data.originalData : envelope?.entries ? envelope : envelope?.originalData?.entries ? envelope.originalData : null;
  const raw = book?.entries;
  if (!raw || typeof raw !== "object") {
    errors.push("no entries found in lorebook JSON");
    return { entries: [], errors };
  }
  const defaultScanDepth = asNumber((book as STLorebook).scan_depth) ?? asNumber(data?.scan_depth) ?? asNumber(envelope?.scan_depth);
  if (Array.isArray(raw)) {
    // Character Card V2/V3 `character_book` shape (spec: entries is an array).
    const entries = raw.map(entry => normalizeBookEntry(entry, errors)).filter((e): e is STEntry => e !== null);
    return { entries, errors, defaultScanDepth };
  }
  // SillyTavern World Info file shape ({ entries: { uid: {...} } }).
  const entries = Object.values(raw).filter((e): e is STEntry => e != null && typeof e === "object");
  return { entries, errors, defaultScanDepth };
}

export interface RowMapContext {
  userId: string;
  campaignId: string;
  now: string;
  legacySource: string;
  /** Tag used when the entry carries no ST group. */
  defaultTag?: string | null;
  defaultScanDepth?: number;
  errors: string[];
}

/**
 * Map ONE normalized ST entry to a lorebook row. Returns null (and counts as
 * "skipped") for an empty-content entry. Over-cap content is truncated and
 * surfaced in `errors` rather than silently kept whole or dropped.
 */
export function mapStEntryToRow(entry: STEntry, ctx: RowMapContext): Parameters<LorebookRepository["createMany"]>[0][number] | null {
  if (typeof entry.content !== "string") {
    ctx.errors.push("entry with missing or non-text content skipped");
    return null;
  }
  let content = entry.content.trim();
  if (!content) return null;

  // The one key rule: an over-long key is cut to the contract's 500
  // characters (the importer's long-standing choice), then the list is deduped
  // case-insensitively and capped at LOREBOOK_MAX_KEYS, with the cap reported.
  const primaryList = normalizeKeyList(asStringArray(entry.key).map(key => key.slice(0, LOREBOOK_KEY_MAX_CHARS)));
  const keys = primaryList.keys;
  // `selective: false`: SillyTavern ignores the secondary keys, while this
  // engine gates on any non-empty secondary list, so they are not imported. A
  // World Info file carries the switch at the top level; a card book's
  // normalizeBookEntry already folded it there; `extensions` is read as a fallback.
  const extensions = (entry.extensions && typeof entry.extensions === "object" ? entry.extensions : {}) as Record<string, unknown>;
  const selective = asBool(entry.selective) ?? asBool(extensions.selective);
  const useProbability = asBool(entry.useProbability) ?? asBool(extensions.useProbability);
  const secondaryList = normalizeKeyList(selective === false ? [] : asStringArray(entry.keysecondary).map(key => key.slice(0, LOREBOOK_KEY_MAX_CHARS)));
  const keysSecondary = secondaryList.keys;
  const derived = deriveName(entry, keys);
  // One name cap for the contract and both importers: a longer name is cut
  // to what the editor accepts, and the import says so.
  const name = capEntryName(derived, ctx.errors);
  for (const [label, list] of [["keys", primaryList], ["secondary keys", secondaryList]] as const) {
    if (list.capped) ctx.errors.push(`entry "${name}" has more than ${IMPORT_MAX_KEYS} ${label}; kept the first ${IMPORT_MAX_KEYS} (left off: ${list.overCap.slice(0, 10).join(", ")}${list.overCap.length > 10 ? ` +${list.overCap.length - 10} more` : ""})`);
  }
  // Reserved lifecycle tags: an ST `group` of
  // `threads` or `archived` lands as `events` through the shared sanitizer,
  // and the import says so. Two exceptions keep a round trip of our own
  // export honest: a native archive trigger (group `archived` WITH cold
  // references, which the importer re-links) keeps its tag, and the thread
  // tracker's index is not imported at all (the campaign's tracker keeps its
  // own; an imported copy would be a second, stale index in every turn).
  const group = sanitizeCreateTag(entry.group);
  const rawGroup = normalizeEntryTag(entry.group)?.toLowerCase() ?? null;
  if (rawGroup === THREADS_TAG && name === THREAD_INDEX_ENTRY_NAME && entry.constant === true) {
    ctx.errors.push(`skipped "${name}": the thread tracker's index is rebuilt by the campaign's own tracker, never imported`);
    return null;
  }
  const nativeTrigger = rawGroup === ARCHIVED_TAG && Array.isArray(entry.compressedRefIds) && asStringArray(entry.compressedRefIds).length > 0;
  const tag = nativeTrigger ? ARCHIVED_TAG : group.tag;
  if (group.retagged && !nativeTrigger) {
    ctx.errors.push(`entry "${name}" used the reserved group "${normalizeEntryTag(entry.group)}"; imported with the tag "events" (threads belongs to the thread tracker, archived to compressed archive entries)`);
  }
  const integer = (field: string, value: unknown, fallback: number, min: number, max: number): number => {
    if (value == null) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max) return value;
    ctx.errors.push(`entry "${name}" invalid ${field}; using ${fallback}`);
    return fallback;
  };
  const boolean = (field: string, value: unknown, fallback = false): boolean => {
    if (value == null) return fallback;
    if (typeof value === "boolean") return value;
    ctx.errors.push(`entry "${name}" invalid ${field}; using ${fallback}`);
    return fallback;
  };
  if (content.length > IMPORT_MAX_CONTENT_CHARS) {
    ctx.errors.push(`entry "${name}" content truncated from ${content.length} to ${IMPORT_MAX_CONTENT_CHARS} chars`);
    content = content.slice(0, IMPORT_MAX_CONTENT_CHARS);
  }

  // Persist BOTH explicit states. keywordActivator defaults an absent
  // matchWholeWords to TRUE, so an explicit `false` (substring matching —
  // partial keys, inflections, CJK) must be stored, not dropped.
  const matchOptions: Record<string, boolean> = {};
  if (entry.caseSensitive) matchOptions.caseSensitive = true;
  if (entry.matchWholeWords === false) matchOptions.matchWholeWords = false;
  else if (entry.matchWholeWords === true) matchOptions.matchWholeWords = true;

  return {
    id: createId(),
    userId: ctx.userId,
    campaignId: ctx.campaignId,
    name,
    tag: tag ?? (ctx.defaultTag || null),
    content,
    comment: asString(entry.comment)?.trim().slice(0, 10_000) || null,
    keys: JSON.stringify(keys),
    keysSecondary: JSON.stringify(keysSecondary),
    selectiveLogic: SELECTIVE_LOGIC_MAP[integer("selectiveLogic", entry.selectiveLogic, 0, 0, 3)]!,
    scanDepth: integer("scanDepth", entry.scanDepth ?? ctx.defaultScanDepth, 4, 0, 100),
    position: POSITION_MAP[integer("position", entry.position, 0, 0, 5)]!,
    insertionOrder: integer("order", entry.order ?? entry.displayIndex, 100, 0, 10_000),
    // `useProbability: false`: SillyTavern ignores the probability and the
    // entry always fires; this engine rolls any probability below 100.
    probability: useProbability === false ? 100 : integer("probability", entry.probability, 100, 0, 100),
    isConstant: boolean("constant", entry.constant) ? 1 : 0,
    isEnabled: boolean("disable", entry.disable) ? 0 : 1,
    sticky: integer("sticky", entry.sticky, 0, 0, 1000),
    cooldown: integer("cooldown", entry.cooldown, 0, 0, 1000),
    delay: integer("delay", entry.delay, 0, 0, 1000),
    excludeRecursion: boolean("excludeRecursion", entry.excludeRecursion) ? 1 : 0,
    preventRecursion: boolean("preventRecursion", entry.preventRecursion) ? 1 : 0,
    delayUntilRecursion: (typeof entry.delayUntilRecursion === "number" ? integer("delayUntilRecursion", entry.delayUntilRecursion, 0, 0, 1000) > 0 : boolean("delayUntilRecursion", entry.delayUntilRecursion)) ? 1 : 0,
    tokensEstimate: estimateTokens(content),
    // The one knownBy rule: trimmed, distinct, bounded; an empty list is null.
    knownBy: (() => { const normalized = normalizeKnownBy(entry.knownBy).knownBy; return normalized ? JSON.stringify(normalized) : null; })(),
    matchOptionsJson: Object.keys(matchOptions).length > 0 ? JSON.stringify(matchOptions) : null,
    legacySource: ctx.legacySource,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Dedupe key shared with the card importer: normalized name + content prefix. */
export function duplicateKey(name: string, content: string): string {
  return `${norm(name)}\0${norm(content).slice(0, 120)}`;
}

export function importSillyTavernLorebook(
  repo: LorebookRepository,
  userId: string,
  campaignId: string,
  json: unknown,
): ImportOutcome {
  const { entries: stEntries, errors, defaultScanDepth } = parseSillyTavernLorebook(json);
  if (stEntries.length === 0) return { imported: 0, skipped: 0, errors, createdIds: [] };
  const now = new Date().toISOString();
  const ctx: RowMapContext = { userId, campaignId, now, legacySource: `st-import-${now}`, defaultScanDepth, errors };
  const rows: Parameters<LorebookRepository["createMany"]>[0] = [];
  let skipped = 0;

  // Importing the same file twice used to create a full second copy of every
  // entry with no way to bulk-remove the batch. Skip an entry when
  // an EXISTING entry (enabled or cold) has the same name + content prefix —
  // the card importer's rule.
  repo.transact(() => {
    const existing = new Map<string, { id: string; name: string; content: string }>(repo.listAllForCampaign(userId, campaignId).map(e => [duplicateKey(e.name, e.content), e]));
    const importedIds = new Map<string, string>();
    const links: Array<{ row: typeof rows[number]; refs: string[]; existing?: boolean }> = [];
    for (const entry of stEntries) {
      const row = mapStEntryToRow(entry, ctx);
      if (!row) { skipped++; continue; }
      const match = existing.get(duplicateKey(row.name, row.content));
      // Native archives must not remap onto a similarly-prefixed but different
      // entry. The historical ST/card prefix heuristic remains for those formats.
      if (match && (entry.exportId === undefined || match.content === row.content)) {
        if (typeof entry.exportId === "string") importedIds.set(entry.exportId, match.id);
        if (Array.isArray(entry.compressedRefIds)) links.push({ row: { ...row, id: match.id }, refs: asStringArray(entry.compressedRefIds), existing: true });
        skipped++; continue;
      }
      rows.push(row);
      existing.set(duplicateKey(row.name, row.content), row);
      if (typeof entry.exportId === "string") {
        if (importedIds.has(entry.exportId)) ctx.errors.push(`duplicate native exportId "${entry.exportId}"`);
        else importedIds.set(entry.exportId, row.id);
      }
      if (Array.isArray(entry.compressedRefIds)) links.push({ row, refs: asStringArray(entry.compressedRefIds) });
    }
    for (const { row, refs, existing: existingRow } of links) {
      const resolved = refs.flatMap(ref => {
        const id = importedIds.get(ref);
        if (!id || id === row.id) { ctx.errors.push(`entry "${row.name}" has unresolved compressed reference "${ref}"`); return []; }
        return [id];
      });
      row.compressedRefIds = resolved.length ? JSON.stringify([...new Set(resolved)]) : null;
      if (existingRow && resolved.length === refs.length) {
        const current = repo.findById(userId, row.id);
        if (current && current.compressedRefIds !== row.compressedRefIds) repo.update(userId, row.id, { compressedRefIds: row.compressedRefIds });
      }
    }
    repo.createMany(rows);
  });
  return { imported: rows.length, skipped, errors, createdIds: rows.map((r) => r.id) };
}

function deriveName(entry: STEntry, keys: string[]): string {
  if (typeof entry.name === "string" && entry.name.trim()) return entry.name.trim();
  if (typeof entry.comment === "string" && entry.comment.trim()) return entry.comment.trim();
  if (keys.length > 0) return keys.slice(0, 3).join(", ");
  return "Unnamed Entry";
}

/** An entry name cut to LOREBOOK_NAME_MAX_CHARS; a cut is reported in `errors`. */
export function capEntryName(name: string, errors: string[]): string {
  if (name.length <= LOREBOOK_NAME_MAX_CHARS) return name;
  const cut = name.slice(0, LOREBOOK_NAME_MAX_CHARS).trimEnd();
  errors.push(`entry name cut from ${name.length} to ${cut.length} characters (the editor's limit is ${LOREBOOK_NAME_MAX_CHARS}): "${cut.slice(0, 60)}…"`);
  return cut;
}
