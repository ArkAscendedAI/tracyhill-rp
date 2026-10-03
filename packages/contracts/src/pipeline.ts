import { z } from "zod";

export const pipelineRunStatusSchema = z.enum(["queued", "running", "completed", "failed", "canceled"]);
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;

// The retired campaign_review run shape (step slots, review fields, retry modes,
// the `models` block, `approvedAt`) was dropped from the wire 2026-09-02 once its
// last reader — the Android PipelineModels — stopped modelling it (the web
// readers were already gone). Run details are per-kind JSON owned by the workers.
export const pipelineRunSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  status: pipelineRunStatusSchema,
  // Run kind (rolling_diff, campaign_audit, …): additive, 2026-09-02, so clients
  // stop joining it from /queue-status.
  kind: z.string().optional(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export const pipelineRunsResponseSchema = z.object({
  campaignId: z.string(),
  runs: z.array(pipelineRunSchema),
});

export type PipelineRunsResponse = z.infer<typeof pipelineRunsResponseSchema>;

// Optional filters on GET /api/pipeline/campaigns/:campaignId/runs (2026-09-30, additive). Without them the
// route lists every run of the campaign, newest first, exactly as before. `limit` keeps the newest N;
// `runId` returns only that run (an empty list when it is not this campaign's). The web's Runs view shows
// only the latest run and its run drawer watches one run, yet both polled the whole history every 2-3 s
// while a run was live: 1,183 runs, about 480 KB a poll, on a large campaign.
export const pipelineRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  runId: z.string().min(1).max(200).optional(),
});

export type PipelineRunsQuery = z.infer<typeof pipelineRunsQuerySchema>;

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

export const cancelPipelineRunResponseSchema = pipelineRunsResponseSchema;
export type CancelPipelineRunResponse = z.infer<typeof cancelPipelineRunResponseSchema>;

// ── Story-so-far recap ───────────────────────────────────────────────────────
// Manual-trigger-only pipeline kind "recap": POST enqueues, GET polls the
// latest run. The recap markdown lives in the run's detailsJson.summary.
export const enqueueRecapResponseSchema = z.object({
  runId: z.string(),
  campaignId: z.string(),
  sessionId: z.string(),
  status: z.literal("queued"),
});
export type EnqueueRecapResponse = z.infer<typeof enqueueRecapResponseSchema>;

