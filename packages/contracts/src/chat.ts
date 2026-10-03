import { z } from "zod";

import { campaignSchema } from "./campaigns";
import { contextPreviewEntrySchema, contextAssemblyDebugSchema, type ContextAssemblyDebug, type ContextPreviewEntry } from "./context";
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
  content: z.string().max(ATTACHMENT_MAX_CONTENT_LEN),
}).superRefine((value, ctx) => {
  // Empty content is refused as before, but the issue names the file: the stream
  // controller reports the first issue verbatim, and Zod's
  // "String must contain at least 1 character(s)" told a client nothing it could act on.
  if (!value.content) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: `${value.filename || "The attachment"} is empty` });
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
  // Owner roll override (composer 🎲 toggle): set on the USER message whose turn
  // resolves contested outcomes in <user>'s favour. The UI badges it.
  rollOverride: z.boolean().default(false),
  // Model that actually produced the response per the upstream's report. Differs
  // from the requested model's wire ID when a Fable 5 safeguard fallback served
  // the turn — the UI badges that mismatch.
  servedModel: z.string().nullable().default(null),
  // Living World: 'gm_spotlight' on the GM-directive marker that precedes an
  // NPC-driven beat (rendered as a divider, never a user bubble). NULL otherwise.
  directiveKind: z.enum(["gm_spotlight"]).nullable().default(null),
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
  // Message branching / swipes. variantGroupId is non-null once a slot has been
  // regenerated at least once. variantCount/variantIndex drive the ‹ n/m ›
  // swipe chrome; variantSiblingIds is the ordered list of all siblings (active +
  // inactive) so the UI can switch with no extra fetch. Singletons: group null,
  // count 1, index 0, siblingIds [].
  variantGroupId: z.string().nullable().default(null),
  variantIndex: z.number().int().nonnegative().default(0),
  variantCount: z.number().int().positive().default(1),
  variantSiblingIds: z.array(z.string()).default([]),
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
  // True when the server holds this reply's
  // context snapshot (GET /api/chat/sessions/:sessionId/messages/:messageId/context).
  // Optional and additive: absent reads as "no snapshot"; Android 1.1.7 ignores it.
  hasContextSnapshot: z.boolean().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

// ── Per-reply context snapshot ─────────────────────────────────────────────────
// The `response.context` event of the turn that produced an assistant reply,
// persisted so the Preview popover survives a reload and an older reply can be
// inspected. One row per reply in `message_context_snapshots`; a session keeps
// its newest MESSAGE_CONTEXT_SNAPSHOTS_PER_SESSION rows.
export const MESSAGE_CONTEXT_SNAPSHOT_VERSION = 1 as const;
/** Dropped rows kept per snapshot: the highest-scoring ones. `droppedTotal` counts all of them. */
export const MESSAGE_CONTEXT_SNAPSHOT_DROPPED_ROWS = 40;
/** Snapshots a session keeps, newest by `created_at`; older rows are pruned on write. */
export const MESSAGE_CONTEXT_SNAPSHOTS_PER_SESSION = 50;

export const messageContextSnapshotSchema = z.object({
  version: z.literal(MESSAGE_CONTEXT_SNAPSHOT_VERSION),
  // The rows in the shape the stream carried them (`included` on each row):
  // every included row, then at most MESSAGE_CONTEXT_SNAPSHOT_DROPPED_ROWS
  // dropped rows, highest score first.
  preview: z.array(contextPreviewEntrySchema),
  /** Every row the engine dropped on that turn, including those not kept in `preview`. */
  droppedTotal: z.number().int().nonnegative(),
  debug: contextAssemblyDebugSchema,
  /** The retrieval budget of that turn, as `response.context.budgetTokens`. */
  budgetTokens: z.number().int(),
  /** Warnings (the Preview chip's amber channel). */
  notes: z.array(z.string()).default([]),
  /** Informational notes, rendered neutrally. */
  infoNotes: z.array(z.string()).default([]),
  /** The composer model of that turn. */
  modelId: z.string(),
  createdAt: z.string(),
}).superRefine((snapshot, ctx) => {
  const kept = snapshot.preview.filter((row) => !row.included).length;
  if (kept > MESSAGE_CONTEXT_SNAPSHOT_DROPPED_ROWS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preview"], message: `at most ${MESSAGE_CONTEXT_SNAPSHOT_DROPPED_ROWS} dropped rows are kept, got ${kept}` });
  }
  if (snapshot.droppedTotal < kept) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["droppedTotal"], message: `droppedTotal ${snapshot.droppedTotal} is below the ${kept} dropped rows kept` });
  }
});
export type MessageContextSnapshot = z.infer<typeof messageContextSnapshotSchema>;

