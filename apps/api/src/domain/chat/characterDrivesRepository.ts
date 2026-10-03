import { and, desc, eq, inArray } from "drizzle-orm";

import { campaigns, characterDrives, characterDrivesHistory, type DatabaseClient } from "@tracyhill-rp/db";
import { antagonistSchemeSchema, clampDriveSheet, driveSheetSchema, type AntagonistScheme, type DriveSheet, type DriveRecord } from "@tracyhill-rp/contracts";
import { createId } from "../../lib/ids";
import { recordSystemEvent } from "../system/systemEvents";

type DriveSource = "wizard" | "backfill" | "worker" | "user" | "dramatist" | "scheme_seed" | "repair";

export interface DriveUpsertInput {
  campaignId: string;
  characterName: string;
  sheet: DriveSheet;
  turn: number | null;
  messageId: string | null;
  source: DriveSource;
  sealed?: boolean;
  scheme?: AntagonistScheme | null;
  reason?: string | null;
  recordHistory: boolean;
}

type DriveRow = typeof characterDrives.$inferSelect;

// Tolerant parse: a malformed column falls back to the field's empty default
// rather than throwing mid-turn (agenda assembly must never crash a chat turn).
// The fallback is REPORTED through `onMalformed` — a corrupt sheet silently
// vanishing from <character_agendas> and the Drives panel was exactly the
// silent-failure class the watchdog exists for.
/** The stored columns as an unvalidated sheet (the repair tool clamps this). */
export function rawSheetFromRow(row: DriveRow): { raw: Record<string, unknown>; syntaxErrors: string[] } {
  const syntaxErrors: string[] = [];
  const parseColumn = (text: string | null, fallback: unknown): unknown => {
    try { return text ? JSON.parse(text) : fallback; }
    catch { syntaxErrors.push("invalid JSON in a drive column"); return fallback; }
  };
  return {
    raw: {
      wants: parseColumn(row.wantsJson, []),
      goals: parseColumn(row.goalsJson, []),
      redLines: parseColumn(row.redLinesJson, []),
      leverage: parseColumn(row.leverageJson, []),
      offpageProject: row.offpageProject,
      concealment: parseColumn(row.concealmentJson, []),
      dispositions: parseColumn(row.dispositionsJson, {}),
    },
    syntaxErrors,
  };
}

function rowToSheet(row: DriveRow, onMalformed: (issues: string) => void): DriveSheet {
  const { raw, syntaxErrors } = rawSheetFromRow(row);
  const parsed = driveSheetSchema.safeParse(raw);
  if (syntaxErrors.length) onMalformed(syntaxErrors.join("; "));
  if (parsed.success) return parsed.data;
  // Over-long text or lists: serve the sheet shortened to the limits instead of
  // blanking it whole (2026-09-27 — a single long want used to empty every
  // want, goal and concealment on read). The alert stays until the stored row
  // is repaired.
  const { sheet: clampedSheet, clamped } = clampDriveSheet(raw);
  const retry = driveSheetSchema.safeParse(clampedSheet);
  if (retry.success) {
    onMalformed(`over the sheet limits at ${clamped.join(", ").slice(0, 200)} — served shortened; saving the sheet in the drives editor stores it shortened`);
    return retry.data;
  }
  onMalformed(parsed.error.issues.map((i) => `${i.path.join(".") || "sheet"}: ${i.message}`).join("; ").slice(0, 300));
  return driveSheetSchema.parse({});
}

function sheetToColumns(sheet: DriveSheet) {
  return {
    wantsJson: JSON.stringify(sheet.wants),
    goalsJson: JSON.stringify(sheet.goals),
    redLinesJson: JSON.stringify(sheet.redLines),
    leverageJson: JSON.stringify(sheet.leverage),
    offpageProject: sheet.offpageProject ?? null,
    concealmentJson: JSON.stringify(sheet.concealment),
    dispositionsJson: JSON.stringify(sheet.dispositions),
  };
}

