import { z } from "zod";

export const contextModeSchema = z.enum(["off", "keyword", "semantic", "hybrid"]);
export type ContextMode = z.infer<typeof contextModeSchema>;

export const contextSettingsSchema = z.object({
  mode: contextModeSchema.default("keyword"),
  retrievalBudgetTokens: z.number().int().min(0).max(50000).default(4000),
  semanticTopK: z.number().int().min(1).max(50).default(20),
  semanticThreshold: z.number().min(0).max(1).default(0.25),
  scanDepth: z.number().int().min(0).max(100).default(4),
  contextBudgetTokens: z.number().int().min(0).max(2000000).default(200000),
  guaranteedMessageCount: z.number().int().min(2).max(200).default(20),
  embeddingModel: z.string().default("openai:text-embedding-3-large"),
  researcherEnabled: z.boolean().default(true),
  researcherModel: z.string().default("claude-sonnet-4-6-bridge"),
  researcherMaxPicks: z.number().int().min(1).max(50).default(16),
  hydeEnabled: z.boolean().default(true),
  hydeModel: z.string().optional(),
  rollingEnabled: z.boolean().default(true),
  rollingCadence: z.number().int().min(1).max(32).default(4),
  rollingModel: z.string().default("claude-haiku-4-5-bridge"),
  sceneValidatorEnabled: z.boolean().default(true),
  sceneValidatorModel: z.string().default("claude-haiku-4-5-bridge"),
  sceneValidatorAutoRegen: z.boolean().default(true),
  attireTrackingEnabled: z.boolean().default(true),
  attireStaleTurnThreshold: z.number().int().min(1).max(200).default(10),
  pipelineAutoEnabled: z.boolean().default(true),
  rollingDiffCharThreshold: z.number().int().min(1000).max(200000).default(17000),
  repetitionCharThreshold: z.number().int().min(5000).max(500000).default(50000),
  syspromptAuditCharThreshold: z.number().int().min(10000).max(1000000).default(100000),
  maxAntiRepetitionRules: z.number().int().min(10).max(300).default(80),
  antiRepArchiveAfter: z.number().int().min(2).max(20).default(5),
  previewEnabled: z.boolean().default(false),
  disabledEntryIds: z.array(z.string()).default([]),
  playerCharacterKeys: z.array(z.string()).default([]),
  coldInflationWeightMultiplier: z.number().min(0).max(2).default(0.6),
  // Anthropic fast mode (research preview). When true AND model supports fast mode
  // AND model is not a bridge variant, chatService passes speed:"fast" to the runtime.
  // Default OFF on every new session per project policy.
  fastModeEnabled: z.boolean().default(false),
});
export type ContextSettings = z.infer<typeof contextSettingsSchema>;

export const contextSettingsUpdateSchema = contextSettingsSchema.partial().omit({ disabledEntryIds: true });
export type ContextSettingsUpdate = z.infer<typeof contextSettingsUpdateSchema>;

export const contextPreviewEntrySchema = z.object({
  entryId: z.string(),
  name: z.string(),
  tag: z.string().nullable(),
  source: z.enum(["constant", "sticky", "keyword", "semantic", "researcher", "scene-present", "cold-inflate"]),
  score: z.number(),
  tokenCost: z.number().int(),
  included: z.boolean(),
});
export type ContextPreviewEntry = z.infer<typeof contextPreviewEntrySchema>;

export const contextAssemblyDebugSchema = z.object({
  keywordHits: z.number().int(),
  semanticHits: z.number().int(),
  researcherHits: z.number().int(),
  coldInflations: z.number().int(),
  droppedForBudget: z.number().int(),
  totalTokens: z.number().int(),
});
export type ContextAssemblyDebug = z.infer<typeof contextAssemblyDebugSchema>;

export const contextPreviewResponseSchema = z.object({
  entries: z.array(contextPreviewEntrySchema),
  totalTokens: z.number().int(),
  budgetTokens: z.number().int(),
  debug: contextAssemblyDebugSchema,
  notes: z.array(z.string()).default([]),
});
export type ContextPreviewResponse = z.infer<typeof contextPreviewResponseSchema>;

export const contextPreviewRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(50000),
});
export type ContextPreviewRequest = z.infer<typeof contextPreviewRequestSchema>;

export const characterAttireRecordSchema = z.object({
  campaignId: z.string(),
  characterName: z.string(),
  attireDescription: z.string(),
  lastUpdatedTurn: z.number().int(),
  lastUpdatedMessageId: z.string().nullable(),
  lastSeenInPresentTurn: z.number().int(),
  source: z.string(),
  updatedAt: z.string(),
});
export type CharacterAttireRecord = z.infer<typeof characterAttireRecordSchema>;

export const characterAttireListResponseSchema = z.object({
  entries: z.array(characterAttireRecordSchema),
});
export type CharacterAttireListResponse = z.infer<typeof characterAttireListResponseSchema>;

export const updateCharacterAttireRequestSchema = z.object({
  attireDescription: z.string().trim().min(1).max(2000),
  reason: z.string().trim().max(240).optional(),
});
export type UpdateCharacterAttireRequest = z.infer<typeof updateCharacterAttireRequestSchema>;

export const embeddingRebuildRequestSchema = z.object({
  campaignId: z.string(),
  model: z.string().default("openai:text-embedding-3-large"),
  staleOnly: z.boolean().default(false),
});
export type EmbeddingRebuildRequest = z.infer<typeof embeddingRebuildRequestSchema>;
