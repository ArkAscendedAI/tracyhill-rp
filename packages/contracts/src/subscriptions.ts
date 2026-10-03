import { z } from "zod";

// Per-user subscription connections for the composer (2026-09-25): a user signs
// in to their own Claude subscription (through the unmodified Claude Code binary)
// or their own ChatGPT subscription (through the unmodified Codex app-server)
// inside the runner service. The app never sees a token — these shapes carry
// state and account identity only.

export const subscriptionProviderSchema = z.enum(["claude", "chatgpt"]);
export type SubscriptionProvider = z.infer<typeof subscriptionProviderSchema>;

export const SUBSCRIPTION_PROVIDERS = ["claude", "chatgpt"] as const satisfies readonly SubscriptionProvider[];

// Which catalog provider each subscription unlocks. The bridge model ids keep
// their `-bridge` / `-codex-bridge` suffixes; gating rides the existing
// provider-key status map (`providers["claude-code"].configured`).
export const SUBSCRIPTION_CATALOG_PROVIDER = {
  claude: "claude-code",
  chatgpt: "codex-bridge",
} as const;

export const subscriptionConnectionStatusSchema = z.enum(["connected", "expired", "disconnected"]);
export type SubscriptionConnectionStatus = z.infer<typeof subscriptionConnectionStatusSchema>;

export const subscriptionStatusSchema = z.object({
  provider: subscriptionProviderSchema,
  status: subscriptionConnectionStatusSchema,
  accountEmail: z.string().nullable(),
  accountOrg: z.string().nullable(),
  plan: z.string().nullable(),
  connectedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  // false when this deployment has no reachable runner (the feature is then
  // shown as unavailable instead of as a broken connection).
  available: z.boolean(),
});
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const subscriptionsResponseSchema = z.object({
  claude: subscriptionStatusSchema,
  chatgpt: subscriptionStatusSchema,
});
export type SubscriptionsResponse = z.infer<typeof subscriptionsResponseSchema>;

// How a started login finishes: Claude's flow hands the user a code on the
// provider's page to paste back ("paste-code"); ChatGPT's device-code flow
// completes on the provider's page and the client polls status ("poll").
export const subscriptionLoginCompletionSchema = z.enum(["paste-code", "poll"]);

export const subscriptionLoginStartResponseSchema = z.object({
  provider: subscriptionProviderSchema,
  loginId: z.string(),
  url: z.string(),
  userCode: z.string().nullable(),
  expiresAt: z.string(),
  completion: subscriptionLoginCompletionSchema,
});
export type SubscriptionLoginStartResponse = z.infer<typeof subscriptionLoginStartResponseSchema>;

// The Claude sign-in's account kind: the runner runs `claude auth login --claudeai` (a Claude.ai subscription, the
// default) or `--console` (an Anthropic Console account). ChatGPT's device flow has one kind and ignores it. Neither
// client sends it today; the start route reads it through this contract, where it
// used to take any string and drop anything else silently.
export const subscriptionLoginMethodSchema = z.enum(["claudeai", "console"]);
export type SubscriptionLoginMethod = z.infer<typeof subscriptionLoginMethodSchema>;

export const subscriptionLoginStartRequestSchema = z.object({
  method: subscriptionLoginMethodSchema.optional(),
});
export type SubscriptionLoginStartRequest = z.infer<typeof subscriptionLoginStartRequestSchema>;

export const subscriptionLoginCompleteRequestSchema = z.object({
  loginId: z.string().trim().min(1).max(128),
  // The code the provider's page shows (Claude). Bounded: an OAuth code is a
  // few hundred characters at most.
  code: z.string().trim().min(1).max(4096).optional(),
});
export type SubscriptionLoginCompleteRequest = z.infer<typeof subscriptionLoginCompleteRequestSchema>;

export const subscriptionLoginCancelRequestSchema = z.object({
  loginId: z.string().trim().min(1).max(128),
});
export type SubscriptionLoginCancelRequest = z.infer<typeof subscriptionLoginCancelRequestSchema>;

export function emptySubscriptionStatus(provider: SubscriptionProvider, available = true): SubscriptionStatus {
  return {
    provider,
    status: "disconnected",
    accountEmail: null,
    accountOrg: null,
    plan: null,
    connectedAt: null,
    verifiedAt: null,
    lastError: null,
    available,
  };
}
