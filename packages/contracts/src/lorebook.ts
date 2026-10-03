import { z } from "zod";

export const selectiveLogicSchema = z.enum(["and_any", "and_all", "not_all", "not_any"]);
export type SelectiveLogic = z.infer<typeof selectiveLogicSchema>;

export const lorebookPositionSchema = z.enum(["before_main", "after_main", "top", "bottom"]);
export type LorebookPosition = z.infer<typeof lorebookPositionSchema>;

export const matchOptionsSchema = z.object({
  caseSensitive: z.boolean().optional(),
  matchWholeWords: z.boolean().optional(),
}).nullable();
export type MatchOptions = z.infer<typeof matchOptionsSchema>;

export const lorebookEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  campaignId: z.string().nullable(),
  name: z.string(),
  tag: z.string().nullable(),
  content: z.string(),
  comment: z.string().nullable(),
  keys: z.array(z.string()),
  keysSecondary: z.array(z.string()),
  selectiveLogic: selectiveLogicSchema,
  scanDepth: z.number().int().min(0),
  // position is persisted, imported and exported for the SillyTavern round trip,
  // but context assembly does not consult it. The web editor hides the field since
  // 2026-09-29 and Android 1.1.8 hides it too; a save carries the
  // stored value back unchanged.
  position: lorebookPositionSchema,
  insertionOrder: z.number().int(),
  probability: z.number().int().min(0).max(100),
  isConstant: z.boolean(),
  isEnabled: z.boolean(),
  sticky: z.number().int().min(0),
  cooldown: z.number().int().min(0),
  delay: z.number().int().min(0),
  excludeRecursion: z.boolean(),
  preventRecursion: z.boolean(),
  delayUntilRecursion: z.boolean(),
  tokensEstimate: z.number().int().min(0),
  knownBy: z.array(z.string()).nullable(),
  matchOptions: matchOptionsSchema,
  legacySource: z.string().nullable(),
  compressedRefIds: z.array(z.string()).nullable().optional(),
  sealed: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LorebookEntry = z.infer<typeof lorebookEntrySchema>;

/** Hard cap on an entry's primary/secondary key list — ONE number for the
 *  create/update contracts, the bulk `append_keys` merge and the importer.
 *  The bulk merge had no cap: an entry could grow
 *  past what the update contract accepts and then reject every full-payload
 *  save from the editor, prose-only edits included. */
export const LOREBOOK_MAX_KEYS = 100;

/** The thread tracker's constant index entry is identified by this exact name,
 *  the `threads` tag and is_constant. The tracker
 *  writes it; the drive worker, the world tick and the curation tools read it
 *  through `LorebookRepository.findThreadIndex`; the web Threads chip and
 *  Android match the same name. One definition here so the API, the workers
 *  and the web cannot drift (the name was hard-coded in five places). */
export const THREAD_INDEX_ENTRY_NAME = "Campaign Thread Tracker";
/** The tracker-owned tag: the index and every per-thread entry of its ledger. */
export const THREADS_TAG = "threads";
/** The tag the archival worker gives a compressed trigger. */
export const ARCHIVED_TAG = "archived";
/** Longest entry name: one number for the create/update contract and both
 *  importers (the World Info importer cut names at 200 and the card importer
 *  not at all). */
export const LOREBOOK_NAME_MAX_CHARS = 500;
/** Longest tag the create/update contract accepts (after trimming). */
export const LOREBOOK_TAG_MAX_CHARS = 100;
/** Longest single key the create/update contract accepts (after trimming). */
export const LOREBOOK_KEY_MAX_CHARS = 500;
/** `knownBy` bounds: names are trimmed and non-empty, at most
 *  this long, and a list holds at most this many (production maximum on
 *  2026-09-29: 20 names, 106 characters). */
export const LOREBOOK_KNOWN_BY_MAX_NAMES = 100;
export const LOREBOOK_KNOWN_BY_NAME_MAX_CHARS = 200;
/** Longest comment an editor may write: on create, and as a CHANGED comment on
 *  update (the service enforces the update half). */
export const LOREBOOK_COMMENT_MAX_CHARS = 10_000;
/** The update contract's sanity bound on `comment`. Both
 *  clients send the whole entry back on save, comment included, and the thread
 *  tracker keeps its ledger as JSON in the Thread Index's comment (181,927
 *  characters on the largest campaign, 2026-09-28), so the 10,000 bound made
 *  every save of the index fail validation. A save may carry a longer stored
 *  comment back unchanged; changing it past LOREBOOK_COMMENT_MAX_CHARS is refused
 *  by the service with a 400 that says so. */
export const LOREBOOK_COMMENT_SANITY_MAX_CHARS = 500_000;

/** Characters per estimator token. The lorebook's one token estimate
 *  (`tokens_estimate`, the budget pruner, the size watchdog, the editor's
 *  token readout) is chars/3.5 rounded up. It was written three times (the
 *  API's estimator module, the repository's watchdog and the web panel) and is
 *  defined once here so the API, the workers and the web share it. */
