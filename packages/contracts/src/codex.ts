import { z } from "zod";

export const codexModeSchema = z.enum(["read-only", "yolo"]);
export type CodexMode = z.infer<typeof codexModeSchema>;

export const codexWorkspaceSchema = z.object({ id: z.string(), name: z.string(), cwd: z.string() });

export const codexModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  supportedReasoningEfforts: z.array(z.object({ id: z.string(), description: z.string() })),
  defaultReasoningEffort: z.string().nullable(),
  inputModalities: z.array(z.string()),
  supportsPersonality: z.boolean(),
  serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  defaultServiceTier: z.string().nullable(),
}).passthrough();

export const codexStatusResponseSchema = z.object({
  ok: z.literal(true),
  serviceVersion: z.string(),
  protocol: z.literal("codex-app-server"),
  cliVersion: z.string(),
  codexHome: z.string().optional(),
  workspaces: z.array(codexWorkspaceSchema),
  models: z.array(codexModelSchema),
  defaultModel: z.string(),
  defaultEffort: z.string(),
  modes: z.array(z.object({ id: codexModeSchema, name: z.string(), description: z.string() })),
  activeSessions: z.number().int().nonnegative(),
  legacySessionCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
}).passthrough();
export type CodexStatusResponse = z.infer<typeof codexStatusResponseSchema>;

export const codexUploadRequestSchema = z.object({ name: z.string().min(1), data: z.string().min(1) });
export type CodexUploadRequest = z.infer<typeof codexUploadRequestSchema>;

export const codexUploadResponseSchema = z.object({ path: z.string(), name: z.string(), size: z.number().int().nonnegative().optional() }).passthrough();
export type CodexUploadResponse = z.infer<typeof codexUploadResponseSchema>;

export const codexSessionFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "image"]),
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
  active: z.boolean(),
  status: z.string(),
  mode: codexModeSchema,
  model: z.string().optional(),
  effort: z.string().optional(),
  serviceTier: z.string().nullable().optional(),
  pinned: z.boolean(),
  archived: z.boolean().optional(),
  forkedFromId: z.string().nullable().optional(),
  cliVersion: z.string().optional(),
  lastError: z.string().nullable().optional(),
}).passthrough();
export type CodexSessionSummary = z.infer<typeof codexSessionSummarySchema>;

export const codexSessionsResponseSchema = z.array(codexSessionSummarySchema);
export type CodexSessionsResponse = z.infer<typeof codexSessionsResponseSchema>;

export const codexThreadItemSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  content: z.array(z.any()).optional(),
  text: z.string().optional(),
  phase: z.string().nullable().optional(),
  summary: z.array(z.string()).optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  status: z.string().optional(),
  aggregatedOutput: z.string().nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  changes: z.array(z.any()).optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.any().optional(),
  result: z.any().nullable().optional(),
  error: z.any().nullable().optional(),
  receiverThreadIds: z.array(z.string()).optional(),
  senderThreadId: z.string().optional(),
  agentThreadId: z.string().optional(),
  agentPath: z.string().optional(),
  kind: z.string().optional(),
}).passthrough();
export type CodexThreadItem = z.infer<typeof codexThreadItemSchema>;

export const codexTurnSchema = z.object({
  id: z.string(),
  items: z.array(codexThreadItemSchema),
  itemsView: z.string().optional(),
  status: z.string(),
  error: z.object({ message: z.string() }).passthrough().nullable().optional(),
  startedAt: z.number().nullable().optional(),
  completedAt: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
}).passthrough();
export type CodexTurn = z.infer<typeof codexTurnSchema>;

export const codexThreadSchema = z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  forkedFromId: z.string().nullable().optional(),
  parentThreadId: z.string().nullable().optional(),
  preview: z.string().optional(),
  cwd: z.string(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  recencyAt: z.number().nullable().optional(),
  status: z.object({ type: z.string() }).passthrough().optional(),
  cliVersion: z.string().optional(),
  agentNickname: z.string().nullable().optional(),
  agentRole: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  turns: z.array(codexTurnSchema),
}).passthrough();
export type CodexThread = z.infer<typeof codexThreadSchema>;

