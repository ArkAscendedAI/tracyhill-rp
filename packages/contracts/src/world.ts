import { z } from "zod";

import { antagonistSchemeSchema } from "./drives";

// Living World Phase 2 — world tick (offscreen simulation) + scheduled beats.

const worldEventVisibilitySchema = z.enum(["hidden", "rumored", "observable"]);

export const proposedWorldEventSchema = z.object({
  actors: z.array(z.string().trim().min(1).max(200)).min(1).max(6),
  summary: z.string().trim().min(1).max(300),
  detail: z.string().trim().min(1).max(4000),
  knownBy: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  visibility: worldEventVisibilitySchema.default("hidden"),
  surfaceHints: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
  scheduledBeat: z.object({
    afterInWorld: z.string().trim().max(120),
    description: z.string().trim().min(1).max(600),
  }).nullable().default(null),
  // Offscreen-flow (2026-07-17): this event REPLACES/UPDATES a prior offscreen
  // entry (from the ledger shown to the proposer) — apply disables the old
  // entry (revisioned, marker superseded_by) so "current offscreen truth" is
  // always a single entry. The id must come from the ledger.
  supersedesEntryId: z.string().trim().max(64).nullable().default(null),
  // Offscreen progress feeds BACK into behavior: the sheet wants this event
  // satisfied or advanced. Apply decays the matching want's pressure and stamps
  // the note, so agendas and future ticks see the new state instead of
  // re-simulating it (the stagnation/duplication root fix).
  driveEffects: z.array(z.object({
    character: z.string().trim().min(1).max(200),
    wantText: z.string().trim().min(1).max(400),
    effect: z.enum(["satisfied", "advanced"]),
    note: z.string().trim().max(300).default(""),
  })).max(6).default([]),
});
export type ProposedWorldEvent = z.infer<typeof proposedWorldEventSchema>;

export const worldTickRequestSchema = z.object({
  mode: z.enum(["catchup", "skip"]),
  skip: z.object({
    value: z.number().int().min(1).max(365),
    unit: z.enum(["hours", "days", "weeks"]),
  }).optional(),
  // Manual window overrides for campaigns with unparseable in-world dates.
  // In skip mode fromOverride is the base the skip counts from; toOverride is
  // catchup-only (the target date).
  fromOverride: z.string().trim().max(120).optional(),
  toOverride: z.string().trim().max(120).optional(),
  // The session whose Engine-panel dials drive this tick. worldTickModel and
  // worldTickAutoApply are per-session overrides like every other dial; without
  // a session only campaign-level defaults apply.
  sessionId: z.string().optional(),
  // Optional GM framing for the window — what the player's character is
  // occupied with or why time passes ("the PC is unconscious the whole time").
  // Authoritative context for the proposal AND canon-check passes.
  guidance: z.string().trim().max(2000).optional(),
}).superRefine((v, ctx) => {
  if (v.mode === "skip" && !v.skip) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "skip amount required for skip mode", path: ["skip"] });
  }
});
export type WorldTickRequest = z.infer<typeof worldTickRequestSchema>;

export const worldApplyRequestSchema = z.object({
  // The (possibly edited) events the user kept in review. Empty = advance the
  // watermark with no new canon (all vetoed).
  events: z.array(proposedWorldEventSchema).max(5),
});

export const scheduledBeatSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  description: z.string(),
  afterInworld: z.string().nullable(),
  afterEpoch: z.number().int().nullable(),
  sourceEventEntryId: z.string().nullable(),
  sourceTickRunId: z.string().nullable(),
  class: z.enum(["texture", "telegraph", "complication"]),
  severity: z.number().int().min(0).max(3),
  timing: z.enum(["when_due", "fire_during_scene"]),
  citationType: z.enum(["thread", "beat", "scheme", "concealment", "none"]).nullable(),
  citationId: z.string().nullable(),
  sealed: z.boolean(),
  firedMessageId: z.string().nullable(),
  status: z.enum(["pending", "surfaced", "played", "dismissed"]),
  lifecycle: z.enum(["armed", "fired", "played", "dismissed"]),
  due: z.boolean(),
  createdAt: z.string(),
});
export type ScheduledBeat = z.infer<typeof scheduledBeatSchema>;

