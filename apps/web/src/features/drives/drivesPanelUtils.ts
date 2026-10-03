import type { DriveListResponse, DriveRecord, DriveSheet, DriveWant } from "@tracyhill-rp/contracts";

import { sliceUnits } from "../../shared/text/sliceUnits";

// How the editable draft should follow the selected record.
// The old effect re-seeded on EVERY identity change of the
// record — including a `drive_update` worker rewrite landing while the owner
// was mid-edit (drives are refetched on window focus), silently replacing the
// draft — and it also reset `dirty` right after `startNew()` set it, so a
// brand-new sheet showed "saved" with Save disabled.
//   reseed — a different character or campaign was selected (or the sheet
//            changed and there are no unsaved edits): load the record's sheet
//            (empty when there is none), clean.
//   new    — a different name in the SAME campaign with no record yet: empty
//            sheet, KEEP dirty as the caller (startNew) set it.
//   stale  — same character, newer record, unsaved edits: keep the draft and
//            tell the user.
//   none   — nothing to do.
// The seed carries the campaign: a sheet is
// identified by campaign AND name, so a draft seeded under campaign A is never
// treated as "the same sheet" when the panel shows the same-named character
// of campaign B — it reseeds from B's record (or to empty) instead.
export type DraftSyncPlan = "reseed" | "new" | "stale" | "none";

export function planDraftSync(input: {
  seededCampaignId: string | null;
  seededName: string | null;
  seededUpdatedAt: string | null;
  campaignId: string | null;
  selected: string | null;
  record: { updatedAt: string } | undefined;
  dirty: boolean;
}): DraftSyncPlan {
  const { seededCampaignId, seededName, seededUpdatedAt, campaignId, selected, record, dirty } = input;
  if (selected == null) return seededName == null ? "none" : "reseed";
  if (seededCampaignId != null && seededCampaignId !== campaignId) return "reseed";
  if (seededName !== selected) return record ? "reseed" : "new";
  if (!record) return "none";
  if (record.updatedAt === seededUpdatedAt) return "none";
  return dirty ? "stale" : "reseed";
}

// Sheet field paths → the labels the editor shows when a client-side parse
// against the drives contract fails: "Want #2 text must not be
// blank" instead of the server's "invalid drive sheet".
const DRIVE_FIELD_LABELS: Record<string, string> = {
  wants: "Want", goals: "Goal", redLines: "Red line", leverage: "Leverage", concealment: "Concealment",
  dispositions: "Dispositions", offpageProject: "Off-page project",
};

export function driveFieldLabel(path: ReadonlyArray<string | number>): string {
  const [head, second, third] = path;
  const base = DRIVE_FIELD_LABELS[String(head)] ?? (head == null ? "Sheet" : String(head));
  if (head === "dispositions" && typeof second === "string") return `Disposition toward ${second}`;
  if (typeof second === "number") {
    const row = `${base} #${second + 1}`;
    return typeof third === "string" ? `${row} ${third}` : row;
  }
  return base;
}

/**
 * The want line on a Cast card, by the server's agenda rule (chatService
 * `renderAgendaLine`): the most pressing REACHABLE want leads with its pressure wording, and a sheet whose wants
 * are all on hold (`blocked`: the want's object is out of the character's reach) shows its most
 * pressing held want as "on hold (out of reach for now)", never as something to act on now. The card
 * used to pick the highest pressure regardless, so an on-hold want read "wants urgently".
 */
export function agendaWantLine(wants: ReadonlyArray<DriveWant>): { label: string; text: string; onHold: boolean } | null {
  const byPressure = [...wants].sort((a, b) => b.pressure - a.pressure);
  const topWant = byPressure.find((w) => !w.blocked);
  if (topWant) return { label: `wants${topWant.pressure >= 4 ? " urgently" : topWant.pressure >= 2 ? " (mounting)" : ""}`, text: topWant.text, onHold: false };
  const heldWant = byPressure[0];
  return heldWant ? { label: "on hold (out of reach for now)", text: heldWant.text, onHold: true } : null;
}

/** The Drives list row's preview cut (UTF-16 units). */
export const DRIVES_PREVIEW_UNITS = 48;

/**
 * A Drives list row's preview (Android ports the rule and the vectors):
 * the Cast card's own want line for the sheet, so the list and the card agree. The most pressing reachable want, or
 * "on hold: <most pressing>" when every want is on hold; cut at 48 UTF-16 units with `sliceUnits` (no emoji split)
 * and "…" added when cut; "—" when the sheet has no want. It used to be the first stored want, on hold or not.
 */
