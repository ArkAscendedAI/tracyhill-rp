import { z } from "zod";

// Living World — NPC drive sheets. Caps are enforced here (single source of truth
// shared by the API, the drive_update worker's server-side re-validation, and UI).

export const driveWantSchema = z.object({
  id: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(400),
  // Escalation counter: reset to 0 when a scene engages the want, +1 per
  // appearance window otherwise. Rendered as urgency ("urgently; will act NOW").
  pressure: z.number().int().min(0).max(20).default(0),
  sinceTurn: z.number().int().min(0).nullable().default(null),
  // On hold (2026-09-27): the want cannot be pursued right now because its object is out of the
  // character's reach — the person is away, the thing is gone, the matter sits in someone else's hands.
  // Pressure holds instead of climbing, and the agenda never renders it as something to act on this
  // scene. An unreachable want at rising pressure is how the composer came to invent a warrant to bring
  // a character back from out of state.
  // Absent = not on hold, so every stored sheet and every existing writer stays valid.
  blocked: z.boolean().optional(),
});
export type DriveWant = z.infer<typeof driveWantSchema>;

export const driveGoalSchema = z.object({
  id: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(400),
  status: z.enum(["active", "achieved", "abandoned", "blocked"]).default("active"),
});
export type DriveGoal = z.infer<typeof driveGoalSchema>;

export const driveConcealmentSchema = z.object({
  secret: z.string().trim().min(1).max(300),
  behavior: z.string().trim().min(1).max(400),
});

// The editable sheet payload. Caps: 5 wants / 3 goals / 4 concealments / 6
// dispositions — force selectivity (a 20-want sheet is noise the model ignores).
export const driveSheetSchema = z.object({
  wants: z.array(driveWantSchema).max(5).default([]),
  goals: z.array(driveGoalSchema).max(3).default([]),
  redLines: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
  leverage: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
  offpageProject: z.string().trim().max(600).nullable().default(null),
  concealment: z.array(driveConcealmentSchema).max(4).default([]),
  dispositions: z.record(z.string().trim().max(400)).default({}),
});
export type DriveSheet = z.infer<typeof driveSheetSchema>;

// The sheet's length and count limits, mirrored from driveSheetSchema for the
// clamp below (kept beside the schema so the two cannot drift apart unnoticed:
// clampDriveSheet's tests parse every clamped sheet through the schema).
export const DRIVE_SHEET_LIMITS = {
  wants: 5, goals: 3, redLines: 6, leverage: 6, concealment: 4,
  wantText: 400, goalText: 400, lineText: 300, secret: 300, behavior: 400, offpageProject: 600, disposition: 400, id: 64,
} as const;

function clampText(value: unknown, max: number, path: string, clamped: string[]): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.length <= max) return text;
  clamped.push(path);
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function clampList(value: unknown, max: number, path: string, clamped: string[]): unknown[] | unknown {
  if (!Array.isArray(value)) return value;
  if (value.length > max) clamped.push(`${path} (${value.length} → ${max})`);
  return value.slice(0, max);
}

/**
 * Bring a sheet within the drive-sheet limits (2026-09-27): over-long text is
 * cut at a word boundary with an ellipsis and over-long lists keep their first
 * entries. Returns the new sheet and the paths it shortened; anything it cannot
 * fix (wrong types, empty text) is left for driveSheetSchema to reject.
 *
 * Why: a sheet with ONE field over its limit used to read back as an entirely
 * EMPTY sheet (the lenient reader fell back to defaults for the whole sheet);
 * one character's worker-written sheet of 2026-07-31 had been served blank
 * since the limits arrived. Readers now clamp instead, and the write chokepoint
 * stores only clamped, valid sheets.
 */
export function clampDriveSheet(raw: unknown): { sheet: unknown; clamped: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { sheet: raw, clamped: [] };
  const L = DRIVE_SHEET_LIMITS;
  const clamped: string[] = [];
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  const items = (value: unknown, max: number, path: string, each: (item: Record<string, unknown>, at: string) => Record<string, unknown>) => {
    const list = clampList(value, max, path, clamped);
    return Array.isArray(list) ? list.map((item, i) => (item && typeof item === "object" && !Array.isArray(item) ? each({ ...(item as Record<string, unknown>) }, `${path}.${i}`) : item)) : list;
  };
  if ("wants" in src) out.wants = items(src.wants, L.wants, "wants", (w, at) => ({ ...w, text: clampText(w.text, L.wantText, `${at}.text`, clamped) }));
  if ("goals" in src) out.goals = items(src.goals, L.goals, "goals", (g, at) => ({ ...g, text: clampText(g.text, L.goalText, `${at}.text`, clamped) }));
  for (const key of ["redLines", "leverage"] as const) {
    if (!(key in src)) continue;
    const list = clampList(src[key], L[key], key, clamped);
    out[key] = Array.isArray(list) ? list.map((line, i) => clampText(line, L.lineText, `${key}.${i}`, clamped)) : list;
  }
  if ("offpageProject" in src) out.offpageProject = clampText(src.offpageProject, L.offpageProject, "offpageProject", clamped);
  if ("concealment" in src) out.concealment = items(src.concealment, L.concealment, "concealment", (c, at) => ({
    ...c,
    secret: clampText(c.secret, L.secret, `${at}.secret`, clamped),
    behavior: clampText(c.behavior, L.behavior, `${at}.behavior`, clamped),
  }));
  if (src.dispositions && typeof src.dispositions === "object" && !Array.isArray(src.dispositions)) {
    out.dispositions = Object.fromEntries(Object.entries(src.dispositions as Record<string, unknown>).map(([name, text]) => [name, clampText(text, L.disposition, `dispositions.${name}`, clamped)]));
  }
  return { sheet: out, clamped };
}

