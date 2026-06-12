import { z } from "zod";

export const pipelineRunStatusSchema = z.enum(["queued", "running", "completed", "failed", "canceled"]);
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;

export const pipelineStepStatusSchema = z.enum(["pending", "running", "completed", "failed"]);
export type PipelineStepStatus = z.infer<typeof pipelineStepStatusSchema>;

export const pipelineRetryModeSchema = z.enum(["full", "fromLorebookRefresh", "fromSysprompt"]);
export type PipelineRetryMode = z.infer<typeof pipelineRetryModeSchema>;

export const pipelineRunStepSchema = z.object({
  status: pipelineStepStatusSchema,
  result: z.string().nullable(),
  error: z.string().nullable(),
});

export type PipelineRunStep = z.infer<typeof pipelineRunStepSchema>;

export const pipelineRunReviewSchema = z.object({
  analysisReport: z.string().nullable().optional(),
  lorebookOperations: z.string().nullable().optional(),
  syspromptNoChanges: z.boolean().nullable().optional(),
  systemPromptDraft: z.string().nullable(),
  antiRepetitionRules: z.string().nullable().optional(),
  watermarkBefore: z.number().int().nullable().optional(),
  watermarkAfter: z.number().int().nullable().optional(),
  retriedFromRunId: z.string().nullable(),
  retriedFromStep: pipelineRetryModeSchema.nullable(),
  approvedSessionId: z.string().nullable(),
});

export type PipelineRunReview = z.infer<typeof pipelineRunReviewSchema>;

export const pipelineRunStepsSchema = z.object({
  analysis: pipelineRunStepSchema.optional(),
  lorebookRefresh: pipelineRunStepSchema.optional(),
  syspromptUpdate: pipelineRunStepSchema.optional(),
  repetitionDetection: pipelineRunStepSchema.optional(),
});

export type PipelineRunSteps = z.infer<typeof pipelineRunStepsSchema>;

export const pipelineRunModelsSchema = z.object({
  creativeModelId: z.string(),
}).optional();

export type PipelineRunModels = z.infer<typeof pipelineRunModelsSchema>;

export const pipelineRunSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  status: pipelineRunStatusSchema,
  summary: z.string().nullable(),
  error: z.string().nullable(),
  models: pipelineRunModelsSchema,
  steps: pipelineRunStepsSchema,
  review: pipelineRunReviewSchema,
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export const pipelineRunsResponseSchema = z.object({
  campaignId: z.string(),
  runs: z.array(pipelineRunSchema),
});

export type PipelineRunsResponse = z.infer<typeof pipelineRunsResponseSchema>;

export const activePipelineRunSchema = z.object({
  campaignId: z.string(),
  campaignName: z.string(),
  run: pipelineRunSchema,
});

export type ActivePipelineRun = z.infer<typeof activePipelineRunSchema>;

export const activePipelineRunsResponseSchema = z.object({
  runs: z.array(activePipelineRunSchema),
});

export type ActivePipelineRunsResponse = z.infer<typeof activePipelineRunsResponseSchema>;

export const approvePipelineRunRequestSchema = z.object({
  startSession: z.boolean().optional(),
});

export type ApprovePipelineRunRequest = z.infer<typeof approvePipelineRunRequestSchema>;

export const approvePipelineRunResponseSchema = pipelineRunsResponseSchema;
export type ApprovePipelineRunResponse = z.infer<typeof approvePipelineRunResponseSchema>;

export const enqueuePipelineRunRequestSchema = z.object({
  creativeModelId: z.string().optional(),
}).optional();

export type EnqueuePipelineRunRequest = z.infer<typeof enqueuePipelineRunRequestSchema>;

export const retryPipelineRunRequestSchema = z.object({
  fromStep: z.union([z.literal("fromLorebookRefresh"), z.literal("fromSysprompt")]).optional(),
});

export type RetryPipelineRunRequest = z.infer<typeof retryPipelineRunRequestSchema>;

export const retryPipelineRunResponseSchema = pipelineRunsResponseSchema;
export type RetryPipelineRunResponse = z.infer<typeof retryPipelineRunResponseSchema>;

export const cancelPipelineRunResponseSchema = pipelineRunsResponseSchema;
export type CancelPipelineRunResponse = z.infer<typeof cancelPipelineRunResponseSchema>;

export const abandonPipelineRunResponseSchema = pipelineRunsResponseSchema;
export type AbandonPipelineRunResponse = z.infer<typeof abandonPipelineRunResponseSchema>;

export const pipelineQueueJobSchema = z.object({
  runId: z.string(),
  kind: z.string(),
  status: z.enum(["queued", "running"]),
  priority: z.number().int(),
  startedAt: z.string().nullable(),
  elapsedMs: z.number().int().nullable(),
});
export type PipelineQueueJob = z.infer<typeof pipelineQueueJobSchema>;

export const pipelineQueueStatusResponseSchema = z.object({
  campaignId: z.string(),
  jobs: z.array(pipelineQueueJobSchema),
});
export type PipelineQueueStatusResponse = z.infer<typeof pipelineQueueStatusResponseSchema>;

export const pipelineArtifactKindSchema = z.enum(["prompt", "response", "thinking", "edits", "rendered", "registry"]);
export type PipelineArtifactKind = z.infer<typeof pipelineArtifactKindSchema>;

export const pipelineRunArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stage: z.string(),
  kind: pipelineArtifactKindSchema,
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type PipelineRunArtifact = z.infer<typeof pipelineRunArtifactSchema>;

export const pipelineRunArtifactsResponseSchema = z.object({
  runId: z.string(),
  artifacts: z.array(pipelineRunArtifactSchema),
});
export type PipelineRunArtifactsResponse = z.infer<typeof pipelineRunArtifactsResponseSchema>;
