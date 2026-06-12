import { z } from "zod";

export const claudeCodeUploadRequestSchema = z.object({
  name: z.string().min(1),
  data: z.string().min(1),
});
export type ClaudeCodeUploadRequest = z.infer<typeof claudeCodeUploadRequestSchema>;

export const claudeCodeUploadResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
}).passthrough();
export type ClaudeCodeUploadResponse = z.infer<typeof claudeCodeUploadResponseSchema>;

export const claudeCodeFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.string(),
  size: z.number().int().nonnegative().optional(),
});
export type ClaudeCodeFile = z.infer<typeof claudeCodeFileSchema>;

// "research" + "execute" are the v2 binary modes. Legacy values
// (normal/plan/acceptEdits/auto) remain accepted so older clients and the
// agent-service legacy mapping keep working.
export const claudeCodeModeSchema = z.enum(["research", "execute", "normal", "plan", "acceptEdits", "auto"]);
export type ClaudeCodeMode = z.infer<typeof claudeCodeModeSchema>;

// Modes the agent/CLI REPORTS back can drift between Claude Code builds (e.g.
// newer builds renamed "normal" -> "default"). Parse them leniently so a label
// change never 503s the whole session list. The strict enum above is still used
// for modes the UI SENDS to the agent.
export const claudeCodeReportedModeSchema = z.string();

export const claudeCodeSessionSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string().optional(),
  lastPrompt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  cwd: z.string().optional(),
  pinned: z.boolean().optional(),
  active: z.boolean().optional(),
  status: z.string().nullable().optional(),
  lastEventAt: z.number().nullable().optional(),
  mode: claudeCodeReportedModeSchema.nullable().optional(),
}).passthrough();
export type ClaudeCodeSessionSummary = z.infer<typeof claudeCodeSessionSummarySchema>;

export const claudeCodeSessionsResponseSchema = z.array(claudeCodeSessionSummarySchema);
export type ClaudeCodeSessionsResponse = z.infer<typeof claudeCodeSessionsResponseSchema>;

export const claudeCodeMessageSchema = z.object({
  type: z.string(),
  content: z.string().optional(),
  message: z.string().optional(),
  tool: z.string().optional(),
  input: z.union([z.string(), z.record(z.any())]).optional(),
  output: z.string().optional(),
  sessionId: z.string().optional(),
  queryKey: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  turns: z.number().int().optional(),
  duration: z.number().optional(),
  cost: z.number().optional(),
  id: z.string().optional(),
  uuid: z.string().optional(),
  _idx: z.number().int().optional(),
  // v2 additions
  parentToolUseId: z.string().nullable().optional(),
  stopReason: z.string().nullable().optional(),
  usage: z.record(z.any()).nullable().optional(),
}).passthrough();
export type ClaudeCodeMessage = z.infer<typeof claudeCodeMessageSchema>;

export const claudeCodeMessagesResponseSchema = z.array(claudeCodeMessageSchema);
export type ClaudeCodeMessagesResponse = z.infer<typeof claudeCodeMessagesResponseSchema>;

export const claudeCodeEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ClaudeCodeEffort = z.infer<typeof claudeCodeEffortSchema>;

export const claudeCodeSendRequestSchema = z.object({
  prompt: z.string().optional(),
  sessionId: z.string().nullable().optional(),
  files: z.array(claudeCodeFileSchema).optional(),
  model: z.string().optional(),
  effort: claudeCodeEffortSchema.optional(),
  mode: claudeCodeModeSchema.optional(),
  researchBash: z.boolean().optional(),
}).refine((value) => Boolean(value.prompt?.trim()) || Boolean(value.files?.length), {
  message: "prompt required",
  path: ["prompt"],
});
export type ClaudeCodeSendRequest = z.infer<typeof claudeCodeSendRequestSchema>;

export const claudeCodeSendResponseSchema = z.object({
  queryKey: z.string(),
}).passthrough();
export type ClaudeCodeSendResponse = z.infer<typeof claudeCodeSendResponseSchema>;

export const claudeCodeStatusResponseSchema = z.object({
  active: z.boolean().optional(),
  status: z.string().optional(),
  eventCount: z.number().int().optional(),
  lastEventIdx: z.number().int().optional(),
  lastEventAt: z.number().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  queryKey: z.string().optional(),
  error: z.string().nullable().optional(),
  mode: claudeCodeReportedModeSchema.optional(),
  turnStatus: z.string().nullable().optional(),
  researchBash: z.boolean().optional(),
  queueDepth: z.number().int().optional(),
}).passthrough();
export type ClaudeCodeStatusResponse = z.infer<typeof claudeCodeStatusResponseSchema>;

