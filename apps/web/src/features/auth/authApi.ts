import type {
  AcceptInviteRequest,
  AcceptInviteResponse,
  PeekInviteResponse,
  ConfirmForcedTwoFactorSetupRequest,
  ConfirmForcedTwoFactorSetupResponse,
  ConfirmTotpRequest,
  DisableTotpRequest,
  RecoveryCodesResponse,
  RegenerateRecoveryCodesRequest,
  StartForcedTwoFactorSetupRequest,
  StartTotpRequest,
  TotpSetup,
  TwoFactorStatusResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  ConfirmAccountDeletionRequest,
  ConfirmAccountDeletionResponse,
  CurrentUserResponse,
  ExecuteAccountDeletionRequest,
  ExecuteAccountDeletionResponse,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  MfaStatusResponse,
  RegisterRequest,
  RegisterResponse,
  ResendMfaCodeRequest,
  ResendMfaCodeResponse,
  ResendAccountDeletionRequest,
  ResendAccountDeletionResponse,
  ResendPasswordResetRequest,
  ResendPasswordResetResponse,
  ResendRegistrationRequest,
  ResendRegistrationResponse,
  RevokeAllTrustedDevicesResponse,
  RevokeTrustedDeviceResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
  RequestAccountDeletionResponse,
  RequestEmailChangeRequest,
  RequestEmailChangeResponse,
  VerifyEmailChangeRequest,
  VerifyEmailChangeResponse,
  VerifyMfaCodeRequest,
  VerifyMfaCodeResponse,
  VerifyRegistrationRequest,
  VerifyRegistrationResponse,
  VerifyPasswordResetRequest,
  VerifyPasswordResetResponse,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

export function getCurrentUser() {
  return apiFetch<CurrentUserResponse>("/api/auth/me", { method: "GET" });
}

export function login(payload: LoginRequest) {
  return apiFetch<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function resendMfaCode(payload: ResendMfaCodeRequest) {
  return apiFetch<ResendMfaCodeResponse>("/api/auth/mfa/resend", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function verifyMfaCode(payload: VerifyMfaCodeRequest) {
  return apiFetch<VerifyMfaCodeResponse>("/api/auth/mfa/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getMfaStatus() {
  return apiFetch<MfaStatusResponse>("/api/account/mfa", { method: "GET" });
}

// Set/change the account email: a code goes to the NEW address, then
// /email/verify stores it verified. Admin-created accounts start with no email
// and had no way to add one, which locked them out of MFA and self-delete.
export function requestEmailChange(payload: RequestEmailChangeRequest) {
  return apiFetch<RequestEmailChangeResponse>("/api/account/email", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function verifyEmailChange(payload: VerifyEmailChangeRequest) {
  return apiFetch<VerifyEmailChangeResponse>("/api/account/email/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function revokeTrustedDevice(deviceId: number) {
  return apiFetch<RevokeTrustedDeviceResponse>(`/api/account/mfa/trusted-devices/${deviceId}`, {
    method: "DELETE",
  });
}

export function revokeAllTrustedDevices() {
  return apiFetch<RevokeAllTrustedDevicesResponse>("/api/account/mfa/trusted-devices", {
    method: "DELETE",
  });
}

export function register(payload: RegisterRequest) {
  return apiFetch<RegisterResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function verifyRegistration(payload: VerifyRegistrationRequest) {
  return apiFetch<VerifyRegistrationResponse>("/api/auth/register/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function resendRegistration(payload: ResendRegistrationRequest) {
  return apiFetch<ResendRegistrationResponse>("/api/auth/register/resend", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function forgotPassword(payload: ForgotPasswordRequest) {
  return apiFetch<ForgotPasswordResponse>("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function resendPasswordReset(payload: ResendPasswordResetRequest) {
  return apiFetch<ResendPasswordResetResponse>("/api/auth/forgot-password/resend", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function verifyPasswordReset(payload: VerifyPasswordResetRequest) {
  return apiFetch<VerifyPasswordResetResponse>("/api/auth/forgot-password/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function resetPassword(payload: ResetPasswordRequest) {
  return apiFetch<ResetPasswordResponse>("/api/auth/forgot-password/reset", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function logout() {
  return apiFetch<LogoutResponse>("/api/auth/logout", { method: "POST" });
}

export function changePassword(payload: ChangePasswordRequest) {
  return apiFetch<ChangePasswordResponse>("/api/account/password", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function requestAccountDeletion() {
  return apiFetch<RequestAccountDeletionResponse>("/api/account/delete-request", {
    method: "POST",
  });
}

export function resendAccountDeletion(payload: ResendAccountDeletionRequest) {
  return apiFetch<ResendAccountDeletionResponse>("/api/account/delete-request/send-code", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function confirmAccountDeletion(payload: ConfirmAccountDeletionRequest) {
  return apiFetch<ConfirmAccountDeletionResponse>("/api/account/delete-confirm", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function executeAccountDeletion(payload: ExecuteAccountDeletionRequest) {
  return apiFetch<ExecuteAccountDeletionResponse>("/api/account/delete-execute", {
    method: "DELETE",
    body: JSON.stringify(payload),
  });
}

// ── Authenticator-app two-factor ─────────────────────────────────────────────────────────────────────────────────────

/** Required two-factor at sign-in: the setup token from the sign-in response stands in for the session. */
export function startForcedTwoFactorSetup(payload: StartForcedTwoFactorSetupRequest) {
  return apiFetch<TotpSetup>("/api/auth/two-factor/setup/start", { method: "POST", body: JSON.stringify(payload) });
}

export function confirmForcedTwoFactorSetup(payload: ConfirmForcedTwoFactorSetupRequest) {
  return apiFetch<ConfirmForcedTwoFactorSetupResponse>("/api/auth/two-factor/setup/confirm", { method: "POST", body: JSON.stringify(payload) });
}

export function getTwoFactorStatus() {
  return apiFetch<TwoFactorStatusResponse>("/api/account/two-factor", { method: "GET" });
}

export function startTotp(payload: StartTotpRequest) {
  return apiFetch<TotpSetup>("/api/account/two-factor/totp/start", { method: "POST", body: JSON.stringify(payload) });
}

export function confirmTotp(payload: ConfirmTotpRequest) {
  return apiFetch<RecoveryCodesResponse>("/api/account/two-factor/totp/confirm", { method: "POST", body: JSON.stringify(payload) });
}

export function disableTotp(payload: DisableTotpRequest) {
  return apiFetch<{ ok: true }>("/api/account/two-factor/totp/disable", { method: "POST", body: JSON.stringify(payload) });
}

export function regenerateRecoveryCodes(payload: RegenerateRecoveryCodesRequest) {
  return apiFetch<RecoveryCodesResponse>("/api/account/two-factor/recovery-codes", { method: "POST", body: JSON.stringify(payload) });
}

// ── Invite links ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether an invite can still be used, and the username it fixes, before the form. */
export function peekInvite(token: string) {
  return apiFetch<PeekInviteResponse>(`/api/auth/invites/${encodeURIComponent(token)}`, { method: "GET" });
}

export function acceptInvite(payload: AcceptInviteRequest) {
  return apiFetch<AcceptInviteResponse>("/api/auth/invites/accept", { method: "POST", body: JSON.stringify(payload) });
}
