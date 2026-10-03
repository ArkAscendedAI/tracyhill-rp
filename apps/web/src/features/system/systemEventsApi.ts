import { apiFetch } from "../../shared/api/client";

import { systemEventsResponseSchema } from "@tracyhill-rp/contracts";
import type { AckSystemEventsRequest, AckSystemEventsResponse, SystemEventClass, SystemEventsResponse } from "@tracyhill-rp/contracts";

// Two delivery classes (2026-09-27): "alert" = warn/error (something failed or
// degraded — the rail badge counts them), "notice" = info (the system handled
// it — readable in the panel, never counted). Every response carries both
// unacknowledged counts whichever class it lists. The list is parsed with the contract, so a drifted field fails
// the read, which the badge shows, and the contract's defaults apply.
export async function getSystemEvents(options: { unackedOnly?: boolean; limit?: number; eventClass?: SystemEventClass } = {}): Promise<SystemEventsResponse> {
  const params = new URLSearchParams({ unacked: options.unackedOnly === false ? "0" : "1", limit: String(options.limit ?? 50) });
  if (options.eventClass) params.set("class", options.eventClass);
  return systemEventsResponseSchema.parse(await apiFetch<unknown>(`/api/system-events?${params.toString()}`));
}

// Acknowledges the given events (`ids`, within `eventClass` when given): the popover
// sends the events it listed (systemEventsAck.ts). Without ids the route
// acknowledges every unacknowledged event of the class, or of every class when none
// is given (Android 1.2.0's class acknowledgement).
// The answer carries the contract's type; it is not parsed, because nothing reads it and the badge shows no
// acknowledgement failure, so a refused parse would turn a done acknowledgement into a silent no-op.
export function ackSystemEvents(eventClass?: SystemEventClass, ids?: readonly string[]): Promise<AckSystemEventsResponse> {
  const body: AckSystemEventsRequest = { ...(ids ? { ids: [...ids] } : {}), ...(eventClass ? { class: eventClass } : {}) };
  return apiFetch<AckSystemEventsResponse>("/api/system-events/ack", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