export const claudeCodeStreamEventSchema = z.object({
  type: z.string(),
  _idx: z.number().int().optional(),
  text: z.string().optional(),
  message: z.string().optional(),
  sessionId: z.string().optional(),
  queryKey: z.string().optional(),
  tool: z.string().optional(),
  input: z.union([z.string(), z.record(z.any())]).optional(),
  output: z.string().optional(),
  elapsed: z.number().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  content: z.string().optional(),
  id: z.string().optional(),
  status: z.string().optional(),
  userMessageId: z.string().optional(),
  mode: claudeCodeReportedModeSchema.optional(),
  reason: z.string().optional(),
  model_initiated: z.boolean().optional(),
  questions: z.array(z.any()).optional(),
  canRewind: z.boolean().optional(),
  filesChanged: z.array(z.string()).optional(),
  insertions: z.number().optional(),
  deletions: z.number().optional(),
  dryRun: z.boolean().optional(),
  // v2 additions
  version: z.number().int().optional(),             // schema event
  parentToolUseId: z.string().nullable().optional(), // subagent nesting
  queued: z.boolean().optional(),                    // user event
  control: z.boolean().optional(),                   // control-only user event (/compact)
  answers: z.record(z.any()).nullable().optional(),  // question_answered
  plan: z.string().nullable().optional(),            // plan_ready
  allowedPrompts: z.array(z.any()).nullable().optional(),
  feedback: z.string().nullable().optional(),        // plan_rejected
  researchBash: z.boolean().optional(),              // mode_change
  // task_started/progress/updated + task_notification
  taskId: z.string().optional(),
  toolUseId: z.string().optional(),
  description: z.string().optional(),
  subagentType: z.string().optional(),
  usage: z.record(z.any()).nullable().optional(),
  outputFile: z.string().optional(),
  summary: z.string().nullable().optional(),
  // compact_boundary
  trigger: z.string().optional(),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
  durationMs: z.number().optional(),
  // result / refusal
  subtype: z.string().optional(),
  result: z.string().nullable().optional(),
  stopReason: z.string().nullable().optional(),
  servedModel: z.string().nullable().optional(),
  modelUsage: z.record(z.any()).nullable().optional(),
  category: z.string().nullable().optional(),
  explanation: z.string().nullable().optional(),
  // system init
  slashCommands: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  claudeCodeVersion: z.string().nullable().optional(),
  fastModeState: z.string().nullable().optional(),
  // context_usage
  totalTokens: z.number().optional(),
  maxTokens: z.number().optional(),
  percentage: z.number().optional(),
  categories: z.array(z.any()).optional(),
  // suggestion / subagent
  agentId: z.string().optional(),
  agentType: z.string().optional(),
}).passthrough();
export type ClaudeCodeStreamEvent = z.infer<typeof claudeCodeStreamEventSchema>;

export const claudeCodeOkResponseSchema = z.object({
  ok: z.literal(true),
}).passthrough();
export type ClaudeCodeOkResponse = z.infer<typeof claudeCodeOkResponseSchema>;

export const claudeCodePatchRequestSchema = z.object({
  title: z.string().max(200).optional(),
  pinned: z.boolean().optional(),
}).refine((v) => v.title !== undefined || v.pinned !== undefined, {
  message: "at least one of title/pinned required",
});
export type ClaudeCodePatchRequest = z.infer<typeof claudeCodePatchRequestSchema>;

export const claudeCodePatchResponseSchema = z.object({
  ok: z.literal(true),
  title: z.string().optional(),
  pinned: z.boolean().optional(),
}).passthrough();
export type ClaudeCodePatchResponse = z.infer<typeof claudeCodePatchResponseSchema>;

export const claudeCodeFsTreeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "dir"]),
});
export type ClaudeCodeFsTreeEntry = z.infer<typeof claudeCodeFsTreeEntrySchema>;

export const claudeCodeFsTreeResponseSchema = z.object({
  path: z.string(),
  entries: z.array(claudeCodeFsTreeEntrySchema),
});
export type ClaudeCodeFsTreeResponse = z.infer<typeof claudeCodeFsTreeResponseSchema>;

// ── New 2026-04-22/23 additions ──

export const claudeCodeAnswerRequestSchema = z.object({
  questionId: z.string(),
  answers: z.record(z.any()).optional(),
});
export type ClaudeCodeAnswerRequest = z.infer<typeof claudeCodeAnswerRequestSchema>;

export const claudeCodeDoctorResponseSchema = z.object({
  sessionId: z.string(),
  found: z.boolean(),
  status: z.string().nullable(),
  mode: claudeCodeReportedModeSchema.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  cwd: z.string(),
  additionalDirectories: z.array(z.string()),
  disallowedTools: z.array(z.string()).optional(),
  permissionMode: z.string().nullable(),
  thinking: z.string().nullable().optional(),
  sdkVersion: z.string(),
  startedAt: z.string().nullable(),
  lastEventAt: z.number().nullable(),
  eventCount: z.number().nullable(),
  lastError: z.string().nullable(),
  subscribers: z.number(),
  pinned: z.boolean(),
  title: z.string().nullable(),
  researchAllowedTools: z.array(z.string()),
}).passthrough();
export type ClaudeCodeDoctorResponse = z.infer<typeof claudeCodeDoctorResponseSchema>;

