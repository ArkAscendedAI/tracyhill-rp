import { z } from "zod";

export const providerIdSchema = z.enum(["anthropic", "claude-code", "deepseek", "google", "openai", "xai", "xiaomi", "zai"]);

export type ProviderId = z.infer<typeof providerIdSchema>;

export const providerKeySourceSchema = z.enum(["none", "user", "server"]);

export type ProviderKeySource = z.infer<typeof providerKeySourceSchema>;

export const providerKeyStatusSchema = z.object({
  source: providerKeySourceSchema,
  configured: z.boolean(),
  keyPreview: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type ProviderKeyStatus = z.infer<typeof providerKeyStatusSchema>;

export const providerKeyStatusMapSchema = z.object({
  anthropic: providerKeyStatusSchema,
  "claude-code": providerKeyStatusSchema,
  deepseek: providerKeyStatusSchema,
  google: providerKeyStatusSchema,
  openai: providerKeyStatusSchema,
  xai: providerKeyStatusSchema,
  xiaomi: providerKeyStatusSchema,
  zai: providerKeyStatusSchema,
});

export type ProviderKeyStatusMap = z.infer<typeof providerKeyStatusMapSchema>;

export const providerKeyListResponseSchema = z.object({
  providers: providerKeyStatusMapSchema,
  customEndpoints: z.array(z.object({
    id: z.string(),
    name: z.string(),
    baseUrl: z.string(),
    apiFormat: z.enum(["chat-completions", "responses"]),
    authHeader: z.enum(["Bearer", "api-key", "none"]),
    models: z.array(z.object({
      id: z.string(),
      label: z.string(),
      maxOut: z.number().int().positive(),
      ctx: z.number().int().positive(),
    })),
    hasKey: z.boolean(),
    updatedAt: z.string().nullable().default(null),
  })).default([]),
});

export type ProviderKeyListResponse = z.infer<typeof providerKeyListResponseSchema>;

export const customEndpointModelSchema = z.object({
  id: z.string().trim().min(1).max(128),
  label: z.string().trim().max(128).optional().default(""),
  maxOut: z.number().int().positive().max(2_097_152).optional().default(4096),
  ctx: z.number().int().positive().max(10_000_000).optional().default(128000),
});

export type CustomEndpointModel = z.infer<typeof customEndpointModelSchema>;

export const customEndpointApiFormatSchema = z.enum(["chat-completions", "responses"]);

export type CustomEndpointApiFormat = z.infer<typeof customEndpointApiFormatSchema>;

export const customEndpointAuthHeaderSchema = z.enum(["Bearer", "api-key", "none"]);

export type CustomEndpointAuthHeader = z.infer<typeof customEndpointAuthHeaderSchema>;

export const customEndpointInputSchema = z.object({
  id: z.string().trim().regex(/^ep_[a-z0-9]{6,12}$/).optional(),
  name: z.string().trim().min(1).max(64),
  baseUrl: z.string().trim().min(1).max(512).refine((value) => {
    try {
      const url = new URL(value);
      // Require http/https only -- blocks file:, gopher:, ftp:, etc.
      if (url.protocol !== "https:" && url.protocol !== "http:") return false;
      // No userinfo (would mask credentials and confuse SSRF detection)
      if (url.username || url.password) return false;
      return true;
    } catch { return false; }
  }, { message: "baseUrl must be a valid http(s):// URL with no userinfo" }),
  apiKey: z.string().max(512).nullish(),
  apiFormat: customEndpointApiFormatSchema.default("chat-completions"),
  authHeader: customEndpointAuthHeaderSchema.default("Bearer"),
  models: z.array(customEndpointModelSchema).max(50).default([]),
});

export type CustomEndpointInput = z.infer<typeof customEndpointInputSchema>;

export const customEndpointSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  apiFormat: customEndpointApiFormatSchema,
  authHeader: customEndpointAuthHeaderSchema,
  models: z.array(customEndpointModelSchema),
  hasKey: z.boolean(),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable(),
});

export type CustomEndpointSummary = z.infer<typeof customEndpointSummarySchema>;

export const updateProviderKeysRequestSchema = z.object({
  anthropic: z.string().trim().min(1).nullable().optional(),
  "claude-code": z.string().trim().min(1).nullable().optional(),
  deepseek: z.string().trim().min(1).nullable().optional(),
  google: z.string().trim().min(1).nullable().optional(),
  openai: z.string().trim().min(1).nullable().optional(),
  xai: z.string().trim().min(1).nullable().optional(),
  xiaomi: z.string().trim().min(1).nullable().optional(),
  zai: z.string().trim().min(1).nullable().optional(),
  customEndpoints: z.array(customEndpointInputSchema).max(20).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "at least one provider key update is required",
});

export type UpdateProviderKeysRequest = z.infer<typeof updateProviderKeysRequestSchema>;

export type CustomChatModel = {
  id: string;
  label: string;
  provider: `custom:${string}`;
  providerLabel: string;
  ctx: number;
  maxOut: number;
  customEndpointId: string;
  actualModelId: string;
  apiFormat: CustomEndpointApiFormat;
};

export function buildCustomChatModelId(endpointId: string, modelId: string) {
  return `custom:${endpointId}:${modelId}`;
}

export function parseCustomChatModelId(value: string) {
  const match = /^custom:([^:]+):(.+)$/.exec(value.trim());
  if (!match) return null;
  return {
    endpointId: match[1]!,
    modelId: match[2]!,
  };
}

export function buildCustomChatModels(endpoints: Array<Pick<CustomEndpointSummary, "id" | "name" | "apiFormat" | "authHeader" | "hasKey" | "models">>) {
  const models: CustomChatModel[] = [];
  for (const endpoint of endpoints) {
    if (!endpoint.hasKey && endpoint.authHeader !== "none") continue;
    for (const model of endpoint.models) {
      models.push({
        id: buildCustomChatModelId(endpoint.id, model.id),
        label: model.label || model.id,
        provider: `custom:${endpoint.id}`,
        providerLabel: endpoint.name,
        ctx: model.ctx || 128000,
        maxOut: model.maxOut || 4096,
        customEndpointId: endpoint.id,
        actualModelId: model.id,
        apiFormat: endpoint.apiFormat,
      });
    }
  }
  return models;
}
