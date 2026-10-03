import type { RequestHandler } from "express";

import type { WorkerStatus } from "../../domain/system/livenessMonitor";

export interface HealthOptions {
  topology?: "inline" | "split";
  // Null in the inline topology (no separate worker process to report on).
  workerStatus?: (() => WorkerStatus) | null;
}

// Health stays additive-only: existing consumers (container healthcheck,
// Android, deploy scripts) key on `ok`. The worker block reports liveness in
// the split topology but deliberately does NOT flip `ok` — the API serving
// requests is still true; a dead worker raises its own error system_event and
// fails the deploy verification instead.
export function createHealthController(options?: HealthOptions): RequestHandler {
  return (_req, res) => {
    const body: Record<string, unknown> = {
      ok: true,
      service: "tracyhill-rp-v2-api",
      now: new Date().toISOString(),
    };
    if (options?.topology) body.topology = options.topology;
    if (options?.workerStatus) {
      try { body.worker = options.workerStatus(); }
      catch { body.worker = { ok: false, beatAt: null, staleSeconds: null }; }
    }
    res.json(body);
  };
}