export const claudeCodeMemoryFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  cwd: z.string().optional(),
});
export type ClaudeCodeMemoryFile = z.infer<typeof claudeCodeMemoryFileSchema>;

export const claudeCodeMemoryListResponseSchema = z.object({
  files: z.array(claudeCodeMemoryFileSchema),
});
export type ClaudeCodeMemoryListResponse = z.infer<typeof claudeCodeMemoryListResponseSchema>;

export const claudeCodeMemoryReadResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type ClaudeCodeMemoryReadResponse = z.infer<typeof claudeCodeMemoryReadResponseSchema>;

export const claudeCodeMemoryWriteRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type ClaudeCodeMemoryWriteRequest = z.infer<typeof claudeCodeMemoryWriteRequestSchema>;

export const claudeCodeMemoryWriteResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
  size: z.number().int().nonnegative(),
}).passthrough();
export type ClaudeCodeMemoryWriteResponse = z.infer<typeof claudeCodeMemoryWriteResponseSchema>;

export const claudeCodeRewindRequestSchema = z.object({
  userMessageId: z.string(),
  dryRun: z.boolean().optional(),
});
export type ClaudeCodeRewindRequest = z.infer<typeof claudeCodeRewindRequestSchema>;

export const claudeCodeRewindResponseSchema = z.object({
  canRewind: z.boolean(),
  error: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  insertions: z.number().optional(),
  deletions: z.number().optional(),
}).passthrough();
export type ClaudeCodeRewindResponse = z.infer<typeof claudeCodeRewindResponseSchema>;

// ── v2 control surface ──

export const claudeCodeModeRequestSchema = z.object({
  mode: claudeCodeModeSchema.optional(),
  researchBash: z.boolean().optional(),
  reason: z.string().max(200).optional(),
}).refine((v) => v.mode !== undefined || v.researchBash !== undefined, {
  message: "mode or researchBash required",
});
export type ClaudeCodeModeRequest = z.infer<typeof claudeCodeModeRequestSchema>;

export const claudeCodeContextResponseSchema = z.object({
  totalTokens: z.number(),
  maxTokens: z.number(),
  percentage: z.number().optional(),
  model: z.string().optional(),
  categories: z.array(z.object({
    name: z.string(),
    tokens: z.number(),
    color: z.string().optional(),
  })),
  memoryFiles: z.array(z.any()).optional(),
  mcpTools: z.array(z.any()).optional(),
  live: z.boolean().optional(),
}).passthrough();
export type ClaudeCodeContextResponse = z.infer<typeof claudeCodeContextResponseSchema>;

export const claudeCodeCommandSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  argumentHint: z.string().nullable().optional(),
});
export const claudeCodeCommandsResponseSchema = z.object({
  commands: z.array(claudeCodeCommandSchema),
  skills: z.array(z.string()).optional(),
  live: z.boolean().optional(),
}).passthrough();
export type ClaudeCodeCommandsResponse = z.infer<typeof claudeCodeCommandsResponseSchema>;

export const claudeCodeModelRequestSchema = z.object({ model: z.string().min(1) });
export type ClaudeCodeModelRequest = z.infer<typeof claudeCodeModelRequestSchema>;

export const claudeCodeForkRequestSchema = z.object({
  upToMessageId: z.string().optional(),
  title: z.string().max(200).optional(),
});
export type ClaudeCodeForkRequest = z.infer<typeof claudeCodeForkRequestSchema>;

export const claudeCodeForkResponseSchema = z.object({ sessionId: z.string() }).passthrough();
export type ClaudeCodeForkResponse = z.infer<typeof claudeCodeForkResponseSchema>;

export const claudeCodeRejectPlanRequestSchema = z.object({ feedback: z.string().optional() });
export type ClaudeCodeRejectPlanRequest = z.infer<typeof claudeCodeRejectPlanRequestSchema>;

export const claudeCodeTaskSchema = z.object({
  taskId: z.string(),
  toolUseId: z.string().optional(),
  description: z.string().optional(),
  subagentType: z.string().optional(),
  status: z.string().optional(),
  usage: z.record(z.any()).nullable().optional(),
}).passthrough();
export const claudeCodeTasksResponseSchema = z.object({ tasks: z.array(claudeCodeTaskSchema) });
export type ClaudeCodeTasksResponse = z.infer<typeof claudeCodeTasksResponseSchema>;

export const claudeCodeSuggestionsResponseSchema = z.object({ suggestions: z.array(z.string()) });
export type ClaudeCodeSuggestionsResponse = z.infer<typeof claudeCodeSuggestionsResponseSchema>;