export const LOREBOOK_CHARS_PER_TOKEN = 3.5;

/** The lorebook token estimate: ceil(chars / LOREBOOK_CHARS_PER_TOKEN). */
export function estimateLorebookTokens(text: string): number {
  return Math.ceil(text.length / LOREBOOK_CHARS_PER_TOKEN);
}

// The campaign comes from the route path (/campaigns/:campaignId/entries); a
// body `campaignId` was accepted but never read; unknown keys are
// stripped, so older clients that still send it are unaffected.
export const createLorebookEntryRequestSchema = z.object({
  name: z.string().trim().min(1).max(LOREBOOK_NAME_MAX_CHARS),
  tag: z.string().trim().max(LOREBOOK_TAG_MAX_CHARS).nullable().optional(),
  content: z.string().trim().min(1).max(100000),
  comment: z.string().trim().max(LOREBOOK_COMMENT_MAX_CHARS).nullable().optional(),
  // A blank key matches almost any text, so none is accepted;
  // both clients already drop blank keys before sending.
  keys: z.array(z.string().trim().min(1).max(LOREBOOK_KEY_MAX_CHARS)).max(LOREBOOK_MAX_KEYS).default([]),
  keysSecondary: z.array(z.string().trim().min(1).max(LOREBOOK_KEY_MAX_CHARS)).max(LOREBOOK_MAX_KEYS).default([]),
  selectiveLogic: selectiveLogicSchema.default("and_any"),
  scanDepth: z.number().int().min(0).max(100).default(4),
  position: lorebookPositionSchema.default("before_main"),
  insertionOrder: z.number().int().min(0).max(10000).default(100),
  probability: z.number().int().min(0).max(100).default(100),
  isConstant: z.boolean().default(false),
  isEnabled: z.boolean().default(true),
  sticky: z.number().int().min(0).max(1000).default(0),
  cooldown: z.number().int().min(0).max(1000).default(0),
  delay: z.number().int().min(0).max(1000).default(0),
  excludeRecursion: z.boolean().default(false),
  preventRecursion: z.boolean().default(false),
  delayUntilRecursion: z.boolean().default(false),
  knownBy: z.array(z.string().trim().min(1).max(LOREBOOK_KNOWN_BY_NAME_MAX_CHARS)).max(LOREBOOK_KNOWN_BY_MAX_NAMES).nullable().optional(),
  matchOptions: matchOptionsSchema.optional(),
});
export type CreateLorebookEntryRequest = z.infer<typeof createLorebookEntryRequestSchema>;

export const updateLorebookEntryRequestSchema = createLorebookEntryRequestSchema.partial().extend({
  comment: z.string().trim().max(LOREBOOK_COMMENT_SANITY_MAX_CHARS).nullable().optional(),
});
export type UpdateLorebookEntryRequest = z.infer<typeof updateLorebookEntryRequestSchema>;

export const lorebookBulkActionSchema = z.object({
  entryIds: z.array(z.string()).min(1).max(1000),
  action: z.enum(["enable", "disable", "delete", "retag", "append_keys", "set_sticky"]),
  tag: z.string().trim().max(100).optional(),
  // append_keys: added to each selected entry's key list, case-insensitively
  // deduped; an entry's list never grows past LOREBOOK_MAX_KEYS (the rest is
  // reported in the reply's `warnings`).
  keys: z.array(z.string().trim().min(1).max(500)).max(LOREBOOK_MAX_KEYS).optional(),
  // set_sticky: absolute sticky value applied to every selected entry.
  sticky: z.number().int().min(0).max(1000).optional(),
});
export type LorebookBulkAction = z.infer<typeof lorebookBulkActionSchema>;

/** Reply of POST /campaigns/:campaignId/bulk. `warnings` (additive, 2026-09-23)
 *  names what the verb could NOT do — today: keys `append_keys` left off because
 *  an entry's list would pass LOREBOOK_MAX_KEYS. Older clients read `ok` only. */
export const lorebookBulkResultSchema = z.object({
  ok: z.literal(true),
  warnings: z.array(z.string()).default([]),
});
export type LorebookBulkResult = z.infer<typeof lorebookBulkResultSchema>;