export const recapStatusResponseSchema = z.object({
  runId: z.string().nullable(),
  status: pipelineRunStatusSchema.nullable(),
  recap: z.string().nullable(),
  error: z.string().nullable(),
  requestedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type RecapStatusResponse = z.infer<typeof recapStatusResponseSchema>;

// ── Campaign Audit ───────────────────────────────────────────────────────────
// Full-history reconciliation, no watermarks. QUICK = coherence map-reduce +
// adversarial tail; FULL = whole-transcript coverage sweep first. Findings
// auto-apply behind refute-first verification; the report is a result, not a
// gate.
export const campaignAuditModeSchema = z.enum(["quick", "full"]);
export type CampaignAuditMode = z.infer<typeof campaignAuditModeSchema>;

export const enqueueCampaignAuditRequestSchema = z.object({
  mode: campaignAuditModeSchema,
  // Explicit dialog pick; omitted → the Engine panel's auditModel dial.
  modelId: z.string().trim().min(1).max(160).optional(),
  // The session whose Engine dials resolve the defaults (world-tick lesson —
  // dials are per-session overrides). Omitted → campaign-level defaults.
  sessionId: z.string().optional(),
});
export type EnqueueCampaignAuditRequest = z.infer<typeof enqueueCampaignAuditRequestSchema>;

export const campaignAuditReportSchema = z.object({
  analysis: z.string().nullable(),
  applied: z.object({
    creates: z.number().int(),
    updates: z.number().int(),
    disables: z.number().int(),
  }),
  appliedDetails: z.array(z.object({
    op: z.string(),
    entryId: z.string().nullable(),
    name: z.string(),
  })).default([]),
  held: z.array(z.object({
    opClass: z.string(),
    count: z.number().int(),
    reason: z.string(),
  })).default([]),
  refuted: z.array(z.object({
    finding: z.string(),
    reason: z.string(),
  })).default([]),
  ambiguous: z.array(z.string()).default([]),
  stats: z.object({
    findings: z.number().int(),
    phase1Chunks: z.number().int(),
    phase2Clusters: z.number().int(),
    messagesRead: z.number().int(),
    entriesRead: z.number().int(),
    // Offscreen-coherence pass (2026-07-17): provisional entries reconciled
    // against the offscreen timeline (superseded/merged). Default keeps old
    // reports parseable.
    offscreenReconciled: z.number().int().default(0),
    // Transcript-evidence search cost (2026-09-27): the synchronous FTS search
    // once froze the worker loop for 8 minutes; the report makes it visible.
    evidenceSearches: z.number().int().default(0),
    evidenceMs: z.number().int().default(0),
    evidenceMaxMs: z.number().int().default(0),
  }),
  // Measured LLM cost of the run (bridge = $0 marginal; the value is runtime +
  // Max-window pressure). elapsedMs is wall-clock start→finish; tok/s is derived
  // client-side. Older runs predating usage capture report zeros.
  usage: z.object({
    calls: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cacheReadTokens: z.number().int(),
    elapsedMs: z.number().int(),
  }).default({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, elapsedMs: 0 }),
  // Present when the run resumed from a checkpoint (transient-requeue or
  // seeded from a prior failed run) — surfaced so a resumed report is honest.
  resumedFrom: z.string().nullable().default(null),
});
export type CampaignAuditReport = z.infer<typeof campaignAuditReportSchema>;

export const campaignAuditStatusResponseSchema = z.object({
  runId: z.string().nullable(),
  status: pipelineRunStatusSchema.nullable(),
  mode: campaignAuditModeSchema.nullable(),
  modelId: z.string().nullable(),
  auto: z.boolean().default(false),
  progress: z.object({
    stage: z.string(),
    current: z.number().int(),
    total: z.number().int(),
  }).nullable(),
  report: campaignAuditReportSchema.nullable(),
  error: z.string().nullable(),
  requestedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type CampaignAuditStatusResponse = z.infer<typeof campaignAuditStatusResponseSchema>;

// ── Audit findings review queue ──────────────────────────────────────────────
// The audit's ambiguous residue, persisted structurally for owner rulings.
// Free-text rulings submit back to an `audit_ruling` executor run that
// translates them into revisioned lorebook ops (or bounces with a question).
export const auditFindingStatusSchema = z.enum(["open", "processing", "ruled"]);
export type AuditFindingStatus = z.infer<typeof auditFindingStatusSchema>;

export const auditFindingSchema = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.string(),
  summary: z.string(),
  detail: z.string().nullable(),
  reason: z.string().nullable(),
  entryIds: z.array(z.string()).default([]),
  // Resolved server-side for display; an entry deleted since flag time simply
  // drops out of the list.
  entryNames: z.array(z.string()).default([]),
  status: auditFindingStatusSchema,
  ruling: z.string().nullable(),
  executorQuestion: z.string().nullable(),
  outcome: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ruledAt: z.string().nullable(),
});
export type AuditFinding = z.infer<typeof auditFindingSchema>;

export const auditFindingsResponseSchema = z.object({
  findings: z.array(auditFindingSchema),
  openCount: z.number().int(),
  processing: z.boolean(),
});
export type AuditFindingsResponse = z.infer<typeof auditFindingsResponseSchema>;

// A submit carries 1 to 50 rulings, each 1 to 4,000 characters after trimming. The web dialog checks both before it
// sends (it submits the first 50 ready rulings and holds an over-long one), and the route's 400 names the cap or the
// ruling a request broke.
export const AUDIT_RULINGS_PER_SUBMIT_MAX = 50;
export const AUDIT_RULING_MAX_CHARS = 4000;

export const submitAuditRulingsRequestSchema = z.object({
  rulings: z.array(z.object({
    findingId: z.string().min(1),
    ruling: z.string().trim().min(1).max(AUDIT_RULING_MAX_CHARS),
  })).min(1).max(AUDIT_RULINGS_PER_SUBMIT_MAX),
  // Resolves the Engine dials (auditModel/embeddingModel) through this session,
  // matching the audit-enqueue convention.
  sessionId: z.string().optional(),
});
export type SubmitAuditRulingsRequest = z.infer<typeof submitAuditRulingsRequestSchema>;

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

// The pipeline_run_artifacts read contract (kind / artifact / response schemas)
// was dropped 2026-09-02 with the rest of the artifacts plumbing: the table has
// had no writer since the 2026-07-10 campaign-review sunset and its
// last reader was the Android context modal. The table itself stays until the
// next dead-column sweep.