export const codexSessionMetadataSchema = z.object({
  // PATCH acknowledgement only; not persisted in manifest metadata.
  eventCursor: z.number().int().optional(),
  sessionId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  cwd: z.string(),
  mode: codexModeSchema,
  model: z.string(),
  effort: z.string().optional(),
  serviceTier: z.string().nullable().optional(),
  pinned: z.boolean(),
  title: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastPrompt: z.string().optional(),
  lastError: z.string().nullable().optional(),
  forkedFromId: z.string().optional(),
}).passthrough();
export type CodexSessionMetadata = z.infer<typeof codexSessionMetadataSchema>;

export const codexQuestionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isOther: z.boolean().default(false),
  isSecret: z.boolean().default(false),
  options: z.array(z.object({ label: z.string(), description: z.string() })).nullable().default(null),
}).passthrough();

export const codexPendingQuestionSchema = z.object({
  requestId: z.union([z.string(), z.number()]),
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  questions: z.array(codexQuestionSchema),
  autoResolutionMs: z.number().nullable().optional(),
}).passthrough();
export type CodexPendingQuestion = z.infer<typeof codexPendingQuestionSchema>;

export const codexRuntimeSchema = z.object({
  status: z.string(),
  activeTurnId: z.string().nullable(),
  activeThreadId: z.string().nullable().optional(),
  activeTurnStartIdx: z.number().int().nullable(),
  settings: z.record(z.any()).nullable(),
  tokenUsage: z.record(z.any()).nullable(),
  plan: z.object({ threadId: z.string().optional(), turnId: z.string().nullable().optional(), explanation: z.string().nullable().optional(), steps: z.array(z.any()) }).nullable(),
  // Latest cumulative snapshots for the active turn — interim diff
  // updates are live-stream-only (stub-persisted on the sidecar), so a panel
  // opened mid-turn seeds the current state from here instead of replaying
  // every superseded copy.
  turnDiff: z.object({ threadId: z.string().optional(), turnId: z.string().nullable().optional(), diff: z.string() }).nullable().optional(),
  goal: z.record(z.any()).nullable().optional(),
  liveEvents: z.array(z.any()),
  liveEventsTruncated: z.boolean().optional(),
  pendingQuestions: z.array(codexPendingQuestionSchema),
}).passthrough();

// Long-lived agent sessions accumulate turns without bound. A 3-day run reached ~114 MB
// of thread JSON taking 32s to serialize, which blew the bridge's 30s timeout — the panel
// could never open the session at all. getSession therefore returns only the newest window
// of turns and reports what it withheld. Since 2026-09-23 the sidecar
// pages that window natively (thread/turns/list) instead of hydrating the whole thread
// and slicing, so no RPC carries the full history; the totals come from shell pages.
export const codexTurnWindowSchema = z.object({
  limit: z.number().int().nonnegative(),
  descendantLimit: z.number().int().nonnegative(),
  rootTotal: z.number().int().nonnegative(),
  rootReturned: z.number().int().nonnegative(),
  descendantTotal: z.number().int().nonnegative(),
  descendantReturned: z.number().int().nonnegative(),
  // Subagent THREADS listed vs read (2026-09-23): getSession reads only the
  // newest 50 descendant threads; withheld threads set `truncated` and are counted here.
  // Optional: a sidecar that predates the fields omits them (clients treat that as "none").
  descendantThreadTotal: z.number().int().nonnegative().optional(),
  descendantThreadReturned: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
}).passthrough();

export const codexSessionResponseSchema = z.object({
  thread: codexThreadSchema,
  descendants: z.array(codexThreadSchema),
  metadata: codexSessionMetadataSchema,
  runtime: codexRuntimeSchema,
  eventCursor: z.number().int(),
  runtimeEventCursor: z.number().int().optional(),
  turnWindow: codexTurnWindowSchema.optional(),
}).passthrough();
export type CodexSessionResponse = z.infer<typeof codexSessionResponseSchema>;

export const codexSendRequestSchema = z.object({
  prompt: z.string().optional(),
  sessionId: z.string().nullable().optional(),
  workspaceId: z.string().optional(),
  files: z.array(codexSessionFileSchema).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  serviceTier: z.string().nullable().optional(),
  mode: codexModeSchema,
}).refine((value) => Boolean(value.prompt?.trim()) || Boolean(value.files?.length), { message: "prompt required", path: ["prompt"] });
export type CodexSendRequest = z.infer<typeof codexSendRequestSchema>;

export const codexSendResponseSchema = z.object({ sessionId: z.string(), turnId: z.string(), eventCursor: z.number().int(), activeThreadId: z.string().optional() });
export type CodexSendResponse = z.infer<typeof codexSendResponseSchema>;

