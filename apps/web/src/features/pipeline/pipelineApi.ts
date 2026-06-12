import type { AbandonPipelineRunResponse, ActivePipelineRunsResponse, ApprovePipelineRunResponse, CancelPipelineRunResponse, PipelineRunArtifactsResponse, PipelineRunsResponse, RetryPipelineRunResponse } from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export type PipelineStreamStep = "analysis" | "lorebookRefresh" | "syspromptUpdate";

export type PipelineStreamEvent =
  | { type: "step_start"; runId: string; step: PipelineStreamStep; ts: number }
  | { type: "step_delta"; runId: string; step: PipelineStreamStep; delta: string; ts: number }
  | { type: "step_thinking_delta"; runId: string; step: PipelineStreamStep; delta: string; ts: number }
  | { type: "step_complete"; runId: string; step: PipelineStreamStep; result: string; ts: number }
  | { type: "step_error"; runId: string; step: PipelineStreamStep; error: string; ts: number }
  | { type: "run_complete"; runId: string; ts: number }
  | { type: "run_error"; runId: string; error: string; ts: number };

export function getPipelineRuns(campaignId: string) {
  return apiFetch<PipelineRunsResponse>(`/api/pipeline/campaigns/${campaignId}/runs`, {
    method: "GET",
  });
}

export function getActivePipelineRuns() {
  return apiFetch<ActivePipelineRunsResponse>("/api/pipeline/active", {
    method: "GET",
  });
}

export function enqueuePipelineRun(campaignId: string, body?: { creativeModelId?: string }) {
  return apiFetch<PipelineRunsResponse>(`/api/pipeline/campaigns/${campaignId}/runs`, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function approvePipelineRun(campaignId: string, runId: string, startSession = false) {
  return apiFetch<ApprovePipelineRunResponse>(`/api/pipeline/campaigns/${campaignId}/runs/${runId}/approve`, {
    method: "POST",
    body: JSON.stringify({ startSession }),
  });
}

export function cancelPipelineRun(campaignId: string, runId: string) {
  return apiFetch<CancelPipelineRunResponse>(`/api/pipeline/campaigns/${campaignId}/runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function retryPipelineRun(campaignId: string, runId: string, fromStep?: "fromLorebookRefresh" | "fromSysprompt") {
  return apiFetch<RetryPipelineRunResponse>(`/api/pipeline/campaigns/${campaignId}/runs/${runId}/retry`, {
    method: "POST",
    body: JSON.stringify(fromStep == null ? {} : { fromStep }),
  });
}

export function abandonPipelineRun(campaignId: string, runId: string) {
  return apiFetch<AbandonPipelineRunResponse>(`/api/pipeline/campaigns/${campaignId}/runs/${runId}/abandon`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export type PipelineQueueJob = {
  runId: string;
  kind: string;
  status: "queued" | "running";
  priority: number;
  startedAt: string | null;
  elapsedMs: number | null;
};

export type PipelineQueueStatusResponse = {
  campaignId: string;
  jobs: PipelineQueueJob[];
};

export function getPipelineQueueStatus(campaignId: string) {
  return apiFetch<PipelineQueueStatusResponse>(`/api/pipeline/queue-status?campaignId=${encodeURIComponent(campaignId)}`, {
    method: "GET",
  });
}

export function getPipelineRunArtifacts(runId: string) {
  return apiFetch<PipelineRunArtifactsResponse>(`/api/pipeline/runs/${runId}/artifacts`, {
    method: "GET",
  });
}

export async function streamPipelineRun(runId: string, onEvent: (event: PipelineStreamEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/pipeline/runs/${runId}/stream`, {
    method: "GET",
    credentials: "include",
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`pipeline stream failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) { eventType = line.slice(6).trim(); continue; }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || !eventType) continue;
      try { onEvent(JSON.parse(data) as PipelineStreamEvent); } catch {}
      eventType = "";
    }
    if (done) break;
  }
}