/** GET /api/chat/sessions/:sessionId/messages/:messageId/context (404 when the reply has none). */
export const messageContextSnapshotResponseSchema = z.object({
  messageId: z.string(),
  snapshot: messageContextSnapshotSchema,
});
export type MessageContextSnapshotResponse = z.infer<typeof messageContextSnapshotResponseSchema>;

/** Builds a snapshot from the values a turn emitted as `response.context`: keeps
 *  every included row and the MESSAGE_CONTEXT_SNAPSHOT_DROPPED_ROWS highest-scoring
 *  dropped rows (ties keep the engine's order), and counts every dropped row in
 *  `droppedTotal`. Pure; the storage boundary parses the result. */
export function buildMessageContextSnapshot(input: {
  preview: readonly ContextPreviewEntry[];
  debug: ContextAssemblyDebug;
  budgetTokens: number;
  notes: readonly string[];
  infoNotes: readonly string[];
  modelId: string;
  createdAt: string;
}): MessageContextSnapshot {
  const included = input.preview.filter((row) => row.included);
  const dropped = input.preview.filter((row) => !row.included);
  // Array.prototype.sort is stable, so equal scores keep the engine's order.
  const keptDropped = [...dropped].sort((a, b) => b.score - a.score).slice(0, MESSAGE_CONTEXT_SNAPSHOT_DROPPED_ROWS);
  return {
    version: MESSAGE_CONTEXT_SNAPSHOT_VERSION,
    preview: [...included, ...keptDropped].map((row) => ({ ...row })),
    droppedTotal: dropped.length,
    debug: { ...input.debug },
    budgetTokens: input.budgetTokens,
    notes: [...input.notes],
    infoNotes: [...input.infoNotes],
    modelId: input.modelId,
    createdAt: input.createdAt,
  };
}

const overheadUsageSchema = z.object({
  source: z.string(),
  modelId: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
});

// Transcript windowing. The default GET returns only the most-recent
// window; `hasOlder` + `oldestSortOrder` drive the client's "Load older" cursor
// (`?before=<oldestSortOrder>` returns the previous window). Defaulted so
// responses from older servers (no pagination field) still parse.
export const sessionDetailPaginationSchema = z.object({
  hasOlder: z.boolean(),
  oldestSortOrder: z.number().int().nullable(),
  // Newer-direction cursor (scene jump): `?after=<newestSortOrder>` returns the
  // next window forward. Defaulted so payloads from older servers still parse.
  hasNewer: z.boolean().default(false),
  newestSortOrder: z.number().int().nullable().default(null),
});

export type SessionDetailPagination = z.infer<typeof sessionDetailPaginationSchema>;

// Whole-session aggregates computed server-side over ALL active messages.
// With the transcript windowed, a client-side fold over `messages` would silently
// shrink to the loaded window — these carry exactly what the status strip needs.
// Costs are computed with the same catalog rates the client uses (fast-mode and
// long-context tiers included); null mirrors the client folds' "no data" results.
export const sessionStatsSchema = z.object({
  activeMessageCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  // Σ per-message cost at the session's cache TTL; null when no message had usable rates.
  messageCost: z.number().nullable(),
  // Σ message-level overhead entries (researcher/HyDE/validator…); rolling-diff
  // overhead stays in rollingDiffOverhead, which is still returned in full.
  // Every overhead figure is priced by model-catalog estimateHelperOverheadUsd:
  // standard rates, long-context tier by each call's prompt size.
  overheadCost: z.number().nullable(),
  // Σ the rollingDiffOverhead entries under the same rule, so a client adds
  // two server figures instead of pricing the list itself (added 2026-09-30).
  // null when nothing priced; defaults for an older server.
  rollingDiffOverheadCost: z.number().nullable().default(null),
  cacheSavings: z.number().nullable(),
  // Σ content chars/lines over all active messages (client adds the system prompt).
  contentChars: z.number().int().nonnegative(),
  contentLines: z.number().int().nonnegative(),
  // Σ (content + per-message overhead + attachment estimates) chars — feeds the
  // client's ~chars/4 context-token estimate when older messages aren't loaded.
  estimatedContextChars: z.number().int().nonnegative(),
});

export type SessionStats = z.infer<typeof sessionStatsSchema>;

export const sessionDetailResponseSchema = z.object({
  session: sessionSummarySchema,
  campaign: campaignSchema.nullable(),
  messages: z.array(chatMessageSchema),
  rollingDiffOverhead: z.array(overheadUsageSchema).default([]),
  pagination: sessionDetailPaginationSchema.default({ hasOlder: false, oldestSortOrder: null, hasNewer: false, newestSortOrder: null }),
  // Present only on the DEFAULT (no-cursor) response; null on older-page fetches.
  sessionStats: sessionStatsSchema.nullable().default(null),
});

