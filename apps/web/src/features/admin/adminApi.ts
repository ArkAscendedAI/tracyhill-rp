import type {
  AdminAuditEventsResponse,
  AdminDeleteUserResponse,
  AdminPurgeImagesResponse,
  AdminResetUserPasswordRequest,
  AdminResetUserPasswordResponse,
  AdminStorageResponse,
  AdminUpdateUserRoleRequest,
  AdminUpdateUserRoleResponse,
  AdminUserSessionDetailResponse,
  AdminUserSessionsResponse,
  AdminUsersResponse,
  CreateAdminUserRequest,
  CreateAdminUserResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  ListInvitesResponse,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getAdminStorage() {
  return apiFetch<AdminStorageResponse>("/api/admin/storage", { method: "GET" });
}

export function getAdminAuditEvents(limit = 100) {
  return apiFetch<AdminAuditEventsResponse>(`/api/admin/audit-events?limit=${encodeURIComponent(String(limit))}`, { method: "GET" });
}

export function purgeAdminImages() {
  return apiFetch<AdminPurgeImagesResponse>("/api/admin/images", { method: "DELETE" });
}

export function getAdminUsers() {
  return apiFetch<AdminUsersResponse>("/api/admin/users", { method: "GET" });
}

export function createAdminUser(payload: CreateAdminUserRequest) {
  return apiFetch<CreateAdminUserResponse>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteAdminUser(userId: string) {
  return apiFetch<AdminDeleteUserResponse>(`/api/admin/users/${userId}`, { method: "DELETE" });
}

export function resetAdminUserPassword(userId: string, payload: AdminResetUserPasswordRequest) {
  return apiFetch<AdminResetUserPasswordResponse>(`/api/admin/users/${userId}/password`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function updateAdminUserRole(userId: string, payload: AdminUpdateUserRoleRequest) {
  return apiFetch<AdminUpdateUserRoleResponse>(`/api/admin/users/${userId}/role`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function getAdminUserSessions(userId: string) {
  return apiFetch<AdminUserSessionsResponse>(`/api/admin/users/${userId}/sessions`, { method: "GET" });
}

export function getAdminUserSessionDetail(userId: string, sessionId: string) {
  return apiFetch<AdminUserSessionDetailResponse>(`/api/admin/users/${userId}/sessions/${sessionId}`, { method: "GET" });
}

/** A lost phone: removes the account's authenticator, recovery codes and trusted devices. */
export function resetAdminUserTwoFactor(userId: string) {
  return apiFetch<{ ok: true }>(`/api/admin/users/${encodeURIComponent(userId)}/two-factor/reset`, { method: "POST" });
}

// ── Invite links ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const ADMIN_INVITES_QUERY_KEY = ["admin-invites"] as const;

export function getInvites() {
  return apiFetch<ListInvitesResponse>("/api/admin/invites", { method: "GET" });
}

/** The response carries the token once; the link is <this server>/invite/<token>. */
export function createInvite(payload: CreateInviteRequest) {
  return apiFetch<CreateInviteResponse>("/api/admin/invites", { method: "POST", body: JSON.stringify(payload) });
}

export function revokeInvite(inviteId: string) {
  return apiFetch<{ ok: true }>(`/api/admin/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" });
}
