import type { LorebookEntry } from "@tracyhill-rp/contracts";

import { decodeVector, cosineSimilarity } from "./vectorIo";

interface EmbeddingRow {
  entryId: string;
  vector: string;
  dimensions: number;
}

export interface SemanticHit {
  entryId: string;
  score: number;
}

export function runSemanticActivation(
  queryVector: Float32Array,
  embeddings: EmbeddingRow[],
  alreadyActivated: Set<string>,
  topK: number,
  threshold: number,
): SemanticHit[] {
  const scored: SemanticHit[] = [];
  for (const row of embeddings) {
    if (alreadyActivated.has(row.entryId)) continue;
    const entryVec = decodeVector(row.vector);
    if (entryVec.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, entryVec);
    if (score >= threshold) scored.push({ entryId: row.entryId, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
