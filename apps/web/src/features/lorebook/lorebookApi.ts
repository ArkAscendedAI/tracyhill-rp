import type {
  LorebookListResponse,
  LorebookEntry,
  CreateLorebookEntryRequest,
  UpdateLorebookEntryRequest,
  LorebookBulkAction,
  LorebookImportResult,
  LorebookEmbeddingStatus,
  ContextPreviewResponse,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export async function getLorebookEntries(campaignId: string, params?: { tag?: string; search?: string; sort?: string; order?: string }) {
  // Page through the FULL list — the single limit=1000 request silently
  // truncated large lorebooks (Buffy: 2,629 entries) with no way to reach or
  // manage the rest, and the header stats were computed over the truncation.
  const pageSize = 1000;
  let offset = 0;
  const all: LorebookListResponse = { entries: [], total: 0 };
  for (;;) {
    const qs = new URLSearchParams();
    if (params?.tag) qs.set("tag", params.tag);
    if (params?.search) qs.set("search", params.search);
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.order) qs.set("order", params.order);
    qs.set("limit", String(pageSize));
    qs.set("offset", String(offset));
    const page = await apiFetch<LorebookListResponse>(`/api/lorebook/campaigns/${campaignId}/entries?${qs}`);
    all.entries.push(...page.entries);
    all.total = page.total;
    if (page.entries.length < pageSize || all.entries.length >= 10_000) break;
    offset += pageSize;
  }
  return all;
}

export function getLorebookTags(campaignId: string) {
  return apiFetch<{ tags: string[] }>(`/api/lorebook/campaigns/${campaignId}/tags`);
}

export function createLorebookEntry(campaignId: string, payload: CreateLorebookEntryRequest) {
  return apiFetch<{ entry: LorebookEntry }>(`/api/lorebook/campaigns/${campaignId}/entries`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateLorebookEntry(entryId: string, payload: UpdateLorebookEntryRequest) {
  return apiFetch<{ entry: LorebookEntry }>(`/api/lorebook/entries/${entryId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteLorebookEntry(entryId: string) {
  return apiFetch<{ success: boolean }>(`/api/lorebook/entries/${entryId}`, {
    method: "DELETE",
  });
}

export function bulkLorebookAction(campaignId: string, payload: LorebookBulkAction) {
  return apiFetch<{ affected: number }>(`/api/lorebook/campaigns/${campaignId}/bulk`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function importLorebook(campaignId: string, data: unknown) {
  return apiFetch<LorebookImportResult>(`/api/lorebook/campaigns/${campaignId}/import`, {
    method: "POST",
    body: JSON.stringify({ campaignId, format: "sillytavern", data }),
  });
}

export function getEmbeddingStatus(campaignId: string, model?: string) {
  const qs = new URLSearchParams({ campaignId: campaignId });
  // Without the model the server defaults to openai — status counted the
  // wrong vector namespace on gemini-embedded campaigns.
  if (model) qs.set("model", model);
  return apiFetch<LorebookEmbeddingStatus>(`/api/context/embeddings/status?${qs}`);
}

export function rebuildEmbeddings(campaignId: string, model?: string) {
  return apiFetch<{ indexed: number; total: number }>("/api/context/embeddings/rebuild", {
    method: "POST",
    body: JSON.stringify(model ? { campaignId, model } : { campaignId }),
  });
}
