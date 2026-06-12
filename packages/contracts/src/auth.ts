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

export const loginChallengeResponseSchema = z.object({
  mfaRequired: z.literal(true),
  mfaSessionToken: z.string().min(1),
  emailMasked: z.string().min(1),
  devVerificationCode: z.string().min(1).optional(),
});

export const loginResultSchema = z.union([loginResponseSchema, loginChallengeResponseSchema]);

export type LoginResponse = z.infer<typeof loginResultSchema>;

export const resendMfaCodeRequestSchema = z.object({
  mfaSessionToken: z.string().min(1),
});

export type ResendMfaCodeRequest = z.infer<typeof resendMfaCodeRequestSchema>;

export const resendMfaCodeResponseSchema = z.object({
  ok: z.literal(true),
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
  agreedToTerms: z.literal(true),
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
