import type { LorebookEntry } from "@tracyhill-rp/contracts";

export interface ScoredCandidate {
  entry: LorebookEntry;
  score: number;
  source: "constant" | "sticky" | "keyword" | "semantic" | "researcher" | "scene-present";
}

export interface PrunedResult {
  included: ScoredCandidate[];
  dropped: ScoredCandidate[];
  totalTokens: number;
}

export function pruneByBudget(candidates: ScoredCandidate[], budgetTokens: number): PrunedResult {
  // Sort: constants first (score 1000), then by score descending
  const sorted = [...candidates].sort((a, b) => {
    if (a.source === "constant" && b.source !== "constant") return -1;
    if (b.source === "constant" && a.source !== "constant") return 1;
    return b.score - a.score;
  });

  const included: ScoredCandidate[] = [];
  const dropped: ScoredCandidate[] = [];
  let totalTokens = 0;

  for (const candidate of sorted) {
    const cost = candidate.entry.tokensEstimate;
    if (totalTokens + cost <= budgetTokens || candidate.source === "constant") {
      included.push(candidate);
      totalTokens += cost;
    } else {
      dropped.push(candidate);
    }
  }

  return { included, dropped, totalTokens };
}
