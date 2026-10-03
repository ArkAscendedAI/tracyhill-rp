import type {
  ActiveWizardRunsResponse,
  ApproveWizardRunRequest,
  ApproveWizardRunResponse,
  CancelWizardRunResponse,
  DismissWizardRunResponse,
  ImportWizardRunRequest,
  ImportWizardRunResponse,
  RetryWizardRunResponse,
  WizardRunsResponse,
  WizardTemplatesResponse,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getWizardTemplates() {
  return apiFetch<WizardTemplatesResponse>("/api/wizard/templates", {
    method: "GET",
  });
}

export function updateWizardTemplates(payload: Omit<WizardTemplatesResponse["templates"], "updatedAt">) {
  return apiFetch<WizardTemplatesResponse>("/api/wizard/templates", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function getWizardRuns() {
  return apiFetch<WizardRunsResponse>("/api/wizard/runs", {
    method: "GET",
  });
}

export function getActiveWizardRuns() {
  return apiFetch<ActiveWizardRunsResponse>("/api/wizard/active", {
    method: "GET",
  });
}

export function enqueueWizardRun(payload: { campaignName?: string; modelId: string; brief?: string; wizardTranscript?: string; wizardSessionId?: string }) {
  return apiFetch<WizardRunsResponse>("/api/wizard/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** A SillyTavern lorebook as a new campaign: the wizard converts it, and the owner reviews it before approval. */
export function importWizardRun(payload: ImportWizardRunRequest) {
  return apiFetch<ImportWizardRunResponse>("/api/wizard/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function approveWizardRun(runId: string, payload: ApproveWizardRunRequest = {}) {
  return apiFetch<ApproveWizardRunResponse>(`/api/wizard/runs/${runId}/approve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function retryWizardRun(runId: string) {
  return apiFetch<RetryWizardRunResponse>(`/api/wizard/runs/${runId}/retry`, {
    method: "POST",
  });
}

export function cancelWizardRun(runId: string) {
  return apiFetch<CancelWizardRunResponse>(`/api/wizard/runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function dismissWizardRun(runId: string) {
  return apiFetch<DismissWizardRunResponse>(`/api/wizard/runs/${runId}/dismiss`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
