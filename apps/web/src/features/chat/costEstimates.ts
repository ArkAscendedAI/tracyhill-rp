import type { ChatMessage, SessionStats } from "@tracyhill-rp/contracts";
import { estimateHelperOverheadUsd, type ChatModel } from "@tracyhill-rp/model-catalog";

// Helper-overhead pricing and the wording of the cost readouts' basis.
//
// What the rows persist decides what can be priced honestly:
// - a message row carries `usage` (incl. `speed`) and `fastMode`, but NOT the
//   cache TTL the turn ran with — so history is priced at the session's CURRENT
//   TTL dial and the readouts say so (the server's sessionStats.messageCost does
//   the same, `packages/contracts/src/chat.ts` sessionStatsSchema);
// - an overhead entry (researcher/HyDE/antagonist/contest/presence normalizer,
//   rolling diff) carries `{source, modelId, inputTokens, outputTokens}` and no
//   speed/tier — so a helper call is priced at standard rates, while the
//   long-context tier IS derivable from its prompt size and is applied here
//   through the shared estimator (the local base-rate product it replaced
//   ignored it). Persisting the helper's applied speed would be a server/contract
//   change. Since 2026-09-30
//   the server prices its sessionStats overhead figures
//   with the same catalog function, estimateHelperOverheadUsd, and the status
//   bar adds those figures (sessionOverheadCost) instead of pricing any itself.
export type OverheadEntry = { source: string; modelId: string; inputTokens: number; outputTokens: number };

export function sumOverheadCost(messages: ChatMessage[], rollingDiffOverhead: OverheadEntry[]): number | null {
  const all: OverheadEntry[] = [...rollingDiffOverhead];
  for (const m of messages) {
    if (m.overhead) all.push(...m.overhead);
  }
  // The server's rule, from the same catalog function (unpriced models add nothing).
  return estimateHelperOverheadUsd(all);
}

/**
 * The session's whole helper overhead: the server's two figures (per-message helpers and the
 * rolling diff, both priced by the catalog's estimateHelperOverheadUsd), so the client prices
 * nothing itself. The loaded window is priced here only when a
 * response carries no stats.
 */
export function sessionOverheadCost(sessionStats: SessionStats | null | undefined, messages: ChatMessage[], rollingDiffOverhead: OverheadEntry[]): number | null {
  return sessionStats
    ? addCosts(sessionStats.overheadCost, sessionStats.rollingDiffOverheadCost ?? null)
    : sumOverheadCost(messages, rollingDiffOverhead);
}

export function addCosts(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

const CACHE_TTL_LABELS: Record<"off" | "5m" | "1h", string> = { off: "Off", "5m": "5 min", "1h": "1 hr" };
const RECORDED_FACTS = "fast mode as the provider applied it, long-context tier by prompt size";

/** Tooltip for one message's "~$" figure. */
export function describeMessageCostBasis(model: ChatModel | null, cacheTtl: "off" | "5m" | "1h"): string {
  if (model?.supportsCacheTtl) {
    return `Estimate at the session's CURRENT cache TTL (${CACHE_TTL_LABELS[cacheTtl]}) — the TTL this turn ran with is not recorded, so changing the Cache dial re-prices history; ${RECORDED_FACTS}.`;
  }
  return `Estimate from recorded usage (${RECORDED_FACTS}).`;
}

/** Tooltip for the status bar's whole-session figure. */
export function describeSessionCostBasis(sessionModelSupportsCacheTtl: boolean, cacheTtl: "off" | "5m" | "1h"): string {
  const messages = sessionModelSupportsCacheTtl
    ? `message cost at the session's current cache TTL (${CACHE_TTL_LABELS[cacheTtl]} — the per-turn TTL is not recorded, so changing the Cache dial re-prices history)`
    : "message cost from recorded usage";
  return `Estimate: ${messages}, plus helper overhead at standard rates (a helper's fast tier is not recorded; long-context tier by prompt size).`;
}
