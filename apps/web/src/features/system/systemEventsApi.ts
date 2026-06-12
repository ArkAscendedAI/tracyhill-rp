import { apiFetch } from "../../shared/api/client";

import type { SystemEventsResponse } from "@tracyhill-rp/contracts";

export function getSystemEvents(unackedOnly = true, limit = 50): Promise<SystemEventsResponse> {
  return apiFetch<SystemEventsResponse>(`/api/system-events?unacked=${unackedOnly ? "1" : "0"}&limit=${limit}`);
}

export function ackSystemEvents(ids?: string[]): Promise<{ acknowledged: number; unackedCount: number }> {
  return apiFetch<{ acknowledged: number; unackedCount: number }>("/api/system-events/ack", {
    method: "POST",
    body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
  });
}
