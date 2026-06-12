import { z } from "zod";

import { contextSettingsUpdateSchema } from "./context";

export const campaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  folderId: z.string().nullable(),
  pipelineModelId: z.string(),
  systemPrompt: z.string(),
  version: z.number().int().min(0),
  contextDefaults: contextSettingsUpdateSchema.nullable(),
  lorebookEntryCount: z.number().int().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Campaign = z.infer<typeof campaignSchema>;

export const campaignVersionSchema = z.object({
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
  pipelineModelId: z.string().trim().min(1).max(160).default("claude-opus-4-7-bridge"),
  systemPrompt: z.string().trim().max(200000).default(""),
  version: z.number().int().min(0).default(0),
});

export type CreateCampaignRequest = z.infer<typeof createCampaignRequestSchema>;

export const updateCampaignRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  folderId: z.string().trim().min(1).max(160).nullable().optional(),
  pipelineModelId: z.string().trim().min(1).max(160).optional(),
  systemPrompt: z.string().trim().max(200000).optional(),
  version: z.number().int().min(0).optional(),
  contextDefaults: contextSettingsUpdateSchema.optional(),
});

export type UpdateCampaignRequest = z.infer<typeof updateCampaignRequestSchema>;
