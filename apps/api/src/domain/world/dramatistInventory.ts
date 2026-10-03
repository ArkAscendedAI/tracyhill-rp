import type { DramatistProposal, DriveRecord } from "@tracyhill-rp/contracts";

import type { DramatistGrant } from "./dramatistPacing";
import type { BeatRow } from "./scheduledBeatRepository";
import { parseInWorldDate } from "./worldClock";

type DramatistCitationType = "thread" | "beat" | "scheme" | "concealment";

export type DramatistInventoryItem = {
  id: string;
  citationType: DramatistCitationType;
  citationId: string;
  label: string;
  detail: string;
  maxSeverity: 1 | 2 | 3;
  actor: string | null;
  knownBy: string[];
  sealed?: boolean;
};

type TrackerThread = {
  id?: unknown;
  title?: unknown;
  headline?: unknown;
  status?: unknown;
  summary?: unknown;
  nextBeat?: unknown;
  pendingDates?: unknown;
  involved?: unknown;
  entryId?: unknown;
};

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.map(text).filter(Boolean) : []; }
function pcSet(keys: string[]): Set<string> { return new Set(keys.map((key) => key.trim().toLocaleLowerCase()).filter(Boolean)); }

function parseThreads(comment: string | null): TrackerThread[] {
  if (!comment) return [];
  try {
    const parsed: unknown = JSON.parse(comment);
    if (!parsed || typeof parsed !== "object" || !("threads" in parsed)) return [];
    const threads = (parsed as { threads?: unknown }).threads;
    return Array.isArray(threads) ? threads.filter((thread): thread is TrackerThread => Boolean(thread && typeof thread === "object")) : [];
  } catch {
    return [];
  }
}

function dispositionTowardPc(record: DriveRecord, playerKeys: Set<string>): string {
  for (const [target, disposition] of Object.entries(record.sheet.dispositions)) {
    const normalized = target.trim().toLocaleLowerCase();
    if (playerKeys.has(normalized) || normalized === "player" || normalized === "the player") return disposition;
  }
  return "";
}

function isHostileOrAmbivalent(disposition: string): boolean {
  return /\b(hostile|enemy|hates?|resent|wary|suspicious|distrust|ambivalent|conflicted|uncertain|jealous|afraid|fearful|opposed|rival)\b/i.test(disposition);
}

/**
 * Has a scheme step's not-before date come? A step
 * without one always has. With one, only when the label reads as a calendar
 * date and story-now is known and at or past it: the rule `duePending` applies
 * to a dated beat, so an unreadable date or an unknown story-now holds the step
 * instead of letting it fire early (the tick names an unreadable date in a
 * warn event). Year-less labels anchor to story-now, nearest year.
 */
export function schemeStepDateReached(step: { notBefore?: string | null }, storyNowEpoch: number | null | undefined): boolean {
  const label = step.notBefore?.trim();
  if (!label) return true;
  if (storyNowEpoch == null) return false;
  const due = parseInWorldDate(label, storyNowEpoch);
  return due != null && due <= storyNowEpoch;
}

