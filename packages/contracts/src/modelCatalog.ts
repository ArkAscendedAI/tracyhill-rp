import { z } from "zod";

// GET /api/models: the model catalog this server runs, for a
// client that ships its own compiled copy (Android merges a served entry over the compiled one
// with the same id, adds ids it does not know, ignores fields it does not read, and falls back to
// its compiled copy when the request fails). Each array is the matching model-catalog export
// (CHAT_MODELS, IMAGE_MODELS, EMBEDDING_MODELS) serialized as is: every data field, unchanged names
// and values. Custom endpoints are not part of it; they come from GET /api/provider-keys.
//
// The field lists mirror model-catalog's ChatModel / ImageModel / EmbeddingModel (contracts
// cannot import the catalog). The response schemas pass unknown fields through, so a field the
// catalog gains still reaches clients; the API's route test parses every served entry with the
// strict form of these lists, so a catalog field this file does not name fails there first.

const effortLevelSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const rate = z.number().nonnegative().optional();

export const servedChatModelFields = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  ctx: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive(),
  inputCostPerMillionTokens: rate,
  outputCostPerMillionTokens: rate,
  cacheReadCostPerMillionTokens: rate,
  cacheWrite5mCostPerMillionTokens: rate,
  cacheWrite1hCostPerMillionTokens: rate,
  supportsCacheTtl: z.boolean().optional(),
  supportsThinkingBudget: z.boolean().optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsToggleThinking: z.boolean().optional(),
  thinkingAlwaysOn: z.boolean().optional(),
  thinkingDefaultOn: z.boolean().optional(),
  thinkingOffMaxEffort: effortLevelSchema.optional(),
  // The thinking type that turns thinking off on a thinkingDefaultOn model (Claude Sonnet 5.5:
  // "between_tools"; "disabled" when absent). Added 2026-10-01; a plain string so an older
  // client reading a newer value never fails the decode.
  thinkingOffType: z.string().optional(),
  apiDefaultEffort: effortLevelSchema.optional(),
  supportsEffort: z.boolean().optional(),
  effortOptions: z.array(effortLevelSchema).optional(),
  defaultEffort: effortLevelSchema.optional(),
  supportsTemperature: z.boolean().optional(),
  temperatureWhileThinking: z.boolean().optional(),
  maxThinkingBudget: z.number().int().positive().optional(),
  fastModeInputCostPerMillionTokens: rate,
  fastModeOutputCostPerMillionTokens: rate,
  fastServiceTier: z.string().optional(),
  longContextThresholdTokens: z.number().int().positive().optional(),
  longContextInputCostPerMillionTokens: rate,
  longContextOutputCostPerMillionTokens: rate,
  longContextCacheReadCostPerMillionTokens: rate,
});

export const servedImageModelFields = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  // The request settings the server's image runtime sends for the model (added 2026-10-01,
  // GPT Image 2.5, Grok Imagine 2.0, Gemini 3 Pro Image). Informational for clients.
  quality: z.string().optional(),
  imageSize: z.string().optional(),
  aspectRatio: z.string().optional(),
});

export const servedEmbeddingModelFields = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  dimensions: z.number().int().positive(),
  inputCostPerMillionTokens: rate,
  documentPrefix: z.string().optional(),
  queryPrefix: z.string().optional(),
  recommendedThreshold: z.number().min(0).max(1).optional(),
  local: z.boolean().optional(),
});

export const modelCatalogResponseSchema = z.object({
  chatModels: z.array(servedChatModelFields.passthrough()),
  imageModels: z.array(servedImageModelFields.passthrough()),
  embeddingModels: z.array(servedEmbeddingModelFields.passthrough()),
});
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;
