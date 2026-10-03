import { z } from "zod";

export const promptTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PromptTemplate = z.infer<typeof promptTemplateSchema>;

export const promptTemplateListResponseSchema = z.object({
  templates: z.array(promptTemplateSchema),
});

export type PromptTemplateListResponse = z.infer<typeof promptTemplateListResponseSchema>;

export const createPromptTemplateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(200_000),
});

export type CreatePromptTemplateRequest = z.infer<typeof createPromptTemplateRequestSchema>;

export const updatePromptTemplateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(200_000),
});

export type UpdatePromptTemplateRequest = z.infer<typeof updatePromptTemplateRequestSchema>;
