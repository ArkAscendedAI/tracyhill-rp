import type { CodingPanelsResponse } from "@tracyhill-rp/contracts";

import { apiFetch } from "../shared/api/client";

// Which coding panels this server has set up (never set up automatically, and the coding
// section is greyed out until one is). Admin only, like the panels.

export const CODING_PANELS_QUERY_KEY = ["coding-panels"] as const;

export type CodingPanelId = keyof CodingPanelsResponse;

export function getCodingPanels() {
  return apiFetch<CodingPanelsResponse>("/api/coding-panels", { method: "GET" });
}

/**
 * A panel is offered unless the server says it is not set up. While the status loads, or when it cannot be read, the
 * panel stays available: it reports its own connection errors, and a configured server never flashes a greyed menu.
 */
export function codingPanelReady(status: CodingPanelsResponse | undefined, panel: CodingPanelId) {
  return status ? status[panel].configured : true;
}

/** The note under the coding menu, or null when every panel is set up. */
export function codingPanelsNote(status: CodingPanelsResponse | undefined): string | null {
  if (!status) return null;
  const ready = (Object.keys(status) as CodingPanelId[]).filter((panel) => status[panel].configured);
  if (ready.length === 3) return null;
  if (!ready.length) {
    return "No coding panel is set up on this server. Each one connects to an agent service that runs outside the app; see Coding panels in the README to set one up.";
  }
  return "Greyed-out panels are not set up on this server; see Coding panels in the README.";
}
