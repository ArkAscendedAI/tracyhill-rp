import type { CharacterCardImportResult, CreateLorebookEntryRequest, EmbeddingRebuildResponse, LorebookBulkAction, LorebookBulkResult, LorebookEmbeddingStatus, LorebookEntry, LorebookEntrySummary, LorebookExport, LorebookExportFormat, LorebookImportResult, LorebookListResponse, LorebookRevertResponse, LorebookRevisionListResponse, LorebookTagsResponse, UpdateLorebookEntryRequest } from "@tracyhill-rp/contracts";
import { lorebookDeletedListResponseSchema, lorebookEntrySchema, lorebookSummaryListResponseSchema } from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

type ListParams = { tag?: string; search?: string; sort?: string; order?: string; offscreen?: boolean; provisional?: boolean; isConstant?: boolean };

/** The full rows, text included. The Threads chip reads the index's comment (the tracker's ledger) from here. */
export function getLorebookEntries(campaignId: string, params?: ListParams) {
  return pageEntries(campaignId, params, "full", (url) => apiFetch<LorebookListResponse>(url));
}

/**
 * The list rows without their text (`view=summary`): every field but `content` (its length is
 * `contentChars`), and `comment` only up to 10,000 characters (the Thread Index's ledger is null
 * with `commentChars`). The lorebook panel lists these and loads the full row on selection
 * (`getLorebookEntry`), so a filter change no longer downloads every entry's text.
 */
export function getLorebookEntrySummaries(campaignId: string, params?: ListParams): Promise<{ entries: LorebookEntrySummary[]; total: number }> {
  // Parsed through the contract (a new path; a cast let a renamed field go unseen). The full pages keep their cast.
  return pageEntries(campaignId, params, "summary", async (url) => lorebookSummaryListResponseSchema.parse(await apiFetch<unknown>(url)));
}

/** One full row (`GET /api/lorebook/entries/:id`), parsed through the contract. */
export async function getLorebookEntry(entryId: string): Promise<LorebookEntry> {
  return lorebookEntrySchema.parse(await apiFetch<unknown>(`/api/lorebook/entries/${entryId}`));
}

async function pageEntries<T extends { id: string }>(
  campaignId: string,
  params: ListParams | undefined,
  view: "full" | "summary",
  fetchPage: (url: string) => Promise<{ entries: T[]; total: number }>,
): Promise<{ entries: T[]; total: number }> {
  // Page through the FULL list — the single limit=1000 request silently
  // truncated large lorebooks (Mara: 2,629 entries) with no way to reach or
  // manage the rest, and the header stats were computed over the truncation.
  const pageSize = 1000;
  let offset = 0;
  const seen = new Set<string>();
  const all: { entries: T[]; total: number } = { entries: [], total: 0 };
  for (;;) {
    const qs = new URLSearchParams();
    if (params?.tag) qs.set("tag", params.tag);
    if (params?.search) qs.set("search", params.search);
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.order) qs.set("order", params.order);
    if (params?.offscreen) qs.set("offscreen", "true");
    if (params?.provisional) qs.set("provisional", "true");
    if (params?.isConstant !== undefined) qs.set("isConstant", String(params.isConstant));
    if (view === "summary") qs.set("view", "summary");
    qs.set("limit", String(pageSize));
    qs.set("offset", String(offset));
    const page = await fetchPage(`/api/lorebook/campaigns/${campaignId}/entries?${qs}`);
    const fresh = page.entries.filter((entry) => !seen.has(entry.id));
    if (page.entries.length && fresh.length === 0) throw new Error("Lorebook pagination did not advance. Retry loading the list.");
    fresh.forEach((entry) => seen.add(entry.id));
    all.entries.push(...fresh);
    all.total = page.total;
    if (page.entries.length === 0 || offset + page.entries.length >= page.total) break;
    offset += page.entries.length;
  }
  return all;
}

