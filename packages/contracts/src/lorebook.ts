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
  hasEmbedding: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LorebookEntry = z.infer<typeof lorebookEntrySchema>;

export const createLorebookEntryRequestSchema = z.object({
  campaignId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(500),
  tag: z.string().trim().max(100).nullable().optional(),
  content: z.string().trim().min(1).max(100000),
  comment: z.string().trim().max(10000).nullable().optional(),
  keys: z.array(z.string().trim().max(500)).max(100).default([]),
  keysSecondary: z.array(z.string().trim().max(500)).max(100).default([]),
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
  knownBy: z.array(z.string()).nullable().optional(),
  matchOptions: matchOptionsSchema.optional(),
});
export type CreateLorebookEntryRequest = z.infer<typeof createLorebookEntryRequestSchema>;

export const updateLorebookEntryRequestSchema = createLorebookEntryRequestSchema.partial().omit({ campaignId: true });
export type UpdateLorebookEntryRequest = z.infer<typeof updateLorebookEntryRequestSchema>;

export const lorebookBulkActionSchema = z.object({
  entryIds: z.array(z.string()).min(1).max(1000),
  action: z.enum(["enable", "disable", "delete", "retag"]),
  tag: z.string().trim().max(100).optional(),
});
export type LorebookBulkAction = z.infer<typeof lorebookBulkActionSchema>;

export const lorebookListQuerySchema = z.object({
  campaignId: z.string().optional(),
  tag: z.string().optional(),
  search: z.string().optional(),
  isEnabled: z.enum(["true", "false"]).optional(),
  isConstant: z.enum(["true", "false"]).optional(),
  hasEmbedding: z.enum(["true", "false"]).optional(),
  sort: z.enum(["updated_at", "name", "tag", "insertion_order", "scan_depth"]).default("updated_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type LorebookListQuery = z.infer<typeof lorebookListQuerySchema>;

export const lorebookListResponseSchema = z.object({
  entries: z.array(lorebookEntrySchema),
  total: z.number().int(),
});
export type LorebookListResponse = z.infer<typeof lorebookListResponseSchema>;

export const lorebookImportResultSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.string()),
});
export type LorebookImportResult = z.infer<typeof lorebookImportResultSchema>;

export const lorebookEmbeddingStatusSchema = z.object({
  totalEntries: z.number().int(),
  indexed: z.number().int(),
  stale: z.number().int(),
  missing: z.number().int(),
  model: z.string(),
});
export type LorebookEmbeddingStatus = z.infer<typeof lorebookEmbeddingStatusSchema>;