export class CharacterDrivesRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  private rowToRecord = (row: DriveRow): DriveRecord => {
    const scheme = row.schemeJson ? antagonistSchemeSchema.safeParse(safeJson(row.schemeJson, null)) : null;
    return {
      campaignId: row.campaignId,
      characterName: row.characterName,
      sheet: rowToSheet(row, (issues) => this.reportMalformedSheet(row, issues)),
      sealed: row.sealed === 1,
      scheme: scheme?.success ? scheme.data : null,
      lastUpdatedTurn: row.lastUpdatedTurn ?? null,
      lastUpdatedMessageId: row.lastUpdatedMessageId ?? null,
      source: row.source,
      updatedAt: row.updatedAt,
    };
  };

  // Drive rows are campaign-keyed with no user scoping; resolve the owner from
  // the campaign so the event lands in that user's indicator. Recording never
  // throws (recordSystemEvent swallows), and the recorder throttles repeats.
  //
  // Deferred past the current synchronous call stack:
  // rowToRecord runs inside the drive worker's and worldApply's transactions,
  // and in the worker process the recorder writes on ANOTHER connection — an
  // insert from inside an IMMEDIATE transaction waits out busy_timeout and
  // loses the row. A microtask runs once the transaction has committed.
  // A write that had to be shortened is handled, so it is a notice; the path
  // list says which writer produced over-long text. Deferred like the report
  // below: upserts run inside transactions.
  private reportClampedWrite(campaignId: string, characterName: string, source: string, clamped: string[]) {
    const owner = this.db.select({ userId: campaigns.userId }).from(campaigns).where(eq(campaigns.id, campaignId)).get();
    queueMicrotask(() => recordSystemEvent({
      userId: owner?.userId ?? "",
      source: "drive_update",
      severity: "info",
      message: `drive sheet for "${characterName}" was shortened to the sheet limits on write (${source}): ${clamped.join(", ").slice(0, 240)}`,
      campaignId,
      details: { characterName, source, clamped },
    }));
  }

  private reportMalformedSheet(row: DriveRow, issues: string) {
    const owner = this.db.select({ userId: campaigns.userId }).from(campaigns).where(eq(campaigns.id, row.campaignId)).get();
    queueMicrotask(() => recordSystemEvent({
      userId: owner?.userId ?? "",
      source: "drive_update",
      severity: "warn",
      message: `drive sheet for "${row.characterName}" is malformed: ${issues}`,
      campaignId: row.campaignId,
      details: { characterName: row.characterName, source: row.source, updatedAt: row.updatedAt },
    }));
  }

  listForCampaign(campaignId: string): DriveRecord[] {
    return this.db.select().from(characterDrives)
      .where(eq(characterDrives.campaignId, campaignId))
      .all().map(this.rowToRecord);
  }

  findByCharacter(campaignId: string, characterName: string): DriveRecord | undefined {
    const row = this.db.select().from(characterDrives)
      .where(and(eq(characterDrives.campaignId, campaignId), eq(characterDrives.characterName, characterName)))
      .get();
    return row ? this.rowToRecord(row) : undefined;
  }

  findManyByCharacter(campaignId: string, names: string[]): DriveRecord[] {
    if (names.length === 0) return [];
    return this.db.select().from(characterDrives)
      .where(and(eq(characterDrives.campaignId, campaignId), inArray(characterDrives.characterName, names)))
      .all().map(this.rowToRecord);
  }

  // Row + history in ONE transaction, because every mutating write appends
  // history: a busy-DB failure between the two statements left a sheet change
  // with no history row to revert to.
  upsert(input: DriveUpsertInput): void {
    this.db.transaction(() => this.upsertInTransaction(input));
  }

  private upsertInTransaction(input: DriveUpsertInput): void {
    const now = new Date().toISOString();
    const existing = this.findByCharacter(input.campaignId, input.characterName);
    // The write chokepoint stores only sheets within the limits (2026-09-27):
    // over-long text is shortened here and says so; anything still invalid is
    // refused loudly instead of stored for the reader to blank.
    const { sheet: clampedSheet, clamped } = clampDriveSheet(input.sheet);
    const checked = driveSheetSchema.safeParse(clampedSheet);
    if (!checked.success) {
      throw new Error(`drive sheet for "${input.characterName}" is invalid: ${checked.error.issues.map((i) => `${i.path.join(".") || "sheet"}: ${i.message}`).join("; ").slice(0, 300)}`);
    }
    const sheet = checked.data;
    if (clamped.length > 0) this.reportClampedWrite(input.campaignId, input.characterName, input.source, clamped);
    const cols = sheetToColumns(sheet);

    if (existing) {
      this.db.update(characterDrives)
        .set({
          ...cols,
          lastUpdatedTurn: input.turn,
          lastUpdatedMessageId: input.messageId,
          source: input.source,
          ...(input.sealed !== undefined ? { sealed: input.sealed ? 1 : 0 } : {}),
          ...(input.scheme !== undefined ? { schemeJson: input.scheme ? JSON.stringify(input.scheme) : null } : {}),
          updatedAt: now,
        })
        .where(and(
          eq(characterDrives.campaignId, input.campaignId),
          eq(characterDrives.characterName, input.characterName),
        ))
        .run();
    } else {
      this.db.insert(characterDrives).values({
        campaignId: input.campaignId,
        characterName: input.characterName,
        ...cols,
        lastUpdatedTurn: input.turn,
        lastUpdatedMessageId: input.messageId,
        source: input.source,
        sealed: input.sealed ? 1 : 0,
        schemeJson: input.scheme ? JSON.stringify(input.scheme) : null,
        updatedAt: now,
      }).run();
    }

    if (input.recordHistory) {
      this.db.insert(characterDrivesHistory).values({
        id: createId(),
        campaignId: input.campaignId,
        characterName: input.characterName,
        beforeJson: JSON.stringify(existing?.sheet ?? null),
        afterJson: JSON.stringify(sheet),
        changedAtTurn: input.turn,
        changedAtMessageId: input.messageId,
        source: input.source,
        reason: input.reason ?? null,
        createdAt: now,
      }).run();
    }
  }

  // Both deletes in ONE transaction: a history delete that committed while the
  // sheet delete failed (busy database) left a sheet with no history to revert
  // to, the same failure the wrapped upsert already guards against.
  deleteForCharacter(campaignId: string, characterName: string): void {
    this.db.transaction(() => {
      this.db.delete(characterDrivesHistory)
        .where(and(eq(characterDrivesHistory.campaignId, campaignId), eq(characterDrivesHistory.characterName, characterName)))
        .run();
      this.db.delete(characterDrives)
        .where(and(eq(characterDrives.campaignId, campaignId), eq(characterDrives.characterName, characterName)))
        .run();
    });
  }

  /** Newest first. */
  history(campaignId: string, characterName: string): Array<typeof characterDrivesHistory.$inferSelect> {
    return this.db.select().from(characterDrivesHistory)
      .where(and(
        eq(characterDrivesHistory.campaignId, campaignId),
        eq(characterDrivesHistory.characterName, characterName),
      ))
      .orderBy(desc(characterDrivesHistory.createdAt))
      .all();
  }

  findHistoryEntry(campaignId: string, characterName: string, historyId: string) {
    return this.db.select().from(characterDrivesHistory)
      .where(and(
        eq(characterDrivesHistory.campaignId, campaignId),
        eq(characterDrivesHistory.characterName, characterName),
        eq(characterDrivesHistory.id, historyId),
      ))
      .get();
  }
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