export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>;

// Query params for GET /sessions/:sessionId — `before` is an exclusive sort_order
// cursor (returns the window strictly older than it); `after` is the forward
// equivalent (scene jump — strictly newer, ascending; -1 reads from the start);
// `limit` caps the window size. The cursors are mutually exclusive (400).
export const sessionDetailQuerySchema = z.object({
  before: z.coerce.number().int().nonnegative().optional(),
  after: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
}).refine((q) => q.before == null || q.after == null, { message: "before and after are mutually exclusive" });

export type SessionDetailQuery = z.infer<typeof sessionDetailQuerySchema>;

export const sessionExportResponseSchema = z.object({
  sessionId: z.string(),
  filename: z.string(),
  mimeType: z.literal("text/markdown"),
  content: z.string(),
  exportedAt: z.string(),
});

export type SessionExportResponse = z.infer<typeof sessionExportResponseSchema>;

// ── JSON session export ─────────────────────────────────────────────────────
// ?format=json on the export route. Full transcript — ALL messages including
// inactive variant siblings (the markdown export renders active-only).
export const sessionExportQuerySchema = z.object({
  format: z.enum(["markdown", "json"]).default("markdown"),
});
export type SessionExportQuery = z.infer<typeof sessionExportQuerySchema>;

export const sessionExportJsonMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "cold-start"]),
  content: z.string(),
  thinking: z.string().nullable(),
  modelId: z.string().nullable(),
  servedModel: z.string().nullable(),
  sceneData: z.string().nullable(),
  stopReason: z.string().nullable(),
  fastMode: z.boolean(),
  rollOverride: z.boolean().default(false),
  variantGroupId: z.string().nullable(),
  variantActive: z.boolean(),
  usage: z.object({
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    totalTokens: z.number().int().nullable(),
    cacheReadTokens: z.number().int().nullable(),
    cacheWriteTokens: z.number().int().nullable(),
    reasoningTokens: z.number().int().nullable(),
  }).nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionExportJsonMessage = z.infer<typeof sessionExportJsonMessageSchema>;

export const sessionExportJsonResponseSchema = z.object({
  format: z.literal("json"),
  sessionId: z.string(),
  filename: z.string(),
  mimeType: z.literal("application/json"),
  exportedAt: z.string(),
  session: z.object({
    id: z.string(),
    name: z.string(),
    sessionType: z.enum(["standard", "wizard"]),
    campaignId: z.string().nullable(),
    modelId: z.string(),
    messageCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastMessageAt: z.string().nullable(),
  }),
  campaign: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
  }).nullable(),
  messages: z.array(sessionExportJsonMessageSchema),
});
export type SessionExportJsonResponse = z.infer<typeof sessionExportJsonResponseSchema>;

