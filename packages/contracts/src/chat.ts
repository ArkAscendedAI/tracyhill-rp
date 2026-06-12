import { z } from "zod";

import { campaignSchema } from "./campaigns";
import { contextPreviewEntrySchema, contextAssemblyDebugSchema } from "./context";
import { sessionSummarySchema } from "./workspace";

export const chatRoleSchema = z.enum(["user", "assistant", "cold-start"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;
export const attachmentContentModeSchema = z.enum(["text", "base64"]);
export type AttachmentContentMode = z.infer<typeof attachmentContentModeSchema>;

const attachmentSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  contentMode: attachmentContentModeSchema,
  content: z.string(),
  createdAt: z.string(),
});

// Per-attachment content cap. Base64 char count; ~4.8 MB raw bytes when decoded.
// Just under Anthropic's 5-MB-per-image API limit (the most restrictive provider).
export const ATTACHMENT_MAX_CONTENT_LEN = 6_500_000;

const chatAttachmentInputSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  contentMode: attachmentContentModeSchema,
  content: z.string().min(1).max(ATTACHMENT_MAX_CONTENT_LEN),
});

export const chatUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  // Reasoning/thinking tokens where the provider itemizes them (Anthropic
  // output_tokens_details.thinking_tokens, OpenAI/xAI/z.ai/DeepSeek/Xiaomi
  // *_tokens_details.reasoning_tokens, Gemini thoughtsTokenCount). Included
  // inside outputTokens for billing on every provider — display only.
  // Default null so usage persisted before 2026-06-12 parses unchanged.
  reasoningTokens: z.number().int().nonnegative().nullable().default(null),
  // Server-reported speed for fast mode confirmation. "fast" iff the API
  // actually applied fast mode (we may request it but get downgraded on
  // deprecated models). Null on providers that don't return a speed field.
  speed: z.enum(["fast", "standard"]).nullable().default(null),
});

export type ChatUsage = z.infer<typeof chatUsageSchema>;

// Anthropic stop_details (Opus 4.7+) — populated only on refusal responses.
// Lenient parsing so future categories don't break.
// See: https://docs.anthropic.com/en/docs/build-with-claude/handling-stop-reasons
export const stopDetailsSchema = z.object({
  type: z.string(),
  category: z.string().nullable(),
  explanation: z.string().nullable(),
}).nullable();

export type StopDetails = z.infer<typeof stopDetailsSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: chatRoleSchema,
  content: z.string(),
  thinking: z.string().nullable().default(null),
  modelId: z.string().nullable(),
  usage: chatUsageSchema.nullable().default(null),
  // Stop reason + (refusal-only) stop_details from the provider's final message_delta.
  // stopReason is set on every assistant message; stopDetails is non-null only when
  // stopReason === "refusal" on Anthropic 4.7+.
  stopReason: z.string().nullable().default(null),
  stopDetails: stopDetailsSchema.default(null),
  // True iff the API actually ran this turn in fast mode (verified from usage.speed).
  fastMode: z.boolean().default(false),
  // Model that actually produced the response per the upstream's report. Differs
  // from the requested model's wire ID when a Fable 5 safeguard fallback served
  // the turn — the UI badges that mismatch.
  servedModel: z.string().nullable().default(null),
  sceneData: z.string().nullable().default(null),
  sceneValidator: z.object({
    agreement: z.enum(["agree", "disagree"]),
    main: z.object({ present: z.array(z.string()), presentUnaware: z.array(z.string()) }),
    validator: z.object({ present: z.array(z.string()), presentUnaware: z.array(z.string()) }),
    rationale: z.string(),
    modelId: z.string(),
  }).nullable().default(null),
  sceneResolution: z.enum(["main", "validator", "user"]).nullable().default(null),
  overhead: z.array(z.object({
    source: z.string(),
    modelId: z.string(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  })).nullable().default(null),
  sortOrder: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  attachments: z.array(attachmentSchema).default([]),
  generatedImages: z.array(z.object({
    id: z.string(),
    messageId: z.string(),
    prompt: z.string(),
    mimeType: z.string(),
    url: z.string(),
    createdAt: z.string(),
  })).default([]),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

const overheadUsageSchema = z.object({
  source: z.string(),
  modelId: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
});

export const sessionDetailResponseSchema = z.object({
  session: sessionSummarySchema,
  campaign: campaignSchema.nullable(),
  messages: z.array(chatMessageSchema),
  rollingDiffOverhead: z.array(overheadUsageSchema).default([]),
});

export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>;

export const sessionExportResponseSchema = z.object({
  sessionId: z.string(),
  filename: z.string(),
  mimeType: z.literal("text/markdown"),
  content: z.string(),
  exportedAt: z.string(),
});

export type SessionExportResponse = z.infer<typeof sessionExportResponseSchema>;

export const chatSendRequestSchema = z.object({
  prompt: z.string().trim().max(200000),
  modelId: z.string().min(1).optional(),
  attachments: z.array(chatAttachmentInputSchema).max(8).default([]),
  sceneConstraintOverride: z.object({
    location: z.string().max(500),
    present: z.array(z.string().max(200)).max(50),
    presentUnaware: z.array(z.string().max(200)).max(50),
  }).optional(),
}).superRefine((value, ctx) => {
  if (!value.prompt && value.attachments.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "prompt or attachments required",
      path: ["prompt"],
    });
  }
});

