import type { CodexSessionResponse, CodexThreadItem, CodexTurn } from "@tracyhill-rp/contracts";
import type { CodexEventState, CodexLiveTurn } from "./codexEvents";

import { sliceUnits, tailUnits } from "../../shared/text/sliceUnits";

/**
 * The rolling tail a running command shows (the full output renders once it completes): the last `maxChars` units,
 * started after the first newline in them when there is one, and never inside an emoji (moved here from
 * CodexTranscript for its test).
 */
export function tailClamp(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, clamped: false, hiddenChars: 0 };
  const slice = tailUnits(text, maxChars);
  const firstNewline = slice.indexOf("\n");
  const aligned = firstNewline > 0 && firstNewline < slice.length - 1 ? slice.slice(firstNewline + 1) : slice;
  return { text: aligned, clamped: true, hiddenChars: text.length - aligned.length };
}

/** The flash after a `!` shell command finishes, naming the start of the command without splitting an emoji. */
export function shellFinishedMessage(command: string): string {
  return `Shell command finished · ${sliceUnits(command, 80)}`;
}

const mergedTurns = new WeakMap<CodexTurn, { live?: CodexLiveTurn; value: CodexLiveTurn }>();

/** Native turns establish ordering and complete items; a replay tail is an overlay. */
export function mergeCodexTurns(threadId: string, native: CodexTurn[], live: CodexLiveTurn[]): CodexLiveTurn[] {
  const byId = new Map(live.map(turn => [turn.id, turn]));
  const result = native.map(turn => {
    const overlay = byId.get(turn.id);
    byId.delete(turn.id);
    const cached = mergedTurns.get(turn);
    if (cached && cached.live === overlay) return cached.value;
    const additions = new Map((overlay?.items ?? []).flatMap(item => item.id ? [[item.id, item] as const] : []));
    const items = turn.items.map(item => {
      const update = item.id ? additions.get(item.id) : undefined;
      if (item.id) additions.delete(item.id);
      return update ? mergeItem(item, update, overlay?.itemStates?.[item.id!]) : item;
    });
    items.push(...additions.values(), ...(overlay?.items ?? []).filter(item => !item.id));
    const value: CodexLiveTurn = {
      id: turn.id, threadId, items,
      status: overlay?.statusKnown ? overlay.status : turn.status,
      statusKnown: true,
      error: overlay?.statusKnown ? overlay.error : turn.error?.message ?? null,
      plan: overlay?.plan ?? null, diff: overlay?.diff ?? "", itemStates: overlay?.itemStates,
    };
    mergedTurns.set(turn, { live: overlay, value });
    return value;
  });
  return [...result, ...byId.values()];
}

function mergeItem(native: CodexThreadItem, live: CodexThreadItem, state?: "partial" | "started" | "completed"): CodexThreadItem {
  if (state === "completed") return { ...native, ...live };
  // Native deltas have no offsets. A bounded tail can start halfway through an
  // item, and the snapshot can already contain some of that tail. Concatenating
  // or guessing overlaps corrupts repeated text. Retain the full snapshot until
  // item/completed; wholly new live items still stream immediately.
  if (state !== "started") return { ...live, ...native };
  const result = { ...native, ...live };
  for (const field of ["text", "aggregatedOutput"] as const) {
    const before = native[field]; const after = live[field];
    if (typeof before === "string" && typeof after === "string" && !after.startsWith(before)) result[field] = before;
  }
  if (native.type === "reasoning") {
    for (const field of ["summary", "content"] as const) {
      const before = native[field]; const after = live[field];
      if (Array.isArray(before) && Array.isArray(after)) result[field] = Array.from({ length: Math.max(before.length, after.length) }, (_, index) => {
        const oldText = before[index] ?? ""; const newText = after[index] ?? "";
        return typeof oldText === "string" && typeof newText === "string" && !newText.startsWith(oldText) ? oldText : newText;
      });
    }
  }
  return result;
}

export function activeCodexTurn(detail: CodexSessionResponse | undefined, live: CodexEventState): string | null {
  if (live.activeTurnId !== undefined) return live.activeTurnId;
  return detail?.runtime.activeTurnId ?? null;
}

export function codexContextLeft(usage: Record<string, unknown> | null | undefined): number | null {
  const last = usage?.last as Record<string, unknown> | undefined;
  const used = last?.totalTokens;
  const window = usage?.modelContextWindow;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || typeof window !== "number" || !Number.isFinite(window) || window <= 0) return null;
  return Math.max(0, Math.min(100, 100 - used / window * 100));
}

export function codexGoal(value: Record<string, unknown> | null) {
  const inner = value?.goal ?? value;
  if (!inner || typeof inner !== "object") return null;
  const goal = inner as Record<string, unknown>;
  const objective = goal.objective ?? goal.text ?? goal.summary;
  if (typeof objective !== "string" || !objective) return null;
  return { objective, status: typeof goal.status === "string" ? goal.status : null, tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : null, tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null, timeUsedSeconds: typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : null };
}