/**
 * The Threads chip's source: the campaign's constant `threads` rows, i.e. the Thread Index.
 * The chip used to page through every `threads` entry with
 * full content every minute to find the one constant row whose comment holds the ledger.
 */
export function getThreadIndexEntries(campaignId: string) {
  return getLorebookEntries(campaignId, { tag: "threads", isConstant: true });
}

// Response envelopes below match what lorebookController actually sends:
// create/update return the ENTRY itself, delete `{ ok: true }`, bulk
// `{ ok: true, warnings }` (lorebookBulkResultSchema, 2026-09-23). `{ tags }` /
// `{ indexed, total }` have no contract schema yet.
export function getLorebookTags(campaignId: string) {
  return apiFetch<LorebookTagsResponse>(`/api/lorebook/campaigns/${campaignId}/tags`);
}

export function createLorebookEntry(campaignId: string, payload: CreateLorebookEntryRequest) {
  return apiFetch<LorebookEntry>(`/api/lorebook/campaigns/${campaignId}/entries`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateLorebookEntry(entryId: string, payload: UpdateLorebookEntryRequest) {
  return apiFetch<LorebookEntry>(`/api/lorebook/entries/${entryId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteLorebookEntry(entryId: string) {
  return apiFetch<{ ok: true }>(`/api/lorebook/entries/${entryId}`, {
    method: "DELETE",
  });
}

export function bulkLorebookAction(campaignId: string, payload: LorebookBulkAction) {
  return apiFetch<LorebookBulkResult>(`/api/lorebook/campaigns/${campaignId}/bulk`, {
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

export function importCharacterCard(campaignId: string, body: { card?: unknown; pngBase64?: string }) {
  return apiFetch<CharacterCardImportResult>(`/api/lorebook/campaigns/${campaignId}/character-card`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function exportLorebook(campaignId: string, format: LorebookExportFormat = "json") {
  return apiFetch<LorebookExport>(`/api/lorebook/campaigns/${campaignId}/export?format=${format}`);
}

export function getEmbeddingStatus(campaignId: string, model?: string) {
  const qs = new URLSearchParams({ campaignId: campaignId });
  // Without the model the server falls back to the catalog's default embedding
  // model, which may differ from this campaign's — status then counts the
  // wrong vector namespace.
  if (model) qs.set("model", model);
  return apiFetch<LorebookEmbeddingStatus>(`/api/context/embeddings/status?${qs}`);
}

/**
 * The campaign's deleted entries that can be brought back, newest deletion first, each with the
 * pre-delete revision `revertEntry` restores. Parsed through the contract.
 */
export async function getDeletedLorebookEntries(campaignId: string, limit = 50) {
  return lorebookDeletedListResponseSchema.parse(await apiFetch<unknown>(`/api/lorebook/campaigns/${campaignId}/deleted?limit=${limit}`));
}

export function getRevisions(entryId: string) {
  return apiFetch<LorebookRevisionListResponse>(`/api/lorebook/entries/${entryId}/revisions`);
}

export function revertEntry(entryId: string, revisionId: string) {
  return apiFetch<LorebookRevertResponse>(`/api/lorebook/entries/${entryId}/revert`, {
    method: "POST",
    body: JSON.stringify({ revisionId }),
  });
}

// `staleOnly`: the route has long honoured it, but the web
// never sent it, so every web rebuild re-embedded the whole lorebook. The panel's dialog
// always sends it (default true); absent, the server's default (false) applies.
export function rebuildEmbeddings(campaignId: string, model?: string, opts?: { staleOnly?: boolean }) {
  return apiFetch<EmbeddingRebuildResponse>("/api/context/embeddings/rebuild", {
    method: "POST",
    body: JSON.stringify({ campaignId, ...(model ? { model } : {}), ...(opts?.staleOnly !== undefined ? { staleOnly: opts.staleOnly } : {}) }),
  });
}
