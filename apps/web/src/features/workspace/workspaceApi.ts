import type {
  CreateFolderRequest,
  CreateSessionRequest,
  UpdateFolderRequest,
  UpdateSessionRequest,
  UpdateWorkspacePreferencesRequest,
  WorkspaceSearchResponse,
  WorkspaceStateResponse,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getWorkspaceState() {
  return apiFetch<WorkspaceStateResponse>("/api/workspace", { method: "GET" });
}

export function searchWorkspace(query: string) {
  return apiFetch<WorkspaceSearchResponse>(`/api/workspace/search?q=${encodeURIComponent(query)}`, { method: "GET" });
}

export function createFolder(payload: CreateFolderRequest) {
  return apiFetch<WorkspaceStateResponse>("/api/workspace/folders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateFolder(folderId: string, payload: UpdateFolderRequest) {
  return apiFetch<WorkspaceStateResponse>(`/api/workspace/folders/${folderId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteFolder(folderId: string) {
  return apiFetch<WorkspaceStateResponse>(`/api/workspace/folders/${folderId}`, {
    method: "DELETE",
  });
}

export function createSession(payload: CreateSessionRequest) {
  return apiFetch<WorkspaceStateResponse>("/api/workspace/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function startSessionFromCampaign(campaignId: string) {
  return apiFetch<WorkspaceStateResponse>(`/api/workspace/sessions/from-campaign/${campaignId}`, {
    method: "POST",
  });
}

export function updateSession(sessionId: string, payload: UpdateSessionRequest) {
  return apiFetch<WorkspaceStateResponse>(`/api/workspace/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteSession(sessionId: string) {
  return apiFetch<WorkspaceStateResponse>(`/api/workspace/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

export function restoreSession(sessionId: string) {
  return apiFetch<WorkspaceStateResponse>(`/api/workspace/sessions/${sessionId}/restore`, {
    method: "POST",
  });
}

export function permanentlyDeleteSession(sessionId: string) {
  return apiFetch<WorkspaceStateResponse>(`/api/workspace/sessions/${sessionId}/permanent`, {
    method: "DELETE",
  });
}

export function emptyRecycleBin() {
  return apiFetch<WorkspaceStateResponse>("/api/workspace/recycle-bin", {
    method: "DELETE",
  });
}

export function updateWorkspacePreferences(payload: UpdateWorkspacePreferencesRequest) {
  return apiFetch<WorkspaceStateResponse>("/api/workspace/preferences", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
