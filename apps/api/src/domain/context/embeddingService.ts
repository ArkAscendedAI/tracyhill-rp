import { createHash } from "node:crypto";

import { getEmbeddingModel } from "@tracyhill-rp/model-catalog";

import { createId } from "../../lib/ids";
import { recordSystemEvent } from "../system/systemEvents";
import { encodeVector } from "./vectorIo";
import type { LorebookEmbeddingRepository } from "./lorebookEmbeddingRepository";

export type EmbeddingTask = "document" | "query";

export interface EmbeddingProvider {
  /** `signal` (2026-09-04): the chat turn's abort signal for query embeds — a
   *  user Stop during context assembly must end an in-flight embedding call
   *  instead of waiting it out. Providers combine it with their own timeout. */
  embed(texts: string[], model: string, task?: EmbeddingTask, signal?: AbortSignal): Promise<number[][]>;
  dimensions(model: string): number;
}

function embedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly apiKey: string) {}

  async embed(texts: string[], model: string, _task?: EmbeddingTask, signal?: AbortSignal): Promise<number[][]> {
    const modelId = model.replace("openai:", "");
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: embedSignal(signal, 60_000),
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

  async embed(texts: string[], model: string, task?: EmbeddingTask, signal?: AbortSignal): Promise<number[][]> {
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
        signal: embedSignal(signal, 60_000),
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

// Living-off-the-grid: any OpenAI-compatible embeddings endpoint (Ollama, HF TEI,
// LM Studio, vLLM). No key required; the lorebook never leaves the box. Applies the
// model's TASK PREFIX to the input text (nomic search_document:/search_query: etc.)
// — without it a prefix-trained model silently loses retrieval quality.
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {}

  async embed(texts: string[], model: string, task?: EmbeddingTask, signal?: AbortSignal): Promise<number[][]> {
    const catalog = getEmbeddingModel(model);
    const wireModel = model.replace(/^local:/, "");
    const prefix = task === "document" ? catalog?.documentPrefix : task === "query" ? catalog?.queryPrefix : undefined;
    const input = prefix ? texts.map(t => `${prefix}${t}`) : texts;
    const url = `${this.baseUrl.replace(/\/$/, "")}/embeddings`;
    const resp = await fetch(url, {
      method: "POST",
      signal: embedSignal(signal, 120_000), // CPU endpoints on big batches are slower than cloud
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ input, model: wireModel }),
    });
    if (!resp.ok) throw new Error(`local embeddings error: ${resp.status} ${await resp.text()}`);
    const json = await resp.json() as { data: { embedding: number[]; index?: number }[] };
    // Preserve request order (some servers return unordered with an index field).
    const rows = [...json.data];
    if (rows.every(d => typeof d.index === "number")) rows.sort((a, b) => (a.index! - b.index!));
    return rows.map(d => d.embedding);
  }

  dimensions(model: string): number {
    return getEmbeddingModel(model)?.dimensions ?? 768;
  }
}

// Single source of truth for the server-level (fallback) embedding providers, shared by the API and every worker so
// `local:` support is seeded uniformly. The OpenAI and Google keys are read when a provider is asked for, not once at
// boot: a server-wide key set in Admin: Server settings arrives through getters on `defaults`.
class ServerEmbeddingProviders extends Map<string, EmbeddingProvider> {
  private readonly built = new Map<string, { key: string; provider: EmbeddingProvider }>();

  constructor(private readonly defaults: { openaiApiKey?: string; googleApiKey?: string }) {
    super();
  }

  private keyed(prefix: string): EmbeddingProvider | undefined {
    const key = (prefix === "openai" ? this.defaults.openaiApiKey : prefix === "google" ? this.defaults.googleApiKey : undefined)?.trim() ?? "";
    if (!key) return undefined;
    const cached = this.built.get(prefix);
    if (cached && cached.key === key) return cached.provider;
    const provider = prefix === "openai" ? new OpenAIEmbeddingProvider(key) : new GoogleEmbeddingProvider(key);
    this.built.set(prefix, { key, provider });
    return provider;
  }

  override get(prefix: string): EmbeddingProvider | undefined {
    return prefix === "openai" || prefix === "google" ? this.keyed(prefix) : super.get(prefix);
  }

  override has(prefix: string): boolean {
    return this.get(prefix) !== undefined;
  }
}

export function buildEmbeddingProviders(defaults: {
  openaiApiKey?: string; googleApiKey?: string; localEmbeddingUrl?: string; localEmbeddingKey?: string;
}): Map<string, EmbeddingProvider> {
  const providers = new ServerEmbeddingProviders(defaults);
  if (defaults.localEmbeddingUrl) providers.set("local", new OpenAICompatibleEmbeddingProvider(defaults.localEmbeddingUrl, defaults.localEmbeddingKey || undefined));
  return providers;
}

export interface ProviderKeyLookup {
  findByUserAndProvider(userId: string, provider: string): { apiKey: string } | undefined;
}

