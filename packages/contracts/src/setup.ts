import { z } from "zod";

import { currentUserSchema } from "./auth";

// First-run setup. A fresh deployment has no accounts; the one-time setup code
// printed in the server's log lets the person running the server create the first administrator. Whether setup is
// needed is part of the public sign-in options (serverSettings.ts, GET /api/auth/options).

export const verifySetupCodeRequestSchema = z.object({
  setupCode: z.string().min(1).max(64),
});

export type VerifySetupCodeRequest = z.infer<typeof verifySetupCodeRequestSchema>;

export const verifySetupCodeResponseSchema = z.object({
  ok: z.literal(true),
});

export type VerifySetupCodeResponse = z.infer<typeof verifySetupCodeResponseSchema>;

export const createFirstAdminRequestSchema = z.object({
  setupCode: z.string().min(1).max(64),
  username: z.string().min(1),
  password: z.string().min(1),
  // The setup browser's IANA time zone: the server's daily sign-out happens at 3 AM there.
  timeZone: z.string().max(64).optional(),
});

export type CreateFirstAdminRequest = z.infer<typeof createFirstAdminRequestSchema>;

export const createFirstAdminResponseSchema = z.object({
  ok: z.literal(true),
  user: currentUserSchema,
});

export type CreateFirstAdminResponse = z.infer<typeof createFirstAdminResponseSchema>;
