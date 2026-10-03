import { z } from "zod";

export const campaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  folderId: z.string().nullable(),
  systemPrompt: z.string(),
  version: z.number().int().min(0),
  // Settings are per-session (0077). This is the PC identity RESOLVED from the
  // campaign's newest live session — read-only, for campaign-wide surfaces like
  // the Drives panel. There is no campaign settings tier to write.
  playerCharacterKeys: z.array(z.string()),
  // Likewise resolved from the newest session — campaign-wide surfaces (embedding
  // status/rebuild) must target the vector namespace retrieval actually uses.
  embeddingModel: z.string().nullable(),
  // Anti-repetition STATE (campaigns.anti_repetition_json since 0077), surfaced
  // read-only. The Android client has a rules viewer — web has none — and moving
  // this out of the settings blob silently emptied it. Exposed from its new home
  // rather than dropping a working client feature.
  antiRepetitionRules: z.array(z.unknown()).default([]),
  archivedAntiRepetitionRules: z.array(z.unknown()).default([]),
  lorebookEntryCount: z.number().int().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Campaign = z.infer<typeof campaignSchema>;

export const campaignVersionSchema = z.object({
  // The archived row's id, null on the current row (additive, 2026-09-30): what the restore request's
  // `archiveId` names. Older servers send none; a client then restores by number.
  id: z.string().nullable().optional(),
  version: z.number().int().min(0),
  systemPrompt: z.string(),
  createdAt: z.string(),
  isCurrent: z.boolean(),
  label: z.string().nullable(),
});

export type CampaignVersion = z.infer<typeof campaignVersionSchema>;

export const campaignsListResponseSchema = z.object({
  campaigns: z.array(campaignSchema),
});

export type CampaignsListResponse = z.infer<typeof campaignsListResponseSchema>;

export const campaignVersionsResponseSchema = z.object({
  campaignId: z.string(),
  versions: z.array(campaignVersionSchema),
});

export type CampaignVersionsResponse = z.infer<typeof campaignVersionsResponseSchema>;

export const createCampaignRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  folderId: z.string().trim().min(1).max(160).nullable().optional(),
  systemPrompt: z.string().trim().max(200000).default(""),
  version: z.number().int().min(0).default(0),
});

export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;

export const updateCampaignRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  folderId: z.string().trim().min(1).max(160).nullable().optional(),
  systemPrompt: z.string().trim().max(200000).optional(),
  version: z.number().int().min(0).optional(),
});

export type UpdateCampaignRequest = z.infer<typeof updateCampaignRequestSchema>;

/** Body of POST /api/campaigns/:campaignId/versions/:version/restore (additive, 2026-09-30).
 *  `archiveId` (an `id` from the versions list) restores that exact history row: a Version edit can rewind the
 *  counter, so two archived rows can share a number and the current row can carry an archive's number. Without
 *  it (older clients post no body) the number picks the newest unlabeled archive and the current number is a
 *  no-op, as before. Labeled rows (pre-restore snapshots) are not restore targets either way. */
export const restoreCampaignVersionRequestSchema = z.object({
  archiveId: z.string().trim().min(1).max(200).optional(),
});

export type RestoreCampaignVersionRequest = z.infer<typeof restoreCampaignVersionRequestSchema>;
