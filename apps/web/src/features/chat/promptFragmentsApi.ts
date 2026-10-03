import type { PromptFragmentsResponse } from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

/** Everything the engine injects for a campaign session, in wire order (read-only). */
export function fetchPromptFragments(sessionId: string, modelId: string | null) {
  const query = modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
  return apiFetch<PromptFragmentsResponse>(`/api/context/sessions/${encodeURIComponent(sessionId)}/prompt-fragments${query}`, { method: "GET" });
}