// Providers hard-cap embedding input (OpenAI: 8,192 tokens; a 400, not a
// truncation). One over-cap entry used to fail its whole 32-entry batch, the
// rethrow killed every batch after it, and each subsequent worker run re-failed
// identically — the 2026-08-27 poisoned-batch outage, where a single bloated
// character entry blocked a full day of new entries from indexing. Inputs are
// truncated to this cap FOR THE VECTOR ONLY (retrieval always injects the full
// row content; the stored hash is of the full content so any edit re-embeds),
// and the truncation is surfaced as a warn event. 28,000 chars ≈ 8,000
// estimator tokens; real tokenization of prose lands well under every
// provider's cap.
export const MAX_EMBED_INPUT_CHARS = 28_000;

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

  async embedQuery(text: string, model: string, userId?: string, signal?: AbortSignal): Promise<Float32Array | null> {
    const provider = this.resolveProvider(model, userId);
    if (!provider) {
      // No-silent-failures: an ABSENT key (no provider_keys row, no env fallback)
      // used to degrade semantic retrieval to keyword-only with zero signal —
      // indistinguishable from health. A DEAD key (401) is recorded on the throw
      // path above; record the absent-key degradation here too. Skip when userId
      // is undefined (env-fallback path with no per-user attribution).
      if (userId) {
        recordSystemEvent({
          userId,
          source: "embed_query",
          severity: "warn",
          message: `no embedding provider resolves for ${model} — semantic retrieval degraded to keyword-only`,
          details: { model },
        });
      }
      return null;
    }
    try {
      const results = await provider.embed([text], model, "query", signal);
      if (!results[0]) return null;
      return new Float32Array(results[0]);
    } catch (err) {
      // A user Stop mid-assembly (2026-09-04): the abort is the caller's doing,
      // not a provider outage — rethrow without recording anything.
      if (signal?.aborted) throw err;
      // No-silent-failures: surface the provider outage, then rethrow so the
      // caller decides how to degrade (contextEngine falls back to keyword-only).
      if (userId) {
        recordSystemEvent({
          userId,
          source: "embed_query",
          severity: "error",
          message: `query embedding failed (${model}): ${describeErrorWithCause(err)}`,
        });
      }
      // Tag so downstream catches know this failure is already recorded
      // (one outage used to produce two error rows per throttle window).
      if (err instanceof Error) (err as Error & { systemEventRecorded?: boolean }).systemEventRecorded = true;
      throw err;
    }
  }

  async indexEntries(entries: { id: string; userId: string; content: string }[], model: string, opts?: { staleOnly?: boolean }): Promise<number> {
    // Hidden schemes must not leave vectors behind. Filter BEFORE the provider
    // call (not merely at retrieval time) and purge any historical vector if an
    // existing entry was newly sealed.
    const eligibleEntries = entries.filter((entry) => {
      if (!this.embeddings.isEntrySealed(entry.id)) return true;
      this.embeddings.deleteForEntry(entry.id);
      return false;
    }).filter((entry) => {
      // staleOnly: skip entries whose stored vector under this model
      // was computed from IDENTICAL content. The /embeddings/rebuild route
      // accepted (and Android sent) the flag for months while always doing the
      // full paid rebuild.
      if (!opts?.staleOnly) return true;
      const existing = this.embeddings.findByEntryAndModel(entry.id, model);
      return !existing || existing.contentHash !== hashContent(entry.content);
    });
    const userId = eligibleEntries[0]?.userId;
    if (eligibleEntries.length === 0) return 0; // legitimate no-op / all sealed
    const provider = this.resolveProvider(model, userId);
    if (!provider) {
      // No-silent-failures: a 0 return on an absent key looked identical to
      // success, so workers completed "successfully" while every rewritten entry
      // kept its stale vector. Record the degradation (the rewritten entries are
      // left unindexed under this model).
      if (userId) {
        recordSystemEvent({
          userId,
          source: "embed_index",
          severity: "warn",
          message: `no embedding provider resolves for ${model} — ${eligibleEntries.length} entries left unindexed`,
          details: { model, requested: eligibleEntries.length },
        });
      }
      return 0;
    }
    const dims = provider.dimensions(model);
    let indexed = 0;

    // Over-cap inputs embed truncated (vector-only; see MAX_EMBED_INPUT_CHARS).
    const truncated = eligibleEntries.filter(e => e.content.length > MAX_EMBED_INPUT_CHARS);
    if (truncated.length > 0 && userId) {
      recordSystemEvent({
        userId,
        source: "embed_index",
        severity: "warn",
        message: `${truncated.length} entr${truncated.length === 1 ? "y" : "ies"} exceed the embedding input cap (${MAX_EMBED_INPUT_CHARS} chars) — embedded truncated; split each into a core entry and satellite entries`,
        details: { model, entries: truncated.map(e => ({ id: e.id, chars: e.content.length })) },
      });
    }
    const embedText = (e: { content: string }) =>
      e.content.length > MAX_EMBED_INPUT_CHARS ? e.content.slice(0, MAX_EMBED_INPUT_CHARS) : e.content;

    // A repository throw while STORING a vector — SQLITE_BUSY after busy_timeout
    // (the API and the worker share the file) or any other SQLite error — used
    // to escape indexEntries as a rejection its callers only logged, and the
    // entries after it in the run were never attempted. Isolated per
    // item like a provider item failure: recorded once per run, run continues.
    const storeFailures: { id: string; error: string }[] = [];
    const upsertOne = (entry: { id: string; userId: string; content: string }, vector: number[]) => {
      try {
        const stored = this.embeddings.upsert({
          id: createId(),
          entryId: entry.id,
          userId: entry.userId,
          model,
          dimensions: dims,
          vector: encodeVector(vector),
          // Hash of the FULL content. Staleness (countStatus, staleOnly rebuilds,
          // offline re-embeds) compares this against the current row's
          // content, so any edit to a truncated-embed entry still re-embeds it —
          // and a non-content write (bulk sticky/keys) does NOT count as stale.
          contentHash: hashContent(entry.content),
          createdAt: new Date().toISOString(),
        });
        if (stored) indexed++;
      } catch (err) {
        storeFailures.push({ id: entry.id, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
    };

    for (let i = 0; i < eligibleEntries.length; i += 32) {
      const batch = eligibleEntries.slice(i, i + 32);
      let vectors: number[][] | null = null;
      let batchErr: unknown = null;
      try {
        vectors = await provider.embed(batch.map(embedText), model, "document");
      } catch (err) {
        batchErr = err;
      }

      if (vectors) {
        if (vectors.length < batch.length && userId) {
          // A provider that silently drops inputs left the tail unindexed with
          // no signal.
          const unindexed = batch.slice(vectors.length).map((e) => e.id);
          recordSystemEvent({
            userId,
            source: "embed_index",
            severity: "warn",
            message: `provider returned ${vectors.length} vectors for ${batch.length} inputs (${model}) — ${unindexed.length} entr${unindexed.length === 1 ? "y" : "ies"} left unindexed`,
            details: { model, unindexed },
          });
        }
        for (let j = 0; j < batch.length; j++) {
          const vector = vectors[j];
          if (vector) upsertOne(batch[j]!, vector);
        }
        continue;
      }

      // Batch failed. Isolate per item so one bad input cannot poison its
      // cohort. If nothing succeeds and the first few retries fail too, this
      // is a provider-level outage — record and rethrow (existing loud-failure
      // semantics); item-specific failures are recorded, skipped, and the run
      // continues.
      let anySuccess = false;
      let consecutiveFailures = 0;
      const failedItems: { id: string; chars: number; error: string }[] = [];
      for (const entry of batch) {
        if (!anySuccess && consecutiveFailures >= 3) break;
        try {
          const single = await provider.embed([embedText(entry)], model, "document");
          if (single[0]) { upsertOne(entry, single[0]); anySuccess = true; }
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures++;
          failedItems.push({ id: entry.id, chars: entry.content.length, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        }
      }
      if (!anySuccess) {
        // Provider-level outage (key dead, network down): unchanged behavior.
        if (userId) {
          recordSystemEvent({
            userId,
            source: "embed_index",
            severity: "error",
            message: `entry embedding failed (${model}, batch ${i / 32 + 1}): ${describeErrorWithCause(batchErr)}`,
            details: { indexedBeforeFailure: indexed, totalRequested: eligibleEntries.length },
          });
        }
        // Tag so a caller's catch can skip the duplicate row (same convention
        // as embedQuery).
        if (batchErr instanceof Error) (batchErr as Error & { systemEventRecorded?: boolean }).systemEventRecorded = true;
        throw batchErr;
      }
      if (failedItems.length > 0 && userId) {
        recordSystemEvent({
          userId,
          source: "embed_index",
          severity: "error",
          message: `${failedItems.length} entr${failedItems.length === 1 ? "y" : "ies"} failed to embed individually (${model}) and were skipped — the rest of the batch indexed`,
          details: { model, failed: failedItems },
        });
      }
    }
    if (storeFailures.length > 0 && userId) {
      recordSystemEvent({
        userId,
        source: "embed_index",
        severity: "error",
        message: `${storeFailures.length} entr${storeFailures.length === 1 ? "y" : "ies"} embedded under ${model} but the vector could not be stored (${storeFailures[0]!.error}) — unindexed until the next write or rebuild`,
        details: { model, failed: storeFailures },
      });
    }
    return indexed;
  }

  getStatus(userId: string, campaignId: string, model: string) {
    return this.embeddings.countStatus(userId, campaignId, model);
  }
}

// The one content-hash definition every staleness comparison shares.
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * An error's message plus its network cause (2026-09-27). Node's fetch reports
 * every transport failure as just "fetch failed" and hides the reason in
 * `cause` (ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, a TLS error …), so
 * two production events could not tell a DNS failure from a dropped
 * connection. Walks at most three cause levels.
 */
export function describeErrorWithCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = (err as { cause?: unknown }).cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    const code = typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : null;
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : null;
    const text = [code, message && message !== code ? message : null].filter(Boolean).join(" ");
    if (text && !parts.includes(text)) parts.push(text);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(" — ").slice(0, 400);
}

