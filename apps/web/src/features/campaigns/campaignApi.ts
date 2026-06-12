import type {
  CampaignsListResponse,
  CampaignVersionsResponse,
  CreateCampaignRequest,
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

export function restoreCampaignVersion(campaignId: string, version: number) {
  return apiFetch<CampaignsListResponse>(`/api/campaigns/${campaignId}/versions/${version}/restore`, {
    method: "POST",
  });
}
