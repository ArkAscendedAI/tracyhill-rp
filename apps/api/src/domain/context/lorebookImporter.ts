import { createId } from "../../lib/ids";
import { estimateTokens } from "./lorebookTokenEstimator";
import type { LorebookRepository } from "./lorebookRepository";

interface STEntry {
  uid?: number;
  key?: string[];
  keysecondary?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  selectiveLogic?: number;
  order?: number;
  position?: number;
  disable?: boolean;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  delayUntilRecursion?: boolean | number;
  probability?: number;
  scanDepth?: number | null;
  sticky?: number | null;
  cooldown?: number | null;
  delay?: number | null;
  group?: string;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  addMemo?: boolean;
  displayIndex?: number;
  [key: string]: unknown;
}

interface STLorebook {
  entries?: Record<string, STEntry>;
  originalData?: { entries?: Record<string, STEntry> };
}

const SELECTIVE_LOGIC_MAP: Record<number, string> = {
  0: "and_any",
  1: "not_all",
  2: "not_any",
  3: "and_all",
};

const POSITION_MAP: Record<number, string> = {
  0: "before_main",
  1: "after_main",
  2: "top",
  3: "bottom",
  4: "before_main",
  5: "before_main",
};

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export function parseSillyTavernLorebook(json: unknown): { entries: STEntry[]; errors: string[] } {
  const errors: string[] = [];
  const data = json as STLorebook;
  const raw = data?.entries ?? data?.originalData?.entries;
  if (!raw || typeof raw !== "object") {
    errors.push("no entries found in lorebook JSON");
    return { entries: [], errors };
  }
  const entries = Object.values(raw).filter((e): e is STEntry => e != null && typeof e === "object");
  return { entries, errors };
}

export function importSillyTavernLorebook(
  repo: LorebookRepository,
  userId: string,
  campaignId: string,
  json: unknown,
): ImportResult {
  const { entries: stEntries, errors } = parseSillyTavernLorebook(json);
  if (stEntries.length === 0) return { imported: 0, skipped: 0, errors };
  const now = new Date().toISOString();
  const legacySource = `st-import-${now}`;
  const rows: Parameters<LorebookRepository["createMany"]>[0] = [];
  let skipped = 0;

  for (const entry of stEntries) {
    const content = (entry.content ?? "").trim();
    if (!content) { skipped++; continue; }

    const keys = Array.isArray(entry.key) ? entry.key.filter(k => typeof k === "string" && k.trim()) : [];
    const keysSecondary = Array.isArray(entry.keysecondary) ? entry.keysecondary.filter(k => typeof k === "string" && k.trim()) : [];
    const name = deriveName(entry, keys);

    const matchOptions: Record<string, boolean> = {};
    if (entry.caseSensitive) matchOptions.caseSensitive = true;
    if (entry.matchWholeWords !== false) matchOptions.matchWholeWords = true;

    rows.push({
      id: createId(),
      userId,
      campaignId,
      name,
      tag: entry.group?.trim() || null,
      content,
      comment: entry.comment?.trim() || null,
      keys: JSON.stringify(keys),
      keysSecondary: JSON.stringify(keysSecondary),
      selectiveLogic: SELECTIVE_LOGIC_MAP[entry.selectiveLogic ?? 0] ?? "and_any",
      scanDepth: entry.scanDepth ?? 4,
      position: POSITION_MAP[entry.position ?? 0] ?? "before_main",
      insertionOrder: entry.order ?? entry.displayIndex ?? 100,
      probability: entry.probability ?? 100,
      isConstant: entry.constant ? 1 : 0,
      isEnabled: entry.disable ? 0 : 1,
      sticky: entry.sticky ?? 0,
      cooldown: entry.cooldown ?? 0,
      delay: entry.delay ?? 0,
      excludeRecursion: entry.excludeRecursion ? 1 : 0,
      preventRecursion: entry.preventRecursion ? 1 : 0,
      delayUntilRecursion: entry.delayUntilRecursion ? 1 : 0,
      tokensEstimate: estimateTokens(content),
      matchOptionsJson: Object.keys(matchOptions).length > 0 ? JSON.stringify(matchOptions) : null,
      legacySource,
      createdAt: now,
      updatedAt: now,
    });
  }

  repo.createMany(rows);
  return { imported: rows.length, skipped, errors };
}

function deriveName(entry: STEntry, keys: string[]): string {
  if (entry.comment?.trim()) return entry.comment.trim().slice(0, 200);
  if (keys.length > 0) return keys.slice(0, 3).join(", ").slice(0, 200);
  return "Unnamed Entry";
}
