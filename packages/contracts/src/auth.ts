import { z } from "zod";

import { roleSchema } from "./common";

export const currentUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: roleSchema,
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  ok: z.literal(true),
  user: currentUserSchema,
});

// The second factors a sign-in can ask for: a code from an authenticator app, a recovery code (only where an
// authenticator is set up), or a code emailed to a verified address.
export const secondFactorMethodSchema = z.enum(["totp", "recovery", "email"]);
export type SecondFactorMethod = z.infer<typeof secondFactorMethodSchema>;

export const loginChallengeResponseSchema = z.object({
  mfaRequired: z.literal(true),
  mfaSessionToken: z.string().min(1),
  // The masked address an email code went to; blank when none was sent (an account with an authenticator asks for its
  // code first and sends an email code only on request).
  emailMasked: z.string(),
  // Absent from older servers, where the only factor was the email code.
  methods: z.array(secondFactorMethodSchema).optional(),
  emailSent: z.boolean().optional(),
  devVerificationCode: z.string().min(1).optional(),
});

// Two-factor is Required on the server and this account has none yet: it sets up an authenticator before it is signed in.
export const loginSetupRequiredResponseSchema = z.object({
  twoFactorSetupRequired: z.literal(true),
  setupToken: z.string().min(1),
});

export const loginResultSchema = z.union([loginResponseSchema, loginChallengeResponseSchema, loginSetupRequiredResponseSchema]);

export type LoginResponse = z.infer<typeof loginResultSchema>;

export const resendMfaCodeRequestSchema = z.object({
  mfaSessionToken: z.string().min(1),
});

export type ResendMfaCodeRequest = z.infer<typeof resendMfaCodeRequestSchema>;