export const lorebookListQuerySchema = z.object({
  tag: z.string().optional(),
  search: z.string().optional(),
  isEnabled: z.enum(["true", "false"]).optional(),
  isConstant: z.enum(["true", "false"]).optional(),
  // Living World Phase 2 — offscreen filter facet (comment-marker based).
  offscreen: z.enum(["true", "false"]).optional(),
  provisional: z.enum(["true", "false"]).optional(),
  sort: z.enum(["updated_at", "name", "tag", "insertion_order", "scan_depth"]).default("updated_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  // `view=summary` (additive, 2026-09-29) answers rows without their content
  // (lorebookSummaryListResponseSchema), so a list or a filter change does not
  // download every entry's full text; the full row comes from GET /entries/:id.
  // Absent or `full` keeps the full rows every existing client reads.
  view: z.enum(["full", "summary"]).default("full"),
});

export const lorebookListResponseSchema = z.object({
  entries: z.array(lorebookEntrySchema),
  total: z.number().int(),
});
export type LorebookListResponse = z.infer<typeof lorebookListResponseSchema>;

/** A list row without the entry's text (`view=summary`). `contentChars` is the
 *  stored content's length. `comment` is carried when it is at most
 *  LOREBOOK_COMMENT_MAX_CHARS long (every note and offscreen marker); a longer one
 *  (the thread tracker's ledger on the Thread Index) is null here and
 *  `commentChars` says how long it is. */
export const lorebookEntrySummarySchema = lorebookEntrySchema.omit({ content: true, comment: true }).extend({
  contentChars: z.number().int().min(0),
  comment: z.string().nullable(),
  commentChars: z.number().int().min(0),
});
export type LorebookEntrySummary = z.infer<typeof lorebookEntrySummarySchema>;

export const lorebookSummaryListResponseSchema = z.object({
  entries: z.array(lorebookEntrySummarySchema),
  total: z.number().int(),
});
export type LorebookSummaryListResponse = z.infer<typeof lorebookSummaryListResponseSchema>;

export const lorebookImportResultSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.string()),
});
export type LorebookImportResult = z.infer<typeof lorebookImportResultSchema>;

// SillyTavern character-card import (V1 flat / V2 / V3 JSON, or a card PNG).
// Body carries either a parsed `card` object or a base64 PNG to extract
// server-side. Additive + collision-safe. The PNG cap (~24 MB decoded) keeps a
// card upload well inside the /api/lorebook body limit instead of relying on it.
export const CHARACTER_CARD_PNG_BASE64_MAX_CHARS = 32 * 1024 * 1024;
export const characterCardImportRequestSchema = z.object({
  card: z.unknown().optional(),
  pngBase64: z.string().max(CHARACTER_CARD_PNG_BASE64_MAX_CHARS).optional(),
}).refine((v) => v.card !== undefined || (typeof v.pngBase64 === "string" && v.pngBase64.length > 0), {
  message: "card or pngBase64 required",
});

export const characterCardImportResultSchema = z.object({
  characterName: z.string().nullable(),
  createdCharacter: z.boolean(),
  skippedCharacter: z.boolean(),
  createdBookEntries: z.number().int(),
  skippedBookEntries: z.number().int(),
  warnings: z.array(z.string()),
});
export type CharacterCardImportResult = z.infer<typeof characterCardImportResultSchema>;

// ── Export ───────────────────────────────────────────────────────────────────
// "json" — round-trippable with the importer (ST envelope + native extras:
// name/knownBy survive re-import). "st" — strict SillyTavern World Info
// (comment carries the entry name, ST convention).
export const lorebookExportFormatSchema = z.enum(["json", "st"]);
export type LorebookExportFormat = z.infer<typeof lorebookExportFormatSchema>;

export const lorebookExportQuerySchema = z.object({
  format: lorebookExportFormatSchema.default("json"),
});

export const lorebookExportEntrySchema = z.object({
  uid: z.number().int(),
  key: z.array(z.string()),
  keysecondary: z.array(z.string()),
  comment: z.string(),
  content: z.string(),
  constant: z.boolean(),
  selective: z.boolean(),
  selectiveLogic: z.number().int(),
  order: z.number().int(),
  position: z.number().int(),
  disable: z.boolean(),
  excludeRecursion: z.boolean(),
  preventRecursion: z.boolean(),
  delayUntilRecursion: z.boolean(),
  probability: z.number().int(),
  useProbability: z.boolean(),
  scanDepth: z.number().int(),
  sticky: z.number().int(),
  cooldown: z.number().int(),
  delay: z.number().int(),
  group: z.string(),
  caseSensitive: z.boolean(),
  matchWholeWords: z.boolean(),
  addMemo: z.boolean(),
  displayIndex: z.number().int(),
  // Native extras — present in "json" format only. IDs are local to the export
  // and remapped on import so compressed triggers retain their cold children.
  exportId: z.string().optional(),
  compressedRefIds: z.array(z.string()).nullable().optional(),
  name: z.string().optional(),
  knownBy: z.array(z.string()).nullable().optional(),
});
export type LorebookExportEntry = z.infer<typeof lorebookExportEntrySchema>;

export const lorebookExportResponseSchema = z.object({
  entries: z.record(z.string(), lorebookExportEntrySchema),
});
export type LorebookExport = z.infer<typeof lorebookExportResponseSchema>;

export const lorebookEmbeddingStatusSchema = z.object({
  totalEntries: z.number().int(),
  indexed: z.number().int(),
  stale: z.number().int(),
  missing: z.number().int(),
  model: z.string(),
});
export type LorebookEmbeddingStatus = z.infer<typeof lorebookEmbeddingStatusSchema>;

/** Response of `/api/lorebook/campaigns/:id/tags`. */
export const lorebookTagsResponseSchema = z.object({ tags: z.array(z.string()) });
export type LorebookTagsResponse = z.infer<typeof lorebookTagsResponseSchema>;