export const codexSteerRequestSchema = z.object({
  prompt: z.string().optional(),
  files: z.array(codexSessionFileSchema).optional(),
}).refine((value) => Boolean(value.prompt?.trim()) || Boolean(value.files?.length), { message: "prompt required", path: ["prompt"] });
export type CodexSteerRequest = z.infer<typeof codexSteerRequestSchema>;

export const codexSettingsRequestSchema = z.object({
  mode: codexModeSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  serviceTier: z.string().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "at least one setting required" });
export type CodexSettingsRequest = z.infer<typeof codexSettingsRequestSchema>;

export const codexSettingsResponseSchema = z.object({
  eventCursor: z.number().int().optional(),
  ok: z.literal(true),
  mode: codexModeSchema,
  model: z.string(),
  effort: z.string().optional(),
  serviceTier: z.string().nullable(),
}).passthrough();
export type CodexSettingsResponse = z.infer<typeof codexSettingsResponseSchema>;

export const codexPatchRequestSchema = z.object({ title: z.string().max(200).optional(), pinned: z.boolean().optional() })
  .refine((value) => value.title !== undefined || value.pinned !== undefined, { message: "title or pinned required" });
export type CodexPatchRequest = z.infer<typeof codexPatchRequestSchema>;

export const codexForkRequestSchema = z.object({ lastTurnId: z.string().nullable().optional() });
export type CodexForkRequest = z.infer<typeof codexForkRequestSchema>;
export const codexForkResponseSchema = z.object({ sessionId: z.string() });
export type CodexForkResponse = z.infer<typeof codexForkResponseSchema>;

export const codexReviewTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommittedChanges") }),
  z.object({ type: z.literal("baseBranch"), branch: z.string().min(1) }),
  z.object({ type: z.literal("commit"), sha: z.string().min(1), title: z.string().nullable().optional() }),
  z.object({ type: z.literal("custom"), instructions: z.string().min(1) }),
]);
export const codexReviewRequestSchema = z.object({ target: codexReviewTargetSchema.optional() });
export type CodexReviewRequest = z.infer<typeof codexReviewRequestSchema>;

export const codexShellRequestSchema = z.object({ command: z.string().min(1) });
export type CodexShellRequest = z.infer<typeof codexShellRequestSchema>;

export const codexAnswerRequestSchema = z.object({
  requestId: z.union([z.string(), z.number()]),
  answers: z.record(z.union([z.string(), z.array(z.string())])),
});
export type CodexAnswerRequest = z.infer<typeof codexAnswerRequestSchema>;

export const codexOkResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
export type CodexOkResponse = z.infer<typeof codexOkResponseSchema>;

export const codexStreamEventSchema = z.object({
  idx: z.number().int(),
  method: z.string(),
  params: z.record(z.any()),
  ts: z.string(),
}).passthrough();
export type CodexStreamEvent = z.infer<typeof codexStreamEventSchema>;

export const codexFileSearchResponseSchema = z.object({ files: z.array(z.object({
  root: z.string(), path: z.string(), name: z.string(), score: z.number(), matchType: z.string(),
}).passthrough()) });
export type CodexFileSearchResponse = z.infer<typeof codexFileSearchResponseSchema>;

export const codexSkillsResponseSchema = z.object({ skills: z.array(z.object({
  name: z.string(), description: z.string().optional(), scope: z.string().optional(), enabled: z.boolean().optional(), path: z.string().optional(),
}).passthrough()) });
export type CodexSkillsResponse = z.infer<typeof codexSkillsResponseSchema>;

export const codexMcpResponseSchema = z.object({ servers: z.array(z.object({
  name: z.string(), authStatus: z.string().optional(), serverInfo: z.any().optional(), tools: z.array(z.object({ name: z.string(), title: z.string().optional(), description: z.string().optional() }).passthrough()),
}).passthrough()) });
export type CodexMcpResponse = z.infer<typeof codexMcpResponseSchema>;

export const codexDoctorResponseSchema = z.object({ doctor: z.any(), bridge: z.object({
  ready: z.boolean(), activeSessions: z.number().int().nonnegative(), warnings: z.array(z.string()),
}).passthrough() }).passthrough();
export type CodexDoctorResponse = z.infer<typeof codexDoctorResponseSchema>;