export function drivesListPreview(wants: ReadonlyArray<DriveWant>): string {
  const want = agendaWantLine(wants);
  if (!want) return "—";
  const line = want.onHold ? `on hold: ${want.text}` : want.text;
  const cut = sliceUnits(line, DRIVES_PREVIEW_UNITS);
  return cut.length < line.length ? `${cut}…` : line;
}

/**
 * One line of a Cast card: `lead` is the agenda's leading clause, `held` a muted one, `line` a secondary line, and
 * `muted` the "guards a secret" line.
 */
export type CastCardLine = { text: string; kind: "lead" | "held" | "line" | "muted" };

/**
 * The lines of one character's Cast card, in order: the agenda line the composer receives (chatService
 * renderAgendaLine), less its fixed "if unengaged, pursues this" clause. A present character leads with its want
 * (agendaWantLine). A present-but-unaware character has no want line: the agenda says "quietly: <off-page project>",
 * falling back to the most pressing reachable want's text, and a character with neither reads "(present but unaware;
 * no agenda on file)" with nothing after it, so the card shows only "no agenda on file". Dispositions follow for
 * up to two characters in the scene, then "guards a secret: <the first concealment behaviour>" as a muted line, as in
 * the agenda (it was visible only in the Drives editor).
 */
export function castCardLines(name: string, sheet: Pick<DriveSheet, "wants" | "offpageProject" | "dispositions" | "concealment">, unaware: boolean, presentNames: readonly string[]): CastCardLine[] {
  const lines: CastCardLine[] = [];
  if (unaware) {
    const reachable = [...sheet.wants].sort((a, b) => b.pressure - a.pressure).find((w) => !w.blocked);
    const doing = sheet.offpageProject?.trim() || reachable?.text.trim();
    if (!doing) return [{ text: "no agenda on file", kind: "held" }];
    lines.push({ text: `quietly: ${doing}`, kind: "lead" });
  } else {
    const want = agendaWantLine(sheet.wants);
    if (want) lines.push({ text: `${want.label}: ${want.text}`, kind: want.onHold ? "held" : "lead" });
  }
  for (const [target, line] of Object.entries(sheet.dispositions).filter(([t]) => t !== name && presentNames.includes(t)).slice(0, 2)) {
    lines.push({ text: `toward ${target}: ${line}`, kind: "line" });
  }
  const guard = sheet.concealment.find((c) => c.behavior.trim().length > 0);
  if (guard) lines.push({ text: `guards a secret: ${guard.behavior.trim()}`, kind: "muted" });
  return lines;
}

export type DriveSaveInput = {
  campaignId: string;
  characterName: string;
  sheet: DriveSheet;
  /** Where the draft was seeded from (the panel's `seed`). */
  seed: { campaignId: string | null; name: string | null; updatedAt: string | null };
  /** The "changed on the server" notice is showing: this Save overwrites on purpose. */
  overwrite: boolean;
};
export type DriveSaveApi = {
  getDrives: (campaignId: string) => Promise<DriveListResponse>;
  updateDrive: (campaignId: string, characterName: string, sheet: DriveSheet) => Promise<DriveRecord>;
  /** Put a fresh read into the panel's cache (the sync effect raises the notice from it). */
  adopt: (campaignId: string, fresh: DriveListResponse) => void;
};

/**
 * The panel's Save, reading before it writes (the Android client does the
 * same). The owner can stay in the panel while the drive worker rewrites the sheet, and the "changed
 * on the server" notice only appeared after a refetch (window focus), so a Save could overwrite the
 * worker's newer sheet. Save now re-reads the campaign's sheets, puts them in the cache, and holds
 * (returns null) when the draft sync marks the draft stale: the server sheet's updatedAt differs from
 * the one the draft was seeded from, or a sheet of that name appeared under a new draft. The sync
 * effect then shows the notice from the fresh read; a second Save with the notice showing overwrites
 * on purpose and skips the check. A sheet deleted meanwhile is not stale, so the Save recreates it.
 */
export async function saveDriveSheetChecked(input: DriveSaveInput, api: DriveSaveApi): Promise<DriveRecord | null> {
  if (!input.overwrite) {
    const fresh = await api.getDrives(input.campaignId);
    api.adopt(input.campaignId, fresh);
    const record = fresh.drives.find((d) => d.characterName === input.characterName);
    const plan = planDraftSync({
      seededCampaignId: input.seed.campaignId, seededName: input.seed.name, seededUpdatedAt: input.seed.updatedAt,
      campaignId: input.campaignId, selected: input.characterName, record, dirty: true,
    });
    if (plan === "stale") return null;
  }
  return api.updateDrive(input.campaignId, input.characterName, input.sheet);
}
