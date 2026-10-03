import type { ActivePipelineRunsResponse, AuditFindingsResponse, CampaignAuditMode, CampaignAuditStatusResponse, CancelPipelineRunResponse, EnqueueRecapResponse, PipelineQueueStatusResponse, PipelineRunsQuery, PipelineRunsResponse, RecapStatusResponse, SubmitAuditRulingsRequest } from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

/** The campaign's runs, newest first. Ask for only what the caller shows: the newest N, or one watched run. */
export function getPipelineRuns(campaignId: string, filter: PipelineRunsQuery = {}) {
  const params = new URLSearchParams();
  if (filter.limit != null) params.set("limit", String(filter.limit));
  if (filter.runId != null) params.set("runId", filter.runId);
  const qs = params.toString();
  return apiFetch<PipelineRunsResponse>(`/api/pipeline/campaigns/${campaignId}/runs${qs ? `?${qs}` : ""}`, {
    method: "GET",
  });
}

export function getActivePipelineRuns() {
  return apiFetch<ActivePipelineRunsResponse>("/api/pipeline/active", {
    method: "GET",
  });
}

export function enqueueRecap(campaignId: string, sessionId?: string | null) {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return apiFetch<EnqueueRecapResponse>(`/api/pipeline/campaigns/${campaignId}/recap${qs}`, {
    method: "POST",
  });
}

export function enqueueCampaignAudit(campaignId: string, body: { mode: CampaignAuditMode; modelId?: string; sessionId?: string }) {
  return apiFetch<CampaignAuditStatusResponse>(`/api/pipeline/campaigns/${campaignId}/audit`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getCampaignAuditStatus(campaignId: string) {
  return apiFetch<CampaignAuditStatusResponse>(`/api/pipeline/campaigns/${campaignId}/audit/latest`, {
    method: "GET",
  });
}

export function getAuditFindings(campaignId: string) {
  return apiFetch<AuditFindingsResponse>(`/api/pipeline/campaigns/${campaignId}/audit/findings`, {
    method: "GET",
  });
}

export function submitAuditRulings(campaignId: string, body: SubmitAuditRulingsRequest) {
  return apiFetch<AuditFindingsResponse>(`/api/pipeline/campaigns/${campaignId}/audit/findings/rulings`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getRecapStatus(campaignId: string, sessionId?: string | null) {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return apiFetch<RecapStatusResponse>(`/api/pipeline/campaigns/${campaignId}/recap${qs}`, {
    method: "GET",
  });
}

export function cancelPipelineRun(campaignId: string, runId: string) {
  return apiFetch<CancelPipelineRunResponse>(`/api/pipeline/campaigns/${campaignId}/runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// Queued/running jobs for ONE campaign, with priority and elapsed time. Polled
// by the queue pill. Run rows carry their own `kind` since 2026-09-02, so the
// activity bar no longer joins on this for its label.
export function getPipelineQueueStatus(campaignId: string) {
  return apiFetch<PipelineQueueStatusResponse>(`/api/pipeline/queue-status?campaignId=${encodeURIComponent(campaignId)}`, {
    method: "GET",
  });
}

// The SSE stream client (`streamPipelineRun` + the step/event types) was
// removed 2026-09-02: the server bus had no publishers, so
// every subscriber only ever saw heartbeats and the route now answers with an
// immediate `stream_end`. Run progress is polled (`/active`, `/queue-status`).
