import { z } from "zod";

import { antagonistSchemeSchema } from "./drives";

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
  // How far a long step has got ("Sorting entries: 40 of 120"), while it runs. A lorebook import works in batches.
  progress: z.string().nullable().optional(),
});

export type WizardRunStep = z.infer<typeof wizardRunStepSchema>;

// An imported entry's trigger settings (SillyTavern import). A wizard-written entry has
// none and takes the native defaults at approval; an imported one keeps how it fired in SillyTavern.
export const lorebookCorpusActivationSchema = z.object({
  selectiveLogic: z.enum(["and_any", "not_all", "not_any", "and_all"]),
  probability: z.number().int().min(0).max(100),
  sticky: z.number().int().min(0).max(1000),
  cooldown: z.number().int().min(0).max(1000),
  delay: z.number().int().min(0).max(1000),
  excludeRecursion: z.boolean(),
  preventRecursion: z.boolean(),
  delayUntilRecursion: z.boolean(),
  caseSensitive: z.boolean().optional(),
  matchWholeWords: z.boolean().optional(),
  enabled: z.boolean(),
});

export type LorebookCorpusActivation = z.infer<typeof lorebookCorpusActivationSchema>;

// Where an entry came from, shown in the review and kept in the lorebook entry's comment: a file entry (its original
// title, and the sections the importer added to it) or the wizard's own writing.
export const lorebookCorpusOriginSchema = z.object({
  kind: z.enum(["imported", "generated"]),
  source: z.string().optional(),
  added: z.array(z.string()).optional(),
});

export type LorebookCorpusOrigin = z.infer<typeof lorebookCorpusOriginSchema>;

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
  startingAttire: z.string().optional(),
  startingDrives: z.object({
    wants: z.array(z.string()).optional(),
    goals: z.array(z.string()).optional(),
    // Structural capability. The drive sheet has always supported these; the
    // wizard neither asked for them nor accepted them, so every generated cast
    // arrived with no lines they would cross, no hold over anyone, and nothing
    // to hide — a world that can only react. Generated at full strength
    // regardless of any grit dial: dials govern PLAY, and a soft corpus is not
    // recoverable by turning a dial up later.
    redLines: z.array(z.string()).optional(),
    leverage: z.array(z.string()).optional(),
    concealment: z.array(z.object({ secret: z.string(), behavior: z.string() })).optional(),
    offpageProject: z.string().optional(),
    dispositions: z.record(z.string()).optional(),
  }).optional(),
  // One active antagonist scheme per character is supported by the sealed
  // drive record. The array shape leaves room for future queued schemes while
  // the v1 wizard deliberately emits at most one.
  startingSchemes: z.array(antagonistSchemeSchema).max(1).optional(),
  activation: lorebookCorpusActivationSchema.optional(),
  origin: lorebookCorpusOriginSchema.optional(),
});

export type LorebookCorpusEntry = z.infer<typeof lorebookCorpusEntrySchema>;

export const wizardLintFindingSchema = z.object({
  code: z.string(),
  scope: z.enum(["system_prompt", "corpus"]),
  location: z.string(),
  message: z.string(),
  excerpt: z.string(),
  line: z.number().int().positive().nullable(),
});

export type WizardLintFinding = z.infer<typeof wizardLintFindingSchema>;

export const wizardAutoCorrectionSchema = z.object({
  code: z.string(),
  scope: z.enum(["system_prompt", "corpus"]),
  location: z.string(),
  summary: z.string(),
  before: z.string(),
  after: z.string(),
  verified: z.boolean(),
});

export type WizardAutoCorrection = z.infer<typeof wizardAutoCorrectionSchema>;

export const wizardRunReviewSchema = z.object({
  campaignName: z.string(),
  brief: z.string(),
  wizardTranscript: z.string(),
  wizardSessionId: z.string().nullable(),
  playerCharacterName: z.string(),
  systemPromptDraft: z.string().nullable(),
  lorebookCorpusDraft: z.array(lorebookCorpusEntrySchema).nullable(),
  autoCorrections: z.array(wizardAutoCorrectionSchema).default([]),
  lintResidue: z.array(wizardLintFindingSchema).default([]),
  approvedCampaignId: z.string().nullable(),
  approvedSessionId: z.string().nullable(),
  retriedFromRunId: z.string().nullable(),
  // Set when the run converts an imported lorebook rather than a wizard conversation.
  importSummary: z.object({
    format: z.literal("sillytavern"),
    fileName: z.string(),
    // Entries in the file, entries carried into the campaign, and why the others were left out.
    entries: z.number().int().nonnegative(),
    imported: z.number().int().nonnegative(),
    leftOut: z.array(z.string()),
    notes: z.string(),
  }).nullable().default(null),
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
  // Omitted → the service resolves `getDefaultChatModelId()` (the deployment's
  // DEFAULT_MODEL_ID override). A hardcoded Zod default here made that fallback
  // unreachable over HTTP and disagreed with configuration.
  modelId: z.string().trim().min(1).max(160).optional(),
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

// A SillyTavern lorebook (World Info file, or a character card's book) turned into a new campaign through the wizard's
// review and approval. The file rides the request as parsed JSON.
export const importWizardRunRequestSchema = z.object({
  format: z.literal("sillytavern").default("sillytavern"),
  fileName: z.string().trim().max(255).default(""),
  campaignName: z.string({ required_error: "Name the campaign" }).trim().min(1, "Name the campaign").max(160),
  playerCharacterName: z.string({ required_error: "Name the character you will play" }).trim().min(1, "Name the character you will play").max(120),
  // What {{char}} stands for (SillyTavern's name for the character card's character); blank leaves the macro as written.
  charName: z.string().trim().max(120).default(""),
  notes: z.string().trim().max(20000).default(""),
  modelId: z.string().trim().min(1).max(160).optional(),
  // Add the native sections an imported character entry lacks; its own text is kept either way.
  addCharacterSections: z.boolean().default(true),
  lorebook: z.unknown(),
});

export type ImportWizardRunRequest = z.input<typeof importWizardRunRequestSchema>;

export const importWizardRunResponseSchema = wizardRunsResponseSchema.extend({ runId: z.string() });
export type ImportWizardRunResponse = z.infer<typeof importWizardRunResponseSchema>;

export const approveWizardRunRequestSchema = z.object({
  campaignName: z.string().trim().max(160).optional(),
  systemPromptDraft: z.string().trim().max(400000).optional(),
  // Optional correction of the generated player-character name; Section A is
  // re-stamped with it. Omitted → the generated name (older clients).
  playerCharacterName: z.string().trim().min(1).max(120).optional(),
});

export type ApproveWizardRunRequest = z.infer<typeof approveWizardRunRequestSchema>;

export const approveWizardRunResponseSchema = wizardRunsResponseSchema;
export type ApproveWizardRunResponse = z.infer<typeof approveWizardRunResponseSchema>;

export const retryWizardRunResponseSchema = wizardRunsResponseSchema;
export type RetryWizardRunResponse = z.infer<typeof retryWizardRunResponseSchema>;

export const cancelWizardRunResponseSchema = wizardRunsResponseSchema;
export type CancelWizardRunResponse = z.infer<typeof cancelWizardRunResponseSchema>;

export const dismissWizardRunResponseSchema = wizardRunsResponseSchema;
export type DismissWizardRunResponse = z.infer<typeof dismissWizardRunResponseSchema>;
