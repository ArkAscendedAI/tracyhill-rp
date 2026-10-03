import type { CustomEndpointRepository } from "../../../api/src/domain/providerKeys/customEndpointRepository";
import { resolveChatModelConfig } from "../../../api/src/domain/providerKeys/chatModelConfig";
import { recordSystemEvent, type SystemEventSource } from "../../../api/src/domain/system/systemEvents";

// Worker model resolution.
//
// Every pipeline worker used to resolve its Engine dial as
// `resolveChatModelConfig(..., dial || fallback)?.id ?? fallback` — so a dial
// naming a model that no longer resolves for the account (a custom-endpoint id
// whose endpoint the user deleted, a catalog id retired without a dial
// migration) silently ran the job on the deployment default while the run's
// details and the audit status kept reporting the dial. The standing rule: "Never
// silently override a user-facing setting." An unresolvable dial now FAILS the
// run with a clear message and a warn `system_events` row pointing at the
// Engine panel; the only fallback is the one that exists for an ABSENT dial
// (the deployment default / the worker's shipped default), which is not a
// substitution because nothing was chosen.

export class WorkerModelUnavailableError extends Error {
  constructor(readonly dial: string, label: string) {
    super(`${label} model "${dial}" is not available to this account (custom endpoint removed or model retired) — the run fails rather than silently using another model; choose a model in the Engine panel`);
    this.name = "WorkerModelUnavailableError";
  }
}

/**
 * Resolve the model a worker call runs on. `dial` is the run's stamped Engine
 * dial (may be empty/absent — then `fallback` is the deployment/shipped
 * default and is itself resolved the same way). Records a warn event under the
 * worker's own `source` and throws `WorkerModelUnavailableError` when the id
 * does not resolve; the caller's catch turns that into `markFailed` (which
 * records the run's error event), so the failure is visible twice over: once
 * as guidance, once as the run's terminal state.
 */
export function resolveWorkerModel(
  endpoints: CustomEndpointRepository,
  run: { id: string; userId: string; campaignId: string; sessionId?: string | null },
  source: SystemEventSource,
  label: string,
  dial: string | null | undefined,
  fallback: string,
): string {
  const wanted = typeof dial === "string" && dial.trim() ? dial.trim() : fallback;
  const resolved = resolveChatModelConfig(endpoints, run.userId, wanted)?.id;
  if (resolved) return resolved;
  const error = new WorkerModelUnavailableError(wanted, label);
  recordSystemEvent({
    userId: run.userId, source, severity: "warn",
    campaignId: run.campaignId, sessionId: run.sessionId ?? null,
    message: error.message,
    details: { runId: run.id, dial: wanted, fromDial: wanted === dial?.trim() },
  });
  throw error;
}
