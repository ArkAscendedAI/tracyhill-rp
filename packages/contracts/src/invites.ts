import { z } from "zod";

import { currentUserSchema } from "./auth";

// One-time invite links. An administrator makes one and sends it any
// way they like; the person picks a username (unless the invite fixes one) and their own password. Works with sign-up
// off and without email.

export const inviteRoleSchema = z.enum(["user", "admin"]);

export const inviteSchema = z.object({
  id: z.string(),
  role: inviteRoleSchema,
  // A fixed username, or null for "the person picks one".
  username: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  usedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  status: z.enum(["open", "used", "expired", "revoked"]),
});
export type Invite = z.infer<typeof inviteSchema>;

export const createInviteRequestSchema = z.object({
  role: inviteRoleSchema.default("user"),
  username: z.string().trim().min(2).max(30).optional(),
  days: z.number().int().min(1).max(30).default(7),
});
export type CreateInviteRequest = z.input<typeof createInviteRequestSchema>;

export const createInviteResponseSchema = z.object({
  ok: z.literal(true),
  invite: inviteSchema,
  // Shown once; the link is <server>/invite/<token>.
  token: z.string(),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

export const listInvitesResponseSchema = z.object({ invites: z.array(inviteSchema) });
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;

/** Public: what the invite page needs before the form, without revealing who made the invite. */
export const peekInviteResponseSchema = z.object({
  valid: z.boolean(),
  username: z.string().nullable(),
  termsRequired: z.boolean(),
  // Why an invite cannot be used ("used", "expired"…); null while it can.
  reason: z.string().nullable(),
});
export type PeekInviteResponse = z.infer<typeof peekInviteResponseSchema>;

export const acceptInviteRequestSchema = z.object({
  token: z.string().min(1).max(200),
  username: z.string().min(1),
  password: z.string().min(1),
  agreedToTerms: z.boolean().optional(),
});
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

/** Signed in, or (two-factor Required) an authenticator to set up first, as at sign-in. */
export const acceptInviteResponseSchema = z.union([
  z.object({ ok: z.literal(true), user: currentUserSchema }),
  z.object({ twoFactorSetupRequired: z.literal(true), setupToken: z.string().min(1) }),
]);
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
