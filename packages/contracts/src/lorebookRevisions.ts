import { z } from "zod";

// Source of a lorebook revision capture. Lenient on the wire (forward-compat
// with future worker kinds); this enum is the ONE canonical set — the API's
// LorebookRevisionRepository types its write context from it. (Imports create
// rows through createMany, which captures nothing, so there is no "import"
// source.)
export const lorebookRevisionSourceSchema = z.enum([
  "manual",
  "rolling_diff",
  "consolidation",
  "archival",
  "thread_tracker",
  "world_tick",
  "campaign_audit",
  "campaign_audit_ruling",
]);
export type LorebookRevisionSource = z.infer<typeof lorebookRevisionSourceSchema>;

export const lorebookRevisionSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  userId: z.string(),
  campaignId: z.string().nullable(),
  revisionNo: z.number().int(),
  name: z.string(),
  tag: z.string().nullable(),
  content: z.string(),
  comment: z.string().nullable(),
  keys: z.array(z.string()),
  keysSecondary: z.array(z.string()),
  knownBy: z.array(z.string()).nullable(),
  isEnabled: z.boolean(),
  isConstant: z.boolean(),
  sticky: z.number().int(),
  compressedRefIds: z.array(z.string()).nullable(),
  sealed: z.boolean().default(false),
  // 0084 (2026-09-02): the remaining entry dials, so revert is a full restore.
  // Null on revisions captured before the widening (the API leaves the entry's
  // current value for those); optional so older clients' fixtures stay valid.
  selectiveLogic: z.string().nullable().optional(),
  scanDepth: z.number().int().nullable().optional(),
  position: z.string().nullable().optional(),
  insertionOrder: z.number().int().nullable().optional(),
  probability: z.number().int().nullable().optional(),
  cooldown: z.number().int().nullable().optional(),
  delay: z.number().int().nullable().optional(),
  excludeRecursion: z.boolean().nullable().optional(),
  preventRecursion: z.boolean().nullable().optional(),
  delayUntilRecursion: z.boolean().nullable().optional(),
  matchOptions: z.object({ caseSensitive: z.boolean().nullable().optional(), matchWholeWords: z.boolean().nullable().optional() }).nullable().optional(),
  // Lenient string (not the enum) so an unknown future source still renders.
  source: z.string(),
  pipelineRunId: z.string().nullable(),
  createdAt: z.string(),
});
export type LorebookRevision = z.infer<typeof lorebookRevisionSchema>;

export const lorebookRevisionListResponseSchema = z.object({
  revisions: z.array(lorebookRevisionSchema),
});
export type LorebookRevisionListResponse = z.infer<typeof lorebookRevisionListResponseSchema>;

export const lorebookRevertRequestSchema = z.object({
  revisionId: z.string().min(1),
});

// The revert response is deliberately NOT the restored entry — the client
// refetches the entry + its history after a revert.
export const lorebookRevertResponseSchema = z.object({
  ok: z.literal(true),
  // The revision row capturing the pre-revert state (revert is itself undoable).
  // Null when the revert RECREATED a deleted entry (nothing to capture).
  capturedRevisionId: z.string().nullable(),
});
export type LorebookRevertResponse = z.infer<typeof lorebookRevertResponseSchema>;

// ── Recently deleted entries (2026-09-29, additive) ──────────────────────────
// A deleted entry's pre-delete snapshot survives the row (0064 has no cascade),
// and POST /entries/:entryId/revert { revisionId } recreates the entry from it,
// but nothing listed which entries could be brought back. GET
// /api/lorebook/campaigns/:campaignId/deleted lists them, newest deletion first,
// each with the revision that revert restores.
export const lorebookDeletedListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const lorebookDeletedEntrySchema = z.object({
  entryId: z.string(),
  /** The newest revision: the snapshot taken just before the delete. Revert restores it. */
  revisionId: z.string(),
  revisionNo: z.number().int(),
  name: z.string(),
  tag: z.string().nullable(),
  /** The first 200 characters of the deleted text. */
  contentPreview: z.string(),
  contentChars: z.number().int().min(0),
  wasEnabled: z.boolean(),
  /** When the snapshot was taken, i.e. when the entry was deleted. */
  deletedAt: z.string(),
  /** Who deleted it: "manual" (an editor) or a worker kind. */
  source: z.string(),
  pipelineRunId: z.string().nullable(),
});
export type LorebookDeletedEntry = z.infer<typeof lorebookDeletedEntrySchema>;

export const lorebookDeletedListResponseSchema = z.object({
  entries: z.array(lorebookDeletedEntrySchema),
});
export type LorebookDeletedListResponse = z.infer<typeof lorebookDeletedListResponseSchema>;
