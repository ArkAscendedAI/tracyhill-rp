import type {
  CampaignsListResponse,
  CampaignVersionsResponse,
  CreateCampaignRequest,
  RestoreCampaignVersionRequest,
  UpdateCampaignRequest,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getCampaigns() {
  return apiFetch<CampaignsListResponse>("/api/campaigns", { method: "GET" });
}

export function createCampaign(payload: CreateCampaignRequest) {
  return apiFetch<CampaignsListResponse>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateCampaign(campaignId: string, payload: UpdateCampaignRequest) {
  return apiFetch<CampaignsListResponse>(`/api/campaigns/${campaignId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteCampaign(campaignId: string) {
  return apiFetch<CampaignsListResponse>(`/api/campaigns/${campaignId}`, {
    method: "DELETE",
  });
}

export function getCampaignVersions(campaignId: string) {
  return apiFetch<CampaignVersionsResponse>(`/api/campaigns/${campaignId}/versions`, {
    method: "GET",
  });
}

/** Restores a history row. `archiveId` (the row's `id`) names that exact row: the number alone can
 *  match two rows, or the current one, after a Version edit rewound the counter. Without it the server restores
 *  by number, as for older clients. */
export function restoreCampaignVersion(campaignId: string, version: number, archiveId: string | null) {
  const body: RestoreCampaignVersionRequest | null = archiveId ? { archiveId } : null;
  return apiFetch<CampaignsListResponse>(`/api/campaigns/${campaignId}/versions/${version}/restore`, {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