export const dramatistStateSchema = z.object({
  scenesSinceFire: z.number().int().min(0).default(0),
  lastRoll: z.number().int().min(1).max(100).nullable().default(null),
  lastFireAt: z.string().nullable().default(null),
  fizzleStreak: z.number().int().min(0).default(0),
  complicationCooldown: z.number().int().min(0).default(0),
});
export type DramatistState = z.infer<typeof dramatistStateSchema>;

export const dramatistProposalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("fire"),
    citationId: z.string().trim().min(1).max(300).nullable(),
    description: z.string().trim().min(1).max(1200),
    class: z.enum(["texture", "telegraph", "complication"]),
    severity: z.number().int().min(0).max(3),
    timing: z.enum(["when_due", "fire_during_scene"]),
    knownBy: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
    rationale: z.string().trim().min(1).max(1000),
  }),
  z.object({
    action: z.literal("decline"),
    reason: z.string().trim().min(1).max(1000),
  }),
]);
export type DramatistProposal = z.infer<typeof dramatistProposalSchema>;

const dramatistGrantSchema = z.object({
  kind: z.enum(["fizzle", "texture", "complication", "escalation"]),
  severity: z.number().int().min(0).max(3).nullable(),
});

export const dramatistTelemetrySchema = z.object({
  roll: z.number().int().min(1).max(100),
  bands: z.array(z.object({
    kind: z.enum(["fizzle", "texture", "complication", "escalation"]),
    severity: z.number().int().min(0).max(3).nullable(),
    min: z.number().int(),
    max: z.number().int(),
    width: z.number().int().min(0),
  })),
  modifiers: z.object({
    pressureShift: z.number().int(),
    scenesSinceFire: z.number().int().min(0),
    fizzleStreak: z.number().int().min(0),
    complicationCooldown: z.number().int().min(0),
    cooldownSuppressed: z.boolean(),
  }),
  grant: dramatistGrantSchema,
  inventorySize: z.number().int().min(0),
  selection: z.object({
    citationInventoryId: z.string().nullable(),
    citationType: z.string(),
    citationId: z.string().nullable(),
    class: z.string(),
    severity: z.number().int().min(0).max(3),
    timing: z.string(),
    description: z.string(),
    downgraded: z.boolean(),
  }).nullable(),
  gates: z.array(z.object({ lens: z.string(), ok: z.boolean(), reason: z.string() })),
  // "deduped": the proposal was accepted but
  // createIfNovel found an existing beat with the same fingerprint — nothing
  // armed, ledger/cooldown untouched, scheme step not consumed.
  outcome: z.enum(["fizzle", "decline", "rejected", "armed", "deduped"]),
  reason: z.string().nullable(),
  armedBeatId: z.string().nullable(),
  schemeAdvance: z.object({ actor: z.string(), fromStep: z.number().int(), toStep: z.number().int(), armedStepBeatId: z.string().nullable().optional() }).nullable(),
  state: dramatistStateSchema,
});

export const dramatistLogResponseSchema = z.object({
  campaignId: z.string(),
  state: dramatistStateSchema,
  ticks: z.array(z.object({
    runId: z.string(),
    status: z.enum(["queued", "running", "completed", "failed", "canceled"]),
    requestedAt: z.string(),
    completedAt: z.string().nullable(),
    error: z.string().nullable(),
    // Which LLM drove each arm of the tick — the neutral simulate pass and
    // the Dramatist adjudication respectively (owner-visible control surface).
    models: z.object({ worldTickModel: z.string().nullable(), dramatistModel: z.string().nullable() }).nullable().default(null),
    telemetry: dramatistTelemetrySchema.nullable(),
  })),
  beats: z.array(scheduledBeatSchema),
  schemes: z.array(z.object({
    characterName: z.string(),
    scheme: antagonistSchemeSchema,
    updatedAt: z.string(),
  })),
  sealedNotes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    content: z.string(),
    comment: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
});
export type DramatistLogResponse = z.infer<typeof dramatistLogResponseSchema>;