export function buildDramatistInventory(input: {
  threadIndexComment: string | null;
  beats: BeatRow[];
  drives: DriveRecord[];
  playerCharacterKeys: string[];
  tickOrdinal: number;
  /** Story-now as an epoch, for the scheme steps' not-before gate. */
  storyNowEpoch?: number | null;
}): DramatistInventoryItem[] {
  const items: DramatistInventoryItem[] = [];
  const players = pcSet(input.playerCharacterKeys);

  for (const thread of parseThreads(input.threadIndexComment)) {
    const id = text(thread.id);
    const status = text(thread.status).toUpperCase();
    const nextBeat = text(thread.nextBeat);
    const pendingDates = text(thread.pendingDates);
    if (!id || !["OPEN", "ACTIVE", "STALLED"].includes(status) || (!nextBeat && !pendingDates)) continue;
    const title = text(thread.title) || id;
    const detail = [text(thread.headline), text(thread.summary), nextBeat ? `Next: ${nextBeat}` : "", pendingDates ? `Fuse: ${pendingDates}` : ""].filter(Boolean).join("\n");
    items.push({
      id: `thread:${id}`,
      citationType: "thread",
      citationId: text(thread.entryId) || id,
      label: title,
      detail,
      maxSeverity: 2,
      actor: null,
      knownBy: stringList(thread.involved),
    });
  }

  for (const beat of input.beats) {
    if (beat.status !== "pending") continue;
    items.push({
      id: `beat:${beat.id}`,
      citationType: "beat",
      citationId: beat.id,
      label: `Armed beat ${beat.id}`,
      sealed: Boolean(beat.sealed),
      detail: beat.description,
      maxSeverity: Math.min(3, Math.max(1, beat.severity)) as 1 | 2 | 3,
      actor: null,
      knownBy: [],
    });
  }

  for (const record of input.drives) {
    const normalizedName = record.characterName.trim().toLocaleLowerCase();
    if (players.has(normalizedName)) continue;
    if (record.sealed && record.scheme) {
      const step = record.scheme.steps[record.scheme.currentStep];
      // A step dated ahead of story-now is not live yet: it can
      // neither fire nor advance offscreen before its date.
      if (step && input.tickOrdinal % record.scheme.cadence === 0 && schemeStepDateReached(step, input.storyNowEpoch)) {
        items.push({
          id: `scheme:${record.characterName}`,
          citationType: "scheme",
          citationId: record.characterName,
          label: `${record.characterName} scheme step ${record.scheme.currentStep + 1}`,
          detail: `${step.text}\nGrounding target: ${record.scheme.targetCitation}`,
          maxSeverity: (step.armsBeat?.severity ?? 2) as 1 | 2 | 3,
          actor: record.characterName,
          knownBy: [record.characterName],
        });
      }
      continue;
    }
    if (record.sealed) continue;
    const disposition = dispositionTowardPc(record, players);
    if (!isHostileOrAmbivalent(disposition)) continue;
    record.sheet.concealment.forEach((concealment, index) => {
      items.push({
        id: `concealment:${record.characterName}:${index}`,
        citationType: "concealment",
        citationId: `${record.characterName}:${index}`,
        label: `${record.characterName} concealment`,
        detail: `Disposition toward PC: ${disposition}\nSecret: ${concealment.secret}\nBehavior: ${concealment.behavior}`,
        maxSeverity: 1,
        actor: record.characterName,
        knownBy: [record.characterName],
      });
    });
  }

  return items;
}

export type DramatistSelectionCheck =
  | { ok: true; proposal: Extract<DramatistProposal, { action: "fire" }>; item: DramatistInventoryItem | null; downgraded: boolean }
  | { ok: false; reason: string };

export function validateDramatistSelection(
  proposal: DramatistProposal,
  grant: DramatistGrant,
  inventory: DramatistInventoryItem[],
): DramatistSelectionCheck {
  if (proposal.action === "decline") return { ok: false, reason: `declined: ${proposal.reason}` };
  if (grant.kind === "fizzle") return { ok: false, reason: "a fizzle grant cannot fire" };
  const grantSeverity = grant.severity ?? 0;
  if (proposal.severity > grantSeverity) return { ok: false, reason: `proposal severity ${proposal.severity} exceeds grant ${grantSeverity}` };
  if (grant.kind === "texture") {
    if (proposal.severity !== 0 || proposal.class !== "texture") return { ok: false, reason: "texture grants must remain class=texture severity=0" };
    if (proposal.citationId !== null && !inventory.some((item) => item.id === proposal.citationId)) return { ok: false, reason: "texture cited an inventory id that is not live" };
    return { ok: true, proposal, item: proposal.citationId ? inventory.find((item) => item.id === proposal.citationId) ?? null : null, downgraded: false };
  }
  if (proposal.severity === 0 || proposal.class === "texture") return { ok: false, reason: "complication/escalation grants cannot be emitted as texture or severity 0" };
  if (!proposal.citationId) return { ok: false, reason: "complication grants require a live citation" };
  const item = inventory.find((candidate) => candidate.id === proposal.citationId);
  if (!item) return { ok: false, reason: `citation ${proposal.citationId} is not in the live inventory` };
  if (proposal.severity <= item.maxSeverity) return { ok: true, proposal, item, downgraded: false };
  return {
    ok: true,
    proposal: { ...proposal, class: "telegraph", severity: Math.min(1, item.maxSeverity), timing: "when_due" },
    item,
    downgraded: true,
  };
}
