import { z } from "zod";

export const wizardRunStatusSchema = z.enum(["queued", "running", "completed", "failed", "canceled"]);
export type WizardRunStatus = z.infer<typeof wizardRunStatusSchema>;

export const wizardStepStatusSchema = z.enum(["pending", "running", "completed", "failed"]);
export type WizardStepStatus = z.infer<typeof wizardStepStatusSchema>;

export const wizardTemplatesSchema = z.object({
  exampleSystemPrompt: z.string(),
  updatedAt: z.string(),
});

export type WizardTemplates = z.infer<typeof wizardTemplatesSchema>;

export const wizardTemplatesResponseSchema = z.object({
  templates: wizardTemplatesSchema,
});

export type WizardTemplatesResponse = z.infer<typeof wizardTemplatesResponseSchema>;

export const updateWizardTemplatesRequestSchema = z.object({
  exampleSystemPrompt: z.string().trim().max(200000).default(""),
});

export type UpdateWizardTemplatesRequest = z.infer<typeof updateWizardTemplatesRequestSchema>;

export const wizardRunStepSchema = z.object({
  status: wizardStepStatusSchema,
  result: z.string().nullable(),
  error: z.string().nullable(),
});

export type WizardRunStep = z.infer<typeof wizardRunStepSchema>;

export const lorebookCorpusEntrySchema = z.object({
  name: z.string(),
  tag: z.string().nullable(),
  content: z.string(),
  keys: z.array(z.string()),
  keysSecondary: z.array(z.string()).optional(),
  isConstant: z.boolean(),
  position: z.string().optional(),
  insertionOrder: z.number().optional(),
  scanDepth: z.number().optional(),
});

export type LorebookCorpusEntry = z.infer<typeof lorebookCorpusEntrySchema>;

export const wizardRunReviewSchema = z.object({
  campaignName: z.string(),
  brief: z.string(),
  wizardTranscript: z.string(),
  wizardSessionId: z.string().nullable(),
  systemPromptDraft: z.string().nullable(),
  lorebookCorpusDraft: z.array(lorebookCorpusEntrySchema).nullable(),
  approvedCampaignId: z.string().nullable(),
  approvedSessionId: z.string().nullable(),
  retriedFromRunId: z.string().nullable(),
});

export type WizardRunReview = z.infer<typeof wizardRunReviewSchema>;

export const wizardRunSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  status: wizardRunStatusSchema,
  summary: z.string().nullable(),
  error: z.string().nullable(),
  steps: z.object({
    systemPrompt: wizardRunStepSchema,
    lorebookCorpus: wizardRunStepSchema,
  }),
  review: wizardRunReviewSchema,
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export type WizardRun = z.infer<typeof wizardRunSchema>;

export const wizardRunsResponseSchema = z.object({
  runs: z.array(wizardRunSchema),
});

export type WizardRunsResponse = z.infer<typeof wizardRunsResponseSchema>;

export const activeWizardRunsResponseSchema = z.object({
  runs: z.array(wizardRunSchema),
});

export type ActiveWizardRunsResponse = z.infer<typeof activeWizardRunsResponseSchema>;

export const enqueueWizardRunRequestSchema = z.object({
  campaignName: z.string().trim().max(160).default(""),
  modelId: z.string().trim().min(1).max(160).default("claude-opus-4-7-bridge"),
  brief: z.string().trim().max(200000).default(""),
  wizardTranscript: z.string().trim().max(400000).default(""),
  wizardSessionId: z.string().trim().min(1).max(160).optional(),
}).superRefine((value, ctx) => {
  if (!value.campaignName && !value.wizardSessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "campaignName or wizardSessionId required",
      path: ["campaignName"],
    });
  }
  if (!value.brief && !value.wizardTranscript && !value.wizardSessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "brief, wizardTranscript, or wizardSessionId required",
      path: ["brief"],
    });
  }
});

export type EnqueueWizardRunRequest = z.infer<typeof enqueueWizardRunRequestSchema>;

export const approveWizardRunRequestSchema = z.object({
  campaignName: z.string().trim().max(160).optional(),
  systemPromptDraft: z.string().trim().max(400000).optional(),
});

export type ApproveWizardRunRequest = z.infer<typeof approveWizardRunRequestSchema>;

export const approveWizardRunResponseSchema = wizardRunsResponseSchema;
export type ApproveWizardRunResponse = z.infer<typeof approveWizardRunResponseSchema>;

export const retryWizardRunResponseSchema = wizardRunsResponseSchema;
export type RetryWizardRunResponse = z.infer<typeof retryWizardRunResponseSchema>;

export const cancelWizardRunResponseSchema = wizardRunsResponseSchema;
export type CancelWizardRunResponse = z.infer<typeof cancelWizardRunResponseSchema>;
