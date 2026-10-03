import type { AdversarialInspectResponse, ConfirmOffscreenResponse, DramatistLogResponse, WorldStatusResponse, WorldTickRequest, ProposedWorldEvent } from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getWorldStatus(campaignId: string) {
  return apiFetch<WorldStatusResponse>(`/api/world/campaigns/${campaignId}/status`);
}

export function getDramatistLog(campaignId: string) {
  return apiFetch<DramatistLogResponse>(`/api/world/campaigns/${campaignId}/dramatist-log`);
}


export function getAdversarialState(campaignId: string) {
  return apiFetch<AdversarialInspectResponse>(`/api/world/campaigns/${campaignId}/adversarial`);
}

/** The correction path that makes auto-recording safe: a consequence is
 *  authoritative AND self-reinforcing, so a wrong one has to be removable. */
export function dismissConsequence(campaignId: string, consequenceId: string) {
  return apiFetch<{ dismissed: string }>(`/api/world/campaigns/${campaignId}/consequences/${consequenceId}`, {
    method: "DELETE",
  });
}

// "Confirm as canon" for a provisional offscreen entry — the server-side
// marker writer (stamps confirmedAt); clients no longer rewrite the comment
// JSON themselves.
export function confirmOffscreen(campaignId: string, entryId: string) {
  return apiFetch<ConfirmOffscreenResponse>(`/api/world/campaigns/${campaignId}/offscreen/${entryId}/confirm`, { method: "POST" });
}

export function tickWorld(campaignId: string, req: WorldTickRequest) {
  return apiFetch<WorldStatusResponse>(`/api/world/campaigns/${campaignId}/tick`, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function applyWorldTick(campaignId: string, runId: string, events: ProposedWorldEvent[]) {
  return apiFetch<WorldStatusResponse>(`/api/world/campaigns/${campaignId}/runs/${runId}/apply`, {
    method: "POST",
    body: JSON.stringify({ events }),
  });
}

// Beat state machine is enforced server-side: played/dismissed are
// TERMINAL and an illegal transition is a 409 whose message the caller must
// surface. The web never manually "surfaces" a beat (that is the Android
// world screen's path), so that value is excluded here on purpose.
export function setBeatStatus(campaignId: string, beatId: string, status: "played" | "dismissed" | "pending") {
  return apiFetch<WorldStatusResponse>(`/api/world/campaigns/${campaignId}/beats/${beatId}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}
