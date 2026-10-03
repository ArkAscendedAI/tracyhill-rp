import type {
  CreatePromptTemplateRequest,
  PromptTemplateListResponse,
  UpdatePromptTemplateRequest,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getPromptTemplates() {
  return apiFetch<PromptTemplateListResponse>("/api/prompt-templates", { method: "GET" });
}

export function createPromptTemplate(payload: CreatePromptTemplateRequest) {
  return apiFetch<PromptTemplateListResponse>("/api/prompt-templates", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updatePromptTemplate(templateId: string, payload: UpdatePromptTemplateRequest) {
  return apiFetch<PromptTemplateListResponse>(`/api/prompt-templates/${templateId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deletePromptTemplate(templateId: string) {
  return apiFetch<PromptTemplateListResponse>(`/api/prompt-templates/${templateId}`, { method: "DELETE" });
}
