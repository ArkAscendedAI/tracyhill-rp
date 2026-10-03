import type { LorebookRepository } from "../context/lorebookRepository";

// Offscreen-flow helpers (2026-07-17). Offscreen world-tick events live as
// `events` lorebook entries whose comment carries machine markers
// {offscreen, provisional, ...}. This module is the single reader/writer of
// those markers so the tick worker, the per-turn offscreen-memory block, the
// rolling diff's graduate path, and the audit's offscreen-coherence pass all
// agree on what "active offscreen canon" means:
//   active      = enabled + provisional (the current offscreen truth)
//   superseded  = disabled with supersededBy (replaced by a newer event)
//   established = confirmed by live play (provisional stripped; ordinary canon)

export interface OffscreenMarker {
  offscreen?: boolean;
  provisional?: boolean;
  sourceTickId?: string;
  visibility?: string;
  window?: string;
  supersededBy?: string;
  confirmedAt?: string;
  [key: string]: unknown;
}

/** The comment's offscreen marker, or null. Only a literal `"offscreen": true` makes one:
 *  this read `offscreen` as truthy, so a hand-edited or imported `{"offscreen":1}` or even `{"offscreen":"false"}`
 *  was offscreen canon here while both clients (web `worldMarkerOf`, Android `parseWorldMarker`) showed a plain note.
 *  Every automated writer emits booleans (`worldApply.ts`, the rewrites below, the consolidation's carried comments). */
export function parseOffscreenMarker(comment: string | null | undefined): OffscreenMarker | null {
  if (!comment) return null;
  try {
    const parsed = JSON.parse(comment) as OffscreenMarker;
    return parsed && typeof parsed === "object" && parsed.offscreen === true ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether a marker is PROVISIONAL, the active ledger's state: only a literal `"provisional": true`, as both clients
 *  read it. The one test every reader uses, in the API and the worker; never `marker?.provisional`. */
export function isProvisionalMarker(marker: OffscreenMarker | null | undefined): marker is OffscreenMarker & { provisional: true } {
  return marker?.provisional === true;
}

export interface OffscreenEntry {
  id: string;
  name: string;
  content: string;
  knownBy: string[];
  window: string | null;
  createdAt: string;
}

type LorebookRow = {
  id: string;
  name: string;
  content: string;
  comment: string | null;
  knownBy: string | null;
  isEnabled: number;
  isConstant: number;
  tag: string | null;
  createdAt: string;
};

/** The ACTIVE offscreen ledger: enabled provisional entries, newest first.
 *  This is what "already happened behind the scenes" means everywhere. */
export function listActiveOffscreen(lorebook: LorebookRepository, userId: string, campaignId: string): OffscreenEntry[] {
  const rows = lorebook.listEnabledForCampaign(userId, campaignId) as LorebookRow[];
  const out: OffscreenEntry[] = [];
  for (const row of rows) {
    if (row.tag !== "events" || row.isConstant) continue;
    const marker = parseOffscreenMarker(row.comment);
    if (!isProvisionalMarker(marker)) continue;
    let knownBy: string[] = [];
    try { knownBy = row.knownBy ? (JSON.parse(row.knownBy) as string[]) : []; } catch { /* unscoped */ }
    out.push({
      id: row.id,
      name: row.name,
      content: row.content,
      knownBy: Array.isArray(knownBy) ? knownBy : [],
      window: typeof marker.window === "string" ? marker.window : null,
      createdAt: row.createdAt,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One line per ledger event for LLM prompts: id, window, knowers, summary. */
export function renderOffscreenLedger(entries: OffscreenEntry[], maxChars = 12_000): { block: string; truncated: number } {
  const lines: string[] = [];
  let used = 0;
  let truncated = 0;
  for (const entry of entries) {
    const summary = entry.name.replace(/^Offscreen — /, "");
    const line = `- [id=${entry.id}] (${entry.window ?? "?"}; known to: ${entry.knownBy.join(", ") || "unscoped"}) ${summary}`;
    if (used + line.length > maxChars) { truncated++; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  if (truncated > 0) lines.push(`(+${truncated} older offscreen events omitted for space — they still happened)`);
  return { block: lines.join("\n"), truncated };
}

/** Mark `oldId` replaced by `newId`: disabled (revisioned via the repository
 *  chokepoint) and stamped supersededBy, so the ledger always has exactly one
 *  current entry per offscreen fact.
 *
 *  `campaignId`: `findById` is USER-scoped, and the manual
 *  review path forwards the client's `supersedesEntryId` verbatim — without this
 *  check an edited apply on campaign A could disable a provisional entry of the
 *  same user's campaign B and chain it across campaigns. When given, a row from
 *  another campaign is refused. */
export function supersedeOffscreenEntry(lorebook: LorebookRepository, userId: string, oldId: string, newId: string, campaignId?: string | null): boolean {
  const row = lorebook.findById(userId, oldId) as (LorebookRow & { campaignId?: string | null }) | undefined;
  if (!row) return false;
  if (campaignId && row.campaignId !== campaignId) return false;
  const marker = parseOffscreenMarker(row.comment);
  if (!isProvisionalMarker(marker)) return false;
  const now = new Date().toISOString();
  lorebook.update(userId, oldId, {
    isEnabled: 0,
    comment: JSON.stringify({ ...marker, provisional: false, supersededBy: newId }),
    updatedAt: now,
  } as never);
  return true;
}

/** Graduate a witnessed offscreen event into ordinary established canon: the
 *  transcript now shows/references it, so the provisional training wheels come
 *  off. The entry stays enabled and keeps its knownBy scoping; only the
 *  second-class status ends. */
export function confirmOffscreenEntry(lorebook: LorebookRepository, userId: string, entryId: string): boolean {
  const row = lorebook.findById(userId, entryId) as LorebookRow | undefined;
  if (!row) return false;
  const marker = parseOffscreenMarker(row.comment);
  if (!isProvisionalMarker(marker)) return false;
  const now = new Date().toISOString();
  lorebook.update(userId, entryId, {
    comment: JSON.stringify({ ...marker, provisional: false, confirmedAt: now }),
    updatedAt: now,
  } as never);
  return true;
}
