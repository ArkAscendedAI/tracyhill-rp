import type { ServerResponse } from "node:http";

export type PipelineStreamStep = "analysis" | "lorebookRefresh" | "syspromptUpdate" | "repetitionDetection";

export type PipelineStreamEvent =
  | { type: "step_start"; runId: string; step: PipelineStreamStep; ts: number }
  | { type: "step_delta"; runId: string; step: PipelineStreamStep; delta: string; ts: number }
  | { type: "step_thinking_delta"; runId: string; step: PipelineStreamStep; delta: string; ts: number }
  | { type: "step_complete"; runId: string; step: PipelineStreamStep; result: string; ts: number }
  | { type: "step_error"; runId: string; step: PipelineStreamStep; error: string; ts: number }
  | { type: "run_complete"; runId: string; ts: number }
  | { type: "run_error"; runId: string; error: string; ts: number };

/**
 * In-process event bus for pipeline runs. The pipeline worker publishes
 * step_start/step_delta/step_complete events here; the API /runs/:id/stream
 * endpoint subscribes SSE clients. Events are buffered per-run so late
 * joiners get a full replay.
 *
 * Only usable when INLINE_WORKERS=1 (worker + API same process). Our prod
 * topology has INLINE_WORKERS=1 so this is fine.
 */
class PipelineStreamBus {
  private subscribers = new Map<string, Set<ServerResponse>>();
  private buffers = new Map<string, { events: PipelineStreamEvent[]; updatedAt: number }>();
  private readonly maxBuffered = 5000;
  private readonly maxRuns = 200;             // hard cap on distinct runIds tracked at once
  private readonly safetyEvictMs = 3_600_000; // 1h absolute eviction even if finalize() never called
  private readonly retentionMs = 600_000;     // 10 min retention after run complete
  private safetySweep?: ReturnType<typeof setInterval>;

  constructor() {
    // Safety-net eviction: if a worker crashes and never calls finalize(),
    // its buffer would otherwise live forever. Sweeps any runId older than
    // safetyEvictMs every 10 minutes.
    this.safetySweep = setInterval(() => this.runSafetySweep(), 600_000);
    this.safetySweep.unref?.();
  }

  publish(event: PipelineStreamEvent) {
    const entry = this.buffers.get(event.runId) ?? { events: [], updatedAt: Date.now() };
    entry.events.push(event);
    if (entry.events.length > this.maxBuffered) entry.events.splice(0, entry.events.length - this.maxBuffered);
    entry.updatedAt = Date.now();
    this.buffers.set(event.runId, entry);
    // Bound the total number of tracked runs (LRU: drop oldest by updatedAt).
    if (this.buffers.size > this.maxRuns) {
      const ordered = [...this.buffers.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [staleId] of ordered.slice(0, this.buffers.size - this.maxRuns)) {
        this.buffers.delete(staleId);
      }
    }

    const subs = this.subscribers.get(event.runId);
    if (!subs || subs.size === 0) return;
    const frame = this.encodeFrame(event);
    for (const res of subs) {
      try { res.write(frame); }
      catch { subs.delete(res); }
    }
  }

  subscribe(runId: string, res: ServerResponse) {
    const entry = this.buffers.get(runId);
    if (entry) {
      for (const event of entry.events) {
        try { res.write(this.encodeFrame(event)); } catch { /* socket closed during replay */ }
      }
    }
    if (!this.subscribers.has(runId)) this.subscribers.set(runId, new Set());
    this.subscribers.get(runId)!.add(res);
    return () => {
      this.subscribers.get(runId)?.delete(res);
    };
  }

  /** Called by worker after a run terminates. Schedules cleanup. */
  finalize(runId: string) {
    setTimeout(() => {
      const subs = this.subscribers.get(runId);
      if (subs) for (const res of subs) { try { res.end(); } catch { /* socket already torn down */ } }
      this.subscribers.delete(runId);
      this.buffers.delete(runId);
    }, this.retentionMs).unref?.();
  }

  private runSafetySweep() {
    const cutoff = Date.now() - this.safetyEvictMs;
    for (const [runId, entry] of this.buffers) {
      if (entry.updatedAt < cutoff) this.buffers.delete(runId);
    }
  }

  private encodeFrame(event: PipelineStreamEvent) {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}

export const pipelineStreamBus = new PipelineStreamBus();
