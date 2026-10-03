// Runs retrieval scoring jobs on one worker thread so the API's event loop stays
// free while a campaign turn's keyword pass runs (2026-09-21). One worker is
// enough: jobs take tens of milliseconds and queue behind each other, and the
// main thread never waits synchronously. Every failure path degrades to running
// the same pure function inline and is reported to the engine, which records a
// system event — a scoring worker problem is never a silent loss of retrieval.
import { Worker } from "node:worker_threads";

import { executeRetrievalScoring, type RetrievalScoringJob, type RetrievalScoringResult } from "./retrievalScoring";

export interface RetrievalScoringOutcome {
  result: RetrievalScoringResult;
  ranOn: "worker" | "inline";
  /** Set when the worker was enabled but the job had to run inline. */
  fallbackReason: string | null;
  /** Wall time of the job as seen by the caller (queueing + transfer + compute). */
  elapsedMs: number;
}

export interface RetrievalScoringPoolOptions {
  /** Default: CONTEXT_SCORING_WORKER !== "0". */
  enabled?: boolean;
  /** A job past this is treated as a hung worker: terminate, fall back inline, respawn lazily. */
  timeoutMs?: number;
  workerUrl?: URL;
}

interface PendingJob {
  resolve: (result: RetrievalScoringResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RetrievalScoringPool {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingJob>();
  private nextId = 1;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly workerUrl: URL;

  constructor(options: RetrievalScoringPoolOptions = {}) {
    this.enabled = options.enabled ?? process.env.CONTEXT_SCORING_WORKER !== "0";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.workerUrl = options.workerUrl ?? new URL("./retrievalScoringWorker.boot.mjs", import.meta.url);
  }

  isEnabled(): boolean { return this.enabled; }

  async run(job: RetrievalScoringJob): Promise<RetrievalScoringOutcome> {
    const started = performance.now();
    if (!this.enabled) {
      return { result: executeRetrievalScoring(job), ranOn: "inline", fallbackReason: null, elapsedMs: performance.now() - started };
    }
    try {
      const result = await this.runOnWorker(job);
      return { result, ranOn: "worker", fallbackReason: null, elapsedMs: performance.now() - started };
    } catch (error) {
      const fallbackReason = error instanceof Error ? error.message : String(error);
      return { result: executeRetrievalScoring(job), ranOn: "inline", fallbackReason, elapsedMs: performance.now() - started };
    }
  }

  /** Start the worker ahead of the first turn. Resolves when it reports ready; rejects if it cannot start. */
  warm(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.ensureWorker();
    return this.readyPromise ?? Promise.resolve();
  }

  async shutdown(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    this.failPending(new Error("retrieval scoring pool shut down"));
    if (worker) await worker.terminate().catch(() => undefined);
  }

  private runOnWorker(job: RetrievalScoringJob): Promise<RetrievalScoringResult> {
    return new Promise((resolve, reject) => {
      const worker = this.ensureWorker();
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`retrieval scoring worker exceeded ${this.timeoutMs} ms`));
        this.discardWorker(new Error(`retrieval scoring worker exceeded ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.syncRef();
      try {
        worker.postMessage({ id, job });
      } catch (error) {
        this.pending.delete(id);
        this.syncRef();
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerUrl);
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      worker.on("message", (message: { ready?: boolean; id?: number; result?: RetrievalScoringResult; error?: string }) => {
        if (message?.ready) { resolveReady(); return; }
        if (typeof message?.id !== "number") return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        this.syncRef();
        clearTimeout(pending.timer);
        if (message.error !== undefined) pending.reject(new Error(message.error));
        else pending.resolve(message.result!);
      });
      worker.on("error", (error) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        rejectReady(wrapped);
        if (this.worker === worker) this.discardWorker(wrapped);
      });
      worker.on("exit", (code) => {
        const reason = new Error(`retrieval scoring worker exited with code ${code}`);
        rejectReady(reason);
        if (this.worker === worker) this.discardWorker(reason);
      });
    });
    // A start failure is reported through the job that hits it; avoid an unhandled rejection when nobody awaited warm().
    this.readyPromise.catch(() => undefined);
    this.worker = worker;
    // Idle workers must never keep the process alive; a worker with a job in
    // flight must (otherwise a script awaiting its answer exits early). Both
    // measured 2026-09-21. Note the order: Node re-references the worker's port
    // when a 'message' listener is attached, so unref() has to come after it.
    this.syncRef();
    return worker;
  }

  /** Reference the worker only while jobs are pending. */
  private syncRef(): void {
    const worker = this.worker;
    if (!worker) return;
    if (this.pending.size > 0) worker.ref(); else worker.unref();
  }

  private discardWorker(reason: Error): void {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    this.failPending(reason);
    if (worker) void worker.terminate().catch(() => undefined);
  }

  private failPending(reason: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

/** The process-wide pool the engine uses unless it is handed a specific one (createApp passes the env-configured pool). */
export const defaultRetrievalScoringPool = new RetrievalScoringPool();