export const resendMfaCodeResponseSchema = z.object({
  ok: z.literal(true),
  // This is also how an account with an authenticator asks for an email code instead.
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export type ResendMfaCodeResponse = z.infer<typeof resendMfaCodeResponseSchema>;

export const verifyMfaCodeRequestSchema = z.object({
  mfaSessionToken: z.string().min(1),
  code: z.string().min(1),
  trustDevice: z.boolean().optional(),
});

export type VerifyMfaCodeRequest = z.infer<typeof verifyMfaCodeRequestSchema>;

export const verifyMfaCodeResponseSchema = z.object({
  ok: z.literal(true),
  user: currentUserSchema,
});

export type VerifyMfaCodeResponse = z.infer<typeof verifyMfaCodeResponseSchema>;

export const trustedDeviceSchema = z.object({
  id: z.number().int().min(0),
  tokenPreview: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  lastUsed: z.number().int().nonnegative(),
});

export type TrustedDevice = z.infer<typeof trustedDeviceSchema>;

export const trustedDevicesResponseSchema = z.object({
  trustedDevices: z.array(trustedDeviceSchema),
});

export type TrustedDevicesResponse = z.infer<typeof trustedDevicesResponseSchema>;

export const mfaStatusResponseSchema = z.object({
  enabled: z.boolean(),
  emailMasked: z.string().nullable(),
  emailVerified: z.boolean(),
  trustedDevices: z.array(trustedDeviceSchema),
});

export type MfaStatusResponse = z.infer<typeof mfaStatusResponseSchema>;

export const revokeTrustedDeviceResponseSchema = z.object({
  ok: z.literal(true),
});

export type RevokeTrustedDeviceResponse = z.infer<typeof revokeTrustedDeviceResponseSchema>;

export const revokeAllTrustedDevicesResponseSchema = z.object({
  ok: z.literal(true),
  removed: z.number().int().min(0),
});

export type RevokeAllTrustedDevicesResponse = z.infer<typeof revokeAllTrustedDevicesResponseSchema>;

export const registerRequestSchema = z.object({
  username: z.string().min(1),
  email: z.string().min(1),
  password: z.string().min(1),
  // Required (true) only while the server asks people to accept the terms; the server checks it.
  agreedToTerms: z.boolean().optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const registerResponseSchema = z.object({
  ok: z.literal(true),
  verificationRequired: z.literal(true),
  registrationToken: z.string().min(1),
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const verifyRegistrationRequestSchema = z.object({
  registrationToken: z.string().min(1),
  code: z.string().min(1),
});

export type VerifyRegistrationRequest = z.infer<typeof verifyRegistrationRequestSchema>;

export const verifyRegistrationResponseSchema = z.object({
  ok: z.literal(true),
  user: currentUserSchema,
});

export type VerifyRegistrationResponse = z.infer<typeof verifyRegistrationResponseSchema>;

export const resendRegistrationRequestSchema = z.object({
  registrationToken: z.string().min(1),
});

export type ResendRegistrationRequest = z.infer<typeof resendRegistrationRequestSchema>;

export const resendRegistrationResponseSchema = z.object({
  ok: z.literal(true),
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export type ResendRegistrationResponse = z.infer<typeof resendRegistrationResponseSchema>;

export const forgotPasswordRequestSchema = z.object({
  username: z.string().min(1),
});

export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const forgotPasswordResponseSchema = z.object({
  ok: z.literal(true),
  message: z.string().min(1),
  // Constant-shape: server always returns a resetToken + emailMasked, even for
  // non-existent users (dummy entry server-side). Prevents user enumeration via
  // response-shape diffing.
  resetToken: z.string().min(1),
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export type ForgotPasswordResponse = z.infer<typeof forgotPasswordResponseSchema>;

export const resendPasswordResetRequestSchema = z.object({
  resetToken: z.string().min(1),
});

export type ResendPasswordResetRequest = z.infer<typeof resendPasswordResetRequestSchema>;

export const resendPasswordResetResponseSchema = z.object({
  ok: z.literal(true),
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export type ResendPasswordResetResponse = z.infer<typeof resendPasswordResetResponseSchema>;

export const verifyPasswordResetRequestSchema = z.object({
  resetToken: z.string().min(1),
  code: z.string().min(1),
});

export type VerifyPasswordResetRequest = z.infer<typeof verifyPasswordResetRequestSchema>;

export const verifyPasswordResetResponseSchema = z.object({
  ok: z.literal(true),
});

export type VerifyPasswordResetResponse = z.infer<typeof verifyPasswordResetResponseSchema>;

export const resetPasswordRequestSchema = z.object({
  resetToken: z.string().min(1),
  newPassword: z.string().min(1),
});

export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const resetPasswordResponseSchema = z.object({
  ok: z.literal(true),
});

export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;

export const logoutResponseSchema = z.object({
  ok: z.literal(true),
});

export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const changePasswordResponseSchema = z.object({
  ok: z.literal(true),
});

export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

// Authenticated set/change-email flow (2026-09-02). Admin-created
// accounts start with no email and previously had no way to add one, which
// permanently disabled MFA and the staged self-delete for them.
export const requestEmailChangeRequestSchema = z.object({
  email: z.string().min(1),
  currentPassword: z.string().min(1),
});

export type RequestEmailChangeRequest = z.infer<typeof requestEmailChangeRequestSchema>;

export const requestEmailChangeResponseSchema = z.object({
  ok: z.literal(true),
  emailToken: z.string().min(1),
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export type RequestEmailChangeResponse = z.infer<typeof requestEmailChangeResponseSchema>;

export const verifyEmailChangeRequestSchema = z.object({
  emailToken: z.string().min(1),
  code: z.string().min(1),
});

export type VerifyEmailChangeRequest = z.infer<typeof verifyEmailChangeRequestSchema>;

export const verifyEmailChangeResponseSchema = z.object({
  ok: z.literal(true),
  emailMasked: z.string().min(1),
});

export type VerifyEmailChangeResponse = z.infer<typeof verifyEmailChangeResponseSchema>;

export const requestAccountDeletionResponseSchema = z.object({
  ok: z.literal(true),
  deleteToken: z.string().min(1),
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export type RequestAccountDeletionResponse = z.infer<typeof requestAccountDeletionResponseSchema>;

export const resendAccountDeletionRequestSchema = z.object({
  deleteToken: z.string().min(1),
});

export type ResendAccountDeletionRequest = z.infer<typeof resendAccountDeletionRequestSchema>;

export const resendAccountDeletionResponseSchema = z.object({
  ok: z.literal(true),
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export type ResendAccountDeletionResponse = z.infer<typeof resendAccountDeletionResponseSchema>;

export const confirmAccountDeletionRequestSchema = z.object({
  deleteToken: z.string().min(1),
  code: z.string().min(1),
});

export type ConfirmAccountDeletionRequest = z.infer<typeof confirmAccountDeletionRequestSchema>;

export const confirmAccountDeletionResponseSchema = z.object({
  ok: z.literal(true),
  verified: z.literal(true),
});

export type ConfirmAccountDeletionResponse = z.infer<typeof confirmAccountDeletionResponseSchema>;

export const executeAccountDeletionRequestSchema = z.object({
  deleteToken: z.string().min(1),
});

export type ExecuteAccountDeletionRequest = z.infer<typeof executeAccountDeletionRequestSchema>;

export const executeAccountDeletionResponseSchema = z.object({
  ok: z.literal(true),
});

export type ExecuteAccountDeletionResponse = z.infer<typeof executeAccountDeletionResponseSchema>;

export const currentUserResponseSchema = z.union([
  z.object({
    authenticated: z.literal(false),
    user: z.null(),
  }),
  z.object({
    authenticated: z.literal(true),
    user: currentUserSchema,
  }),
]);

export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;

// ── Authenticator-app two-factor ─────────────────────────────────────────────────────────────────────────────────────

export const totpSetupSchema = z.object({
  // The key in groups of four, to type into an app by hand.
  key: z.string(),
  // The otpauth:// link: a QR code shows it, and tapping it on a phone opens the authenticator app.
  otpauthUri: z.string(),
  qrSvgDataUrl: z.string(),
});
export type TotpSetup = z.infer<typeof totpSetupSchema>;

/** Forced setup at sign-in (Required): the token from the sign-in response stands in for the session. */
export const startForcedTwoFactorSetupRequestSchema = z.object({
  setupToken: z.string().min(1),
});
export type StartForcedTwoFactorSetupRequest = z.infer<typeof startForcedTwoFactorSetupRequestSchema>;

export const confirmForcedTwoFactorSetupRequestSchema = z.object({
  setupToken: z.string().min(1),
  code: z.string().min(1),
  trustDevice: z.boolean().optional(),
});
export type ConfirmForcedTwoFactorSetupRequest = z.infer<typeof confirmForcedTwoFactorSetupRequestSchema>;

export const confirmForcedTwoFactorSetupResponseSchema = z.object({
  ok: z.literal(true),
  user: currentUserSchema,
  // Shown once.
  recoveryCodes: z.array(z.string()),
});
export type ConfirmForcedTwoFactorSetupResponse = z.infer<typeof confirmForcedTwoFactorSetupResponseSchema>;

/** The signed-in account's two-factor, and what the server allows. */
export const twoFactorStatusResponseSchema = z.object({
  policy: z.enum(["off", "optional", "required"]),
  methods: z.object({ totp: z.boolean(), email: z.boolean() }),
  totp: z.object({ enabled: z.boolean(), recoveryCodesLeft: z.number().int().min(0) }),
  // Email codes apply to this account: a verified address, the method on, and email working.
  email: z.object({ active: z.boolean() }),
});
export type TwoFactorStatusResponse = z.infer<typeof twoFactorStatusResponseSchema>;

export const startTotpRequestSchema = z.object({ password: z.string().min(1) });
export type StartTotpRequest = z.infer<typeof startTotpRequestSchema>;

export const confirmTotpRequestSchema = z.object({ code: z.string().min(1) });
export type ConfirmTotpRequest = z.infer<typeof confirmTotpRequestSchema>;

export const disableTotpRequestSchema = z.object({ password: z.string().min(1), code: z.string().min(1) });
export type DisableTotpRequest = z.infer<typeof disableTotpRequestSchema>;

export const regenerateRecoveryCodesRequestSchema = z.object({ password: z.string().min(1) });
export type RegenerateRecoveryCodesRequest = z.infer<typeof regenerateRecoveryCodesRequestSchema>;

export const recoveryCodesResponseSchema = z.object({
  ok: z.literal(true),
  // Shown once.
  recoveryCodes: z.array(z.string()),
});
export type RecoveryCodesResponse = z.infer<typeof recoveryCodesResponseSchema>;
