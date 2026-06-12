import { createHash } from "node:crypto";

import { getEmbeddingModel } from "@tracyhill-rp/model-catalog";

import { createId } from "../../lib/ids";
import { recordSystemEvent } from "../system/systemEvents";
import { encodeVector } from "./vectorIo";
import type { LorebookEmbeddingRepository } from "./lorebookEmbeddingRepository";

export type EmbeddingTask = "document" | "query";

export interface EmbeddingProvider {
  embed(texts: string[], model: string, task?: EmbeddingTask): Promise<number[][]>;
  dimensions(model: string): number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly apiKey: string) {}

  async embed(texts: string[], model: string): Promise<number[][]> {
    const modelId = model.replace("openai:", "");
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts, model: modelId }),
    });
    if (!resp.ok) throw new Error(`OpenAI embeddings error: ${resp.status} ${await resp.text()}`);
    const json = await resp.json() as { data: { embedding: number[] }[] };
    return json.data.map(d => d.embedding);
  }

  dimensions(model: string): number {
    return getEmbeddingModel(model)?.dimensions ?? 1536;
  }
}

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly apiKey: string) {}

  async embed(texts: string[], model: string, task?: EmbeddingTask): Promise<number[][]> {
    const modelId = model.replace("google:", "");
    const dims = this.dimensions(model);
    const taskType = task === "document" ? "RETRIEVAL_DOCUMENT" : task === "query" ? "RETRIEVAL_QUERY" : undefined;
    const requests = texts.map(text => ({
      model: `models/${modelId}`,
      content: { parts: [{ text }] },
      outputDimensionality: dims,
      ...(taskType ? { taskType } : {}),
    }));
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:batchEmbedContents?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!resp.ok) throw new Error(`Google embeddings error: ${resp.status} ${await resp.text()}`);
    const json = await resp.json() as { embeddings: { values: number[] }[] };
    return json.embeddings.map(e => e.values);
  }

  dimensions(model: string): number {
    return getEmbeddingModel(model)?.dimensions ?? 3072;
  }
}

export interface ProviderKeyLookup {
  findByUserAndProvider(userId: string, provider: string): { apiKey: string } | undefined;
}

export class EmbeddingService {
  constructor(
    private readonly embeddings: LorebookEmbeddingRepository,
    private readonly providers: Map<string, EmbeddingProvider>,
    private readonly providerKeyLookup?: ProviderKeyLookup,
  ) {}

  private resolveProvider(model: string, userId?: string): EmbeddingProvider | null {
    // Per-user key wins. Construct fresh per-call so we never share keys across users.
    // The this.providers Map is reserved for env-level fallback providers seeded at app start.
    const prefix = model.split(":")[0] ?? "";
    if (userId && this.providerKeyLookup) {
      const row = this.providerKeyLookup.findByUserAndProvider(userId, prefix);
      if (row?.apiKey) {
        if (prefix === "openai") return new OpenAIEmbeddingProvider(row.apiKey);
        if (prefix === "google") return new GoogleEmbeddingProvider(row.apiKey);
        return null;
      }
    }
    return this.providers.get(prefix) ?? null;
  }

  async embedQuery(text: string, model: string, userId?: string): Promise<Float32Array | null> {
    const provider = this.resolveProvider(model, userId);
    if (!provider) return null;
    try {
      const results = await provider.embed([text], model, "query");
      if (!results[0]) return null;
      return new Float32Array(results[0]);
    } catch (err) {
      // No-silent-failures: surface the provider outage, then rethrow so the
      // caller decides how to degrade (contextEngine falls back to keyword-only).
      if (userId) {
        recordSystemEvent({
          userId,
          source: "embed_query",
          severity: "error",
          message: `query embedding failed (${model}): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      // Tag so downstream catches know this failure is already recorded
      // (one outage used to produce two error rows per throttle window).
      if (err instanceof Error) (err as Error & { systemEventRecorded?: boolean }).systemEventRecorded = true;
      throw err;
    }
  }

  async indexEntries(entries: { id: string; userId: string; content: string }[], model: string): Promise<number> {
    const userId = entries[0]?.userId;
    const provider = this.resolveProvider(model, userId);
    if (!provider || entries.length === 0) return 0;
    const dims = provider.dimensions(model);
    let indexed = 0;

    for (let i = 0; i < entries.length; i += 32) {
      const batch = entries.slice(i, i + 32);
      const texts = batch.map(e => e.content);
      let vectors: number[][];
      try {
        vectors = await provider.embed(texts, model, "document");
      } catch (err) {
        // No-silent-failures: record, then rethrow — callers treat a partial
        // index as a failure and surface it.
        if (userId) {
          recordSystemEvent({
            userId,
            source: "embed_index",
            severity: "error",
            message: `entry embedding failed (${model}, batch ${i / 32 + 1}): ${err instanceof Error ? err.message : String(err)}`,
            details: { indexedBeforeFailure: indexed, totalRequested: entries.length },
          });
        }
        throw err;
      }

      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j]!;
        const vector = vectors[j];
        if (!vector) continue;
        const contentHash = hashContent(entry.content);
        this.embeddings.upsert({
          id: createId(),
          entryId: entry.id,
          userId: entry.userId,
          model,
          dimensions: dims,
          vector: encodeVector(vector),
          contentHash,
          createdAt: new Date().toISOString(),
        });
        indexed++;
      }
    }
    return indexed;
  }

  getStatus(userId: string, campaignId: string, model: string) {
    return this.embeddings.countStatus(userId, campaignId, model);
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
