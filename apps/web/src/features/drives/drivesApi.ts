import type {
  DriveListResponse,
  DriveRecord,
  DriveSheet,
  DriveHistoryResponse,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getDrives(campaignId: string) {
  return apiFetch<DriveListResponse>(`/api/drives/campaigns/${campaignId}`);
}

export function updateDrive(campaignId: string, characterName: string, sheet: DriveSheet, reason?: string) {
  return apiFetch<DriveRecord>(`/api/drives/campaigns/${campaignId}/${encodeURIComponent(characterName)}`, {
    method: "PATCH",
    body: JSON.stringify({ sheet, reason }),
  });
}

export function deleteDrive(campaignId: string, characterName: string) {
  return apiFetch<DriveListResponse>(`/api/drives/campaigns/${campaignId}/${encodeURIComponent(characterName)}`, {
    method: "DELETE",
  });
}

export function getDriveHistory(campaignId: string, characterName: string) {
  return apiFetch<DriveHistoryResponse>(`/api/drives/campaigns/${campaignId}/${encodeURIComponent(characterName)}/history`);
}

export function revertDrive(campaignId: string, characterName: string, historyId: string) {
  return apiFetch<DriveRecord>(`/api/drives/campaigns/${campaignId}/${encodeURIComponent(characterName)}/revert`, {
    method: "POST",
    body: JSON.stringify({ historyId }),
  });
}