export type ChatSendRequest = z.infer<typeof chatSendRequestSchema>;

export const stopChatStreamRequestSchema = z.object({
  requestId: z.string().min(1),
});

export type StopChatStreamRequest = z.infer<typeof stopChatStreamRequestSchema>;

export const stopChatStreamResponseSchema = z.object({
  stopped: z.boolean(),
});

export type StopChatStreamResponse = z.infer<typeof stopChatStreamResponseSchema>;

export const updateChatMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(200000),
});

export type UpdateChatMessageRequest = z.infer<typeof updateChatMessageRequestSchema>;

export const truncateChatMessagesRequestSchema = z.object({
  messageId: z.string().min(1),
});

export const resolveSceneValidationRequestSchema = z.object({
  choice: z.enum(["main", "validator", "user"]),
  userPresent: z.string().max(2000).optional(),
  userPresentUnaware: z.string().max(2000).optional(),
});

export type ResolveSceneValidationRequest = z.infer<typeof resolveSceneValidationRequestSchema>;

export const editSceneMetadataRequestSchema = z.object({
  location: z.string().max(500).optional(),
  present: z.array(z.string().max(200)).max(50).optional(),
  presentUnaware: z.array(z.string().max(200)).max(50).optional(),
  reason: z.string().max(500).nullable().optional(),
  date: z.string().max(200).nullable().optional(),
  time: z.string().max(200).nullable().optional(),
});

export type EditSceneMetadataRequest = z.infer<typeof editSceneMetadataRequestSchema>;

export type TruncateChatMessagesRequest = z.infer<typeof truncateChatMessagesRequestSchema>;

export const generateImageRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(32000),
  modelId: z.string().min(1).default("gpt-image-1"),
});

export type GenerateImageRequest = z.infer<typeof generateImageRequestSchema>;

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("response.started"),
    modelId: z.string(),
  }),
  z.object({
    type: z.literal("response.delta"),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("response.thinking.delta"),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("response.completed"),
    message: chatMessageSchema,
    usage: chatUsageSchema,
  }),
  z.object({
    type: z.literal("response.error"),
    error: z.string(),
  }),
  z.object({
    type: z.literal("response.context"),
    preview: z.array(contextPreviewEntrySchema),
    debug: contextAssemblyDebugSchema,
    budgetTokens: z.number().int(),
    // Degradation warnings (e.g. "semantic retrieval failed — keyword-only").
    // Always emitted when non-empty, even with an empty preview, so passive
    // failures are visible per-turn instead of silently shrinking context.
    notes: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("response.scene_validation"),
    messageId: z.string(),
    agreement: z.enum(["agree", "disagree"]),
    main: z.object({ present: z.array(z.string()), presentUnaware: z.array(z.string()) }),
    validator: z.object({ present: z.array(z.string()), presentUnaware: z.array(z.string()) }),
    rationale: z.string(),
    modelId: z.string(),
  }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