export const chatSendRequestSchema = z.object({
  prompt: z.string().trim().max(200000),
  modelId: z.string().min(1).optional(),
  attachments: z.array(chatAttachmentInputSchema).max(8).default([]),
  sceneConstraintOverride: z.object({
    location: z.string().max(500),
    present: z.array(z.string().max(200)).max(50),
    presentUnaware: z.array(z.string().max(200)).max(50),
  }).optional(),
  // Adversarial world — owner roll override (composer 🎲 toggle, default off).
  // Persisted on the user message; this turn's contested outcomes resolve in
  // <user>'s favour (PC contests succeed, antagonist contests against the PC
  // fail), stamped into the basis trail. Regenerates of the turn honour it.
  rollOverride: z.boolean().optional(),
  // Living World — spotlight turn ("hand the scene to an NPC"). When set, the
  // server persists a GM-directive marker (role=user, directive_kind=gm_spotlight)
  // and generates a beat driven by that character's drive sheet. prompt may be empty.
  spotlight: z.object({
    characterName: z.string().trim().min(1).max(200),
    steer: z.string().trim().max(500).optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  if (!value.prompt && value.attachments.length === 0 && !value.spotlight) {
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

// A cut that removes more than this many messages needs the person's confirmed count and the last message the client
// has (on 2026-10-02 a tab open since two days earlier resent an old message and cut the 199 newer ones it had
// never loaded). Editing or resending the latest exchange stays under it.
export const TRUNCATE_UNCONFIRMED_LIMIT = 2;

export const truncateChatMessagesRequestSchema = z.object({
  messageId: z.string().min(1),
  // A cut that replaces the row after it (Resend, the scene auto-regen) names that row. The
  // server refuses with 409 unless it is the first row after the cut, so rows the client never loaded are never cut.
  expectNextMessageId: z.string().min(1).optional(),
  // The last message the client has. The server refuses with 409 when it holds a newer one, so a page showing an old
  // transcript cannot cut what it never loaded.
  expectLastMessageId: z.string().min(1).optional(),
  // How many messages the person agreed to remove; required (428 otherwise) when the cut removes more than
  // TRUNCATE_UNCONFIRMED_LIMIT.
  confirmDeleteCount: z.number().int().nonnegative().optional(),
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

// --- Message branching / swipes ---

// Regenerate the target assistant message as a NEW sibling variant (the prior
// reply is preserved, not destroyed). modelId optionally overrides the model for
// this variant only. SSE-streamed like a normal turn.
export const regenerateChatMessageRequestSchema = z.object({
  modelId: z.string().min(1).optional(),
  // Owner roll override: an ARMED composer 🎲 also covers a regenerate — the
  // server stamps the flag onto the SOURCE user message (set-only, never
  // cleared here), so this variant and every later one resolve overridden.
  rollOverride: z.boolean().optional(),
});
export type RegenerateChatMessageRequest = z.infer<typeof regenerateChatMessageRequestSchema>;

// Continue a max_tokens-truncated assistant message IN PLACE (no new sibling) —
// strips the truncation warning and streams a continuation appended to the row.
export const continueChatMessageRequestSchema = z.object({
  modelId: z.string().min(1).optional(),
});
export type ContinueChatMessageRequest = z.infer<typeof continueChatMessageRequestSchema>;

// Edit a user turn and re-run the assistant in one atomic op: edit the user
// message content, truncate everything after it, then stream a fresh assistant
// reply. SSE-streamed.
export const editAndRegenerateRequestSchema = z.object({
  content: z.string().trim().min(1).max(200000),
  modelId: z.string().min(1).optional(),
  // Owner roll override: an ARMED composer 🎲 covers the edited turn's re-run
  // (stamped onto the edited user message; set-only).
  rollOverride: z.boolean().optional(),
});
export type EditAndRegenerateRequest = z.infer<typeof editAndRegenerateRequestSchema>;

// Switch which sibling of a variant group is active (non-streaming flip + scene
// recompute). Returns the full session detail.
export const switchVariantRequestSchema = z.object({
  variantMessageId: z.string().min(1),
});
export type SwitchVariantRequest = z.infer<typeof switchVariantRequestSchema>;

// --- Scene/date outline ---
// One entry per SCENE BREAK: consecutive scene-bearing messages with the same
// base location + in-world date collapse into one entry (the run's first
// message), keyed by messageId/sortOrder so the client can jump to a loaded
// message (or tell the user to load older windows to reach it).
export const sceneOutlineEntrySchema = z.object({
  messageId: z.string(),
  sortOrder: z.number().int().nonnegative(),
  location: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  // Scene-bearing turns this run spans. Defaulted so pre-collapse payloads parse.
  turns: z.number().int().positive().default(1),
});

export type SceneOutlineEntry = z.infer<typeof sceneOutlineEntrySchema>;

export const sceneOutlineResponseSchema = z.object({
  entries: z.array(sceneOutlineEntrySchema),
});

export type SceneOutlineResponse = z.infer<typeof sceneOutlineResponseSchema>;

export const generateImageRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(32000),
  modelId: z.string().min(1).default("gpt-image-2"),
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
    // The HTTP status the failure WOULD have carried (404 session missing, 429
    // concurrency, 503 runtime unconfigured, …). Every streaming route flushes
    // 200 event-stream headers before the service validates, so a thrown
    // HttpError can only reach the client as this event — the status rides
    // here so clients can still branch on it. Absent for non-HTTP failures.
    status: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("response.context"),
    preview: z.array(contextPreviewEntrySchema),
    debug: contextAssemblyDebugSchema,
    budgetTokens: z.number().int(),
    // Degradation warnings (e.g. "semantic retrieval failed — keyword-only").
    // Always emitted when non-empty, even with an empty preview, so passive
    // failures are visible per-turn instead of silently shrinking context.
    // WARNINGS ONLY — anything here paints the Preview chip amber. Routine
    // feature telemetry belongs in infoNotes (a warning channel only works if
    // everything in it is a warning).
    notes: z.array(z.string()).default([]),
    // Informational notes (e.g. "Comms context: injected N absent contacts") —
    // rendered neutrally in the Preview popover, never mark the chip degraded.
    infoNotes: z.array(z.string()).default([]),
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
