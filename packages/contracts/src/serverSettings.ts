import { z } from "zod";

import { providerIdSchema } from "./providerKeys";

// The in-app server settings. The administrator edits them in
// Admin: Server settings; a value an environment variable sets wins and is listed in `locked`.

export const registrationModeSchema = z.enum(["off", "open"]);
export type RegistrationMode = z.infer<typeof registrationModeSchema>;

export const emailProviderSchema = z.enum(["none", "sendgrid", "smtp"]);
export type EmailProvider = z.infer<typeof emailProviderSchema>;

export const smtpSecuritySchema = z.enum(["tls", "starttls", "none"]);
export type SmtpSecurity = z.infer<typeof smtpSecuritySchema>;

/** A stored secret as the page sees it: whether one is set, and its last four characters. Never the value. */
export const secretSummarySchema = z.object({
  configured: z.boolean(),
  last4: z.string().nullable(),
});
export type SecretSummary = z.infer<typeof secretSummarySchema>;

export const emailTestResultSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  to: z.string(),
  error: z.string().nullable(),
});
export type EmailTestResult = z.infer<typeof emailTestResultSchema>;

export const serverSettingsSchema = z.object({
  accounts: z.object({
    registration: registrationModeSchema,
    termsRequired: z.boolean(),
    // Blank means the built-in text.
    termsText: z.string(),
    privacyText: z.string(),
  }),
  email: z.object({
    provider: emailProviderSchema,
    fromAddress: z.string(),
    fromName: z.string(),
    sendgridApiKey: secretSummarySchema,
    smtpHost: z.string(),
    smtpPort: z.number().int(),
    smtpSecurity: smtpSecuritySchema,
    smtpUsername: z.string(),
    smtpPassword: secretSummarySchema,
    // Working: configured in the environment, or a test email succeeded with the current settings.
    working: z.boolean(),
    source: z.enum(["environment", "settings", "none"]),
    lastTest: emailTestResultSchema.nullable(),
  }),
  sessions: z.object({
    signOutHour: z.number().int().min(0).max(23),
    timeZone: z.string(),
  }),
  // Two-factor: Off asks for nothing; Optional asks people who set a factor up; Required asks everyone, and
  // anyone without a factor sets up an authenticator at their next sign-in. Email codes need working email and a
  // verified address.
  twoFactor: z.object({
    policy: z.enum(["off", "optional", "required"]),
    totp: z.boolean(),
    email: z.boolean(),
  }),
  // Where new sessions start: the server-wide world stance and depiction tier written into
  // every session that does not inherit a campaign's settings. `builtIn` is what applies when the server sets none.
  sessionDefaults: z.object({
    worldStance: z.number().int().min(0).max(4),
    depictionTier: z.number().int().min(0).max(3),
    builtIn: z.object({ worldStance: z.number().int(), depictionTier: z.number().int() }),
  }),
  // Server-wide API keys: every account on the server can use them, and the server owner pays.
  // An account's own key wins; a key set in the environment wins over one set here and shows locked.
  sharedKeys: z.record(z.string(), z.object({
    source: z.enum(["environment", "settings", "none"]),
    configured: z.boolean(),
    last4: z.string().nullable(),
  })),
  // Dotted names of the fields an environment variable sets ("email.provider", …); the page shows them locked.
  locked: z.array(z.string()),
  // Read-only facts from the environment, for the Server page.
  environment: z.object({
    trustProxy: z.string(),
    allowedIps: z.string(),
    codingPanels: z.object({ claudeCode: z.boolean(), codex: z.boolean(), kimi: z.boolean() }),
  }),
});
export type ServerSettings = z.infer<typeof serverSettingsSchema>;

const secretInput = z.string().trim().min(1).max(500);

export const updateServerSettingsRequestSchema = z.object({
  accounts: z.object({
    registration: registrationModeSchema.optional(),
    termsRequired: z.boolean().optional(),
    termsText: z.string().max(20_000).optional(),
    privacyText: z.string().max(20_000).optional(),
  }).strict().optional(),
  email: z.object({
    provider: emailProviderSchema.optional(),
    fromAddress: z.string().trim().max(254).optional(),
    fromName: z.string().trim().max(100).optional(),
    // A string replaces the stored secret, null removes it, absent keeps it.
    sendgridApiKey: secretInput.nullable().optional(),
    smtpHost: z.string().trim().max(253).optional(),
    smtpPort: z.number().int().min(1).max(65_535).optional(),
    smtpSecurity: smtpSecuritySchema.optional(),
    smtpUsername: z.string().trim().max(254).optional(),
    smtpPassword: secretInput.nullable().optional(),
  }).strict().optional(),
  sessions: z.object({
    signOutHour: z.number().int().min(0).max(23).optional(),
    timeZone: z.string().trim().min(1).max(64).optional(),
  }).strict().optional(),
  twoFactor: z.object({
    policy: z.enum(["off", "optional", "required"]).optional(),
    totp: z.boolean().optional(),
    email: z.boolean().optional(),
  }).strict().optional(),
  // Server-wide API keys by provider: a string replaces the stored key, null removes it.
  sharedKeys: z.record(providerIdSchema, z.string().trim().min(1).max(500).nullable()).optional(),
  // A number sets the server-wide starting value; null returns to the built-in default.
  sessionDefaults: z.object({
    worldStance: z.number().int().min(0).max(4).nullable().optional(),
    depictionTier: z.number().int().min(0).max(3).nullable().optional(),
  }).strict().optional(),
}).strict();
export type UpdateServerSettingsRequest = z.infer<typeof updateServerSettingsRequestSchema>;

export const sendTestEmailRequestSchema = z.object({
  to: z.string().trim().min(3).max(254),
});
export type SendTestEmailRequest = z.infer<typeof sendTestEmailRequestSchema>;

export const sendTestEmailResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  settings: serverSettingsSchema,
});
export type SendTestEmailResponse = z.infer<typeof sendTestEmailResponseSchema>;

/** Public, before sign-in: what the sign-in pages offer on this server. */
export const authOptionsResponseSchema = z.object({
  // True while the deployment has no account at all (first-run setup).
  setupRequired: z.boolean(),
  // Sign-up is open and email works (sign-up verifies the address with a code).
  registrationOpen: z.boolean(),
  // Email works, so a forgotten password can be reset by email.
  passwordResetAvailable: z.boolean(),
  // Sign-up asks people to accept the terms.
  termsRequired: z.boolean(),
});
export type AuthOptionsResponse = z.infer<typeof authOptionsResponseSchema>;

/** Public: the server's terms and privacy text; blank means the built-in text. */
export const legalTextResponseSchema = z.object({
  termsText: z.string(),
  privacyText: z.string(),
});
export type LegalTextResponse = z.infer<typeof legalTextResponseSchema>;