/** A scheme step's not-before date: an
 *  in-world date label ("Saturday, September 13, 2008, late evening") before
 *  which the step does not move. The Dramatist's inventory skips the step while
 *  its date is ahead of story-now, and a beat a threat clock arms for the step
 *  inherits it as its after_inworld / after_epoch. Blank means no date. Absent
 *  stays absent (no default): the clock's step identity hashes the step as
 *  stored, so a default would re-key every existing countdown. */
export const SCHEME_STEP_NOT_BEFORE_MAX_CHARS = 120;
const blankIsAbsent = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const antagonistSchemeStepSchema = z.object({
  text: z.string().trim().min(1).max(800),
  armsBeat: z.object({
    description: z.string().trim().min(1).max(600),
    class: z.enum(["telegraph", "complication"]).default("telegraph"),
    severity: z.number().int().min(1).max(3).default(1),
    timing: z.enum(["when_due", "fire_during_scene"]).default("when_due"),
  }).nullable().optional(),
  notBefore: z.preprocess(blankIsAbsent, z.string().trim().min(1).max(SCHEME_STEP_NOT_BEFORE_MAX_CHARS).nullable().optional()),
});
export const antagonistSchemeSchema = z.object({
  steps: z.array(antagonistSchemeStepSchema).min(1).max(12),
  currentStep: z.number().int().min(0).default(0),
  targetCitation: z.string().trim().min(1).max(200),
  cadence: z.number().int().min(1).max(20).default(2),
});
export type AntagonistScheme = z.infer<typeof antagonistSchemeSchema>;

// Wizard drive-sheet seeds arrive from LLM generation with no length
// validation, and the caps above throw at the approval chokepoint — which
// used to 500 an entire campaign approval over one over-long string
// (2026-08-09: a 310-char red line). Normalizers, not looser caps: the caps
// exist to keep per-turn agenda blocks selective. An over-cap list string
// splits on "; " when every segment fits (a generated red line often packs
// act + held-line into one string — the array shape wants them separate);
// anything still over-cap truncates at a word boundary.
export function clampDriveSeedText(value: string, cap: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= cap) return trimmed;
  const slice = trimmed.slice(0, cap);
  const boundary = slice.lastIndexOf(" ");
  return (boundary > cap * 0.6 ? slice.slice(0, boundary) : slice).trimEnd();
}

export function normalizeDriveSeedList(items: string[] | null | undefined, cap: number, maxItems: number): string[] {
  const out: string[] = [];
  for (const raw of items ?? []) {
    const value = raw.trim();
    if (!value) continue;
    if (value.length <= cap) { out.push(value); continue; }
    const segments = value.split(/;\s+/).map((segment) => segment.trim()).filter(Boolean);
    if (segments.length > 1 && segments.every((segment) => segment.length <= cap)) out.push(...segments);
    else out.push(clampDriveSeedText(value, cap));
  }
  return out.slice(0, maxItems);
}

// dispositions cap is enforced by refinement (z.record has no .max()).
export const driveSheetInputSchema = driveSheetSchema.refine(
  (s) => Object.keys(s.dispositions).length <= 6,
  { message: "at most 6 dispositions", path: ["dispositions"] },
);

export const driveRecordSchema = z.object({
  campaignId: z.string(),
  characterName: z.string(),
  sheet: driveSheetSchema,
  sealed: z.boolean().default(false),
  scheme: antagonistSchemeSchema.nullable().default(null),
  lastUpdatedTurn: z.number().int().nullable(),
  lastUpdatedMessageId: z.string().nullable(),
  source: z.string(),
  updatedAt: z.string(),
});
export type DriveRecord = z.infer<typeof driveRecordSchema>;

export const driveListResponseSchema = z.object({
  drives: z.array(driveRecordSchema),
});
export type DriveListResponse = z.infer<typeof driveListResponseSchema>;

export const updateDriveRequestSchema = z.object({
  sheet: driveSheetInputSchema,
  reason: z.string().trim().max(240).optional(),
});

export const driveHistoryEntrySchema = z.object({
  id: z.string(),
  before: driveSheetSchema.nullable(),
  after: driveSheetSchema,
  changedAtTurn: z.number().int().nullable(),
  source: z.string(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type DriveHistoryEntry = z.infer<typeof driveHistoryEntrySchema>;

export const driveHistoryResponseSchema = z.object({
  characterName: z.string(),
  entries: z.array(driveHistoryEntrySchema),
});
export type DriveHistoryResponse = z.infer<typeof driveHistoryResponseSchema>;

export const revertDriveRequestSchema = z.object({
  historyId: z.string().trim().min(1),
});

// A carried want at this pressure has gone unengaged for this many consecutive
// drive updates; the composer renders it as "wants URGENTLY (will act on this
// now)" from here up. It is the point where a want whose premise canon has
// quietly settled turns into repeated behaviour (a lost bag one character kept
// asking after for a week, 2026-09-26): the drive worker's canon check drops such
// wants, and the agenda block notes any survivor in the turn's context notes.
export const STALE_WANT_PRESSURE = 4;
