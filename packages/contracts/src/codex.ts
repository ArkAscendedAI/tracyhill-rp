import { z } from "zod";

export const codexWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});

export type CodexWorkspace = z.infer<typeof codexWorkspaceSchema>;

export const codexStatusResponseSchema = z.object({
  ok: z.literal(true),
  workspaces: z.array(codexWorkspaceSchema),
});

export type CodexStatusResponse = z.infer<typeof codexStatusResponseSchema>;

export const codexUploadRequestSchema = z.object({
  name: z.string().min(1),
  data: z.string().min(1),
});

export type CodexUploadRequest = z.infer<typeof codexUploadRequestSchema>;

export const codexUploadResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
});

export type CodexUploadResponse = z.infer<typeof codexUploadResponseSchema>;

export const codexSessionFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.string(),
  size: z.number().int().nonnegative().optional(),
});

export type CodexSessionFile = z.infer<typeof codexSessionFileSchema>;

export const codexSessionSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string().optional(),
  preview: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  cwd: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  running: z.boolean().optional(),
  lastPrompt: z.string().optional(),
  lastError: z.string().optional(),
});

export type CodexSessionSummary = z.infer<typeof codexSessionSummarySchema>;

export const codexSessionsResponseSchema = z.array(codexSessionSummarySchema);

export type CodexSessionsResponse = z.infer<typeof codexSessionsResponseSchema>;

export const codexUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cached_input_tokens: z.number().int().nonnegative().optional(),
  reasoning_output_tokens: z.number().int().nonnegative().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
}).passthrough();

export type CodexUsage = z.infer<typeof codexUsageSchema>;

export const codexUserTranscriptItemSchema = z.object({
  id: z.string(),
  type: z.literal("user"),
  content: z.string(),
  files: z.array(codexSessionFileSchema).optional(),
  createdAt: z.string(),
});

export const codexTextTranscriptItemSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  content: z.string(),
  createdAt: z.string(),
});

export const codexErrorTranscriptItemSchema = z.object({
  id: z.string(),
  type: z.literal("error"),
  content: z.string(),
  createdAt: z.string(),
});

export const codexResultTranscriptItemSchema = z.object({
  id: z.string(),
  type: z.literal("result"),
  sessionId: z.string(),
  usage: codexUsageSchema.nullable().optional(),
  createdAt: z.string(),
});

export const codexCommandTranscriptItemSchema = z.object({
  id: z.string(),
  type: z.literal("command"),
  command: z.string(),
  cwd: z.string().optional(),
  status: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  outputPreview: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  hasFullOutput: z.boolean().optional(),
  outputPath: z.string().nullable().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

export const codexTranscriptItemSchema = z.discriminatedUnion("type", [
  codexUserTranscriptItemSchema,
  codexTextTranscriptItemSchema,
  codexErrorTranscriptItemSchema,
  codexResultTranscriptItemSchema,
  codexCommandTranscriptItemSchema,
]);

export type CodexTranscriptItem = z.infer<typeof codexTranscriptItemSchema>;

export const codexMessagesResponseSchema = z.array(codexTranscriptItemSchema);

export type CodexMessagesResponse = z.infer<typeof codexMessagesResponseSchema>;

export const codexOutputResponseSchema = z.object({
  output: z.string(),
});

export type CodexOutputResponse = z.infer<typeof codexOutputResponseSchema>;

export const codexSendRequestSchema = z.object({
  prompt: z.string().optional(),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  files: z.array(codexSessionFileSchema).optional(),
}).refine((value) => Boolean(value.prompt?.trim()) || Boolean(value.files?.length), {
  message: "prompt required",
  path: ["prompt"],
});

export type CodexSendRequest = z.infer<typeof codexSendRequestSchema>;

export const codexSystemStreamEventSchema = z.object({
  type: z.literal("system"),
  sessionId: z.string(),
  cwd: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  resumed: z.boolean(),
});

export const codexCommandStartStreamEventSchema = z.object({
  type: z.literal("command_start"),
  id: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
});

export const codexTextStreamEventSchema = z.object({
  type: z.literal("text"),
  id: z.string(),
  content: z.string(),
});

export const codexCommandEndStreamEventSchema = z.object({
  type: z.literal("command_end"),
  id: z.string(),
  command: z.string(),
  status: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  outputPreview: z.string().optional(),
  outputTruncated: z.boolean().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  hasFullOutput: z.boolean().optional(),
});

export const codexResultStreamEventSchema = z.object({
  type: z.literal("result"),
  sessionId: z.string(),
  usage: codexUsageSchema.nullable().optional(),
});

export const codexErrorStreamEventSchema = z.object({
  type: z.literal("error"),
  sessionId: z.string().optional(),
  message: z.string(),
});

export const codexStreamEventSchema = z.discriminatedUnion("type", [
  codexSystemStreamEventSchema,
  codexCommandStartStreamEventSchema,
  codexTextStreamEventSchema,
  codexCommandEndStreamEventSchema,
  codexResultStreamEventSchema,
  codexErrorStreamEventSchema,
]);

export type CodexStreamEvent = z.infer<typeof codexStreamEventSchema>;