// Beat state machine (enforced server-side since 2026-09-02):
//   pending  → surfaced | played | dismissed
//   surfaced → played | dismissed | pending      (pending = release the claim)
//   played / dismissed = TERMINAL — any other target is a 409.
// Same-state writes are accepted as no-ops. All four values stay legal on the
// wire ("surfaced" = a manual claim that keeps the beat listed until it is
// played or dismissed; "pending" = release that claim) although both shipped
// clients send only "played" | "dismissed" since 2026-09-02.
export const updateBeatStatusRequestSchema = z.object({
  status: z.enum(["surfaced", "played", "dismissed", "pending"]),
});

// POST /api/world/campaigns/:campaignId/offscreen/:entryId/confirm (2026-09-02):
// graduates a provisional offscreen entry to established canon through the
// server-side marker writer (stamps confirmedAt). Both clients should use this
// instead of rewriting the comment JSON themselves.
export const confirmOffscreenResponseSchema = z.object({
  entryId: z.string(),
  confirmedAt: z.string(),
});
export type ConfirmOffscreenResponse = z.infer<typeof confirmOffscreenResponseSchema>;

export const worldTickRunSchema = z.object({
  runId: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "canceled"]),
  mode: z.enum(["catchup", "skip"]).nullable(),
  fromInWorld: z.string().nullable(),
  toInWorld: z.string().nullable(),
  guidance: z.string().nullable(),
  proposed: z.array(proposedWorldEventSchema).nullable(),
  dropped: z.array(z.object({ summary: z.string(), reason: z.string() })).nullable(),
  appliedAt: z.string().nullable(),
  appliedCount: z.number().int().nullable(),
  error: z.string().nullable(),
  requestedAt: z.string(),
});
export type WorldTickRun = z.infer<typeof worldTickRunSchema>;

export const worldStatusResponseSchema = z.object({
  campaignId: z.string(),
  worldClock: z.object({
    simulatedThrough: z.string(),
    simulatedThroughEpoch: z.number().int().nullable(),
    updatedAt: z.string(),
  }).nullable(),
  storyNow: z.object({ label: z.string(), epoch: z.number().int().nullable() }).nullable(),
  gapDays: z.number().nullable(),
  beats: z.array(scheduledBeatSchema),
  latestTick: worldTickRunSchema.nullable(),
});
export type WorldStatusResponse = z.infer<typeof worldStatusResponseSchema>;

/** `/api/world/campaigns/:id/adversarial` — phase-7 producer state (admin-only
 *  server-side). Added 2026-09-02 so the web client no longer
 *  hand-writes the shape. Mirrors `worldService.inspectAdversarial`. */
export const adversarialInspectResponseSchema = z.object({
  worldStance: z.number().int(),
  threats: z.array(z.object({ id: z.string(), sourceCharacter: z.string(), target: z.string(), statedAct: z.string(), opportunitiesRemaining: z.number().int() })),
  consequences: z.array(z.object({ id: z.string(), kind: z.string(), subject: z.string(), detail: z.string(), createdAt: z.string() })),
  clocks: z.array(z.object({ id: z.string(), name: z.string(), impulse: z.string(), filled: z.number().int(), total: z.number().int(), ownerCharacter: z.string().nullable() })),
  standings: z.array(z.object({ name: z.string(), grudge: z.number().int(), trust: z.number().int() })),
});
export type AdversarialInspectResponse = z.infer<typeof adversarialInspectResponseSchema>;
