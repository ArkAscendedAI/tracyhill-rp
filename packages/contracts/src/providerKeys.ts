import { z } from "zod";

import { subscriptionsResponseSchema } from "./subscriptions";

export const providerIdSchema = z.enum(["anthropic", "claude-code", "codex-bridge", "deepseek", "fireworks", "gmicloud", "google", "moonshot", "openai", "xai", "xiaomi", "zai"]);

export type ProviderId = z.infer<typeof providerIdSchema>;

// Bridge providers are configured server-side (env), never per user — the API
// rejects a per-user key for them. Shared here so clients and the service agree
// on the set instead of each carrying its own copy.
export const SERVER_MANAGED_PROVIDER_IDS = ["claude-code", "codex-bridge"] as const satisfies readonly ProviderId[];
export type ServerManagedProviderId = (typeof SERVER_MANAGED_PROVIDER_IDS)[number];
export type UserManagedProviderId = Exclude<ProviderId, ServerManagedProviderId>;

export function isServerManagedProvider(provider: ProviderId): provider is ServerManagedProviderId {
  return (SERVER_MANAGED_PROVIDER_IDS as readonly ProviderId[]).includes(provider);
}

export const providerKeySourceSchema = z.enum(["none", "user", "server"]);

export type ProviderKeySource = z.infer<typeof providerKeySourceSchema>;

export const providerKeyStatusSchema = z.object({
  source: providerKeySourceSchema,
  configured: z.boolean(),
  keyPreview: z.string().nullable(),
  updatedAt: z.string().nullable(),
  // A stored per-user key exists but can no longer be decrypted (the server's
  // SESSION_SECRET was rotated, or the row is corrupt). Reported as
  // source:"none"/configured:false so older clients simply show "not
  // configured"; newer ones can prompt for re-entry.
  // Optional (not defaulted) so client fixtures typed by this schema's output
  // stay valid; the server always sets it explicitly.
  needsReentry: z.boolean().optional(),
});

export type ProviderKeyStatus = z.infer<typeof providerKeyStatusSchema>;

export const providerKeyStatusMapSchema = z.object({
  anthropic: providerKeyStatusSchema,
  "claude-code": providerKeyStatusSchema,
  "codex-bridge": providerKeyStatusSchema,
  deepseek: providerKeyStatusSchema,
  fireworks: providerKeyStatusSchema,
  gmicloud: providerKeyStatusSchema,
  google: providerKeyStatusSchema,
  moonshot: providerKeyStatusSchema,
  openai: providerKeyStatusSchema,
  xai: providerKeyStatusSchema,
  xiaomi: providerKeyStatusSchema,
  zai: providerKeyStatusSchema,
});

export type ProviderKeyStatusMap = z.infer<typeof providerKeyStatusMapSchema>;

export const providerKeyListResponseSchema = z.object({
  providers: providerKeyStatusMapSchema,
  customEndpoints: z.array(z.object({
    id: z.string(),
    name: z.string(),
    baseUrl: z.string(),
    apiFormat: z.enum(["chat-completions", "responses"]),
    authHeader: z.enum(["Bearer", "api-key", "none"]),
    models: z.array(z.object({
      id: z.string(),
      label: z.string(),
      maxOut: z.number().int().positive(),
      ctx: z.number().int().positive(),
    })),
    hasKey: z.boolean(),
    // Same re-entry signal as providerKeyStatusSchema.needsReentry, for a stored
    // endpoint key that no longer decrypts (hasKey is false in that case).
    keyNeedsReentry: z.boolean().optional(),
    updatedAt: z.string().nullable().default(null),
  })).default([]),
  // Deployment-level DEFAULT_MODEL_ID override, resolved server-side (null when
  // unset/invalid). The client applies it wherever it would otherwise use a
  // shipped default: wizard model init, Engine-panel effective dial defaults,
  // pipeline-dialog model pickers. Browser bundles can't read the server env,
  // so this bootstrap field is the only honest source.
  defaultModelOverride: z.string().nullable().default(null),
  // Per-user subscription connections (2026-09-25). Optional so older clients
  // and fixtures typed by this schema's output stay valid; the server always
  // sets it. The two bridge entries of `providers` above report
  // `source:"user", configured:true` only while the matching connection is
  // `connected`, which is what every picker keys on.
  subscriptions: subscriptionsResponseSchema.optional(),
});

export type ProviderKeyListResponse = z.infer<typeof providerKeyListResponseSchema>;

export const customEndpointModelSchema = z.object({
  id: z.string().trim().min(1).max(128),
  label: z.string().trim().max(128).optional().default(""),
  maxOut: z.number().int().positive().max(2_097_152).optional().default(4096),
  ctx: z.number().int().positive().max(10_000_000).optional().default(128000),
});

export type CustomEndpointModel = z.infer<typeof customEndpointModelSchema>;

export const customEndpointApiFormatSchema = z.enum(["chat-completions", "responses"]);

export type CustomEndpointApiFormat = z.infer<typeof customEndpointApiFormatSchema>;

export const customEndpointAuthHeaderSchema = z.enum(["Bearer", "api-key", "none"]);

export type CustomEndpointAuthHeader = z.infer<typeof customEndpointAuthHeaderSchema>;

export const customEndpointInputSchema = z.object({
  id: z.string().trim().regex(/^ep_[a-z0-9]{6,12}$/).optional(),
  name: z.string().trim().min(1).max(64),
  baseUrl: z.string().trim().min(1).max(512).refine((value) => {
    try {
      const url = new URL(value);
      // Require https for every endpoint, allow-listed or not. The private-IP
      // check (assertPublicHostname) runs only when the endpoint is saved, and a host
      // named in CUSTOM_ENDPOINT_ALLOW_HOSTS skips it, so https is what closes the
      // save-time→fetch-time DNS-rebind window (an http rebind to e.g. 169.254.169.254
      // had no cert barrier; an https one fails the handshake against the metadata
      // host). It is also what refuses a plain-http LAN server: LM Studio or Ollama
      // works only over https, on a host name the operator allow-lists.
      if (url.protocol !== "https:") return false;
      // No userinfo (would mask credentials and confuse SSRF detection)
      if (url.username || url.password) return false;
      return true;
    } catch { return false; }
  }, { message: "baseUrl must be a valid https:// URL with no userinfo" }),
  apiKey: z.string().max(512).nullish(),
  apiFormat: customEndpointApiFormatSchema.default("chat-completions"),
  authHeader: customEndpointAuthHeaderSchema.default("Bearer"),
  models: z.array(customEndpointModelSchema).max(50).default([]),
});

export type CustomEndpointInput = z.infer<typeof customEndpointInputSchema>;

// Server-internal shape (repository/runtime) — carries the DECRYPTED key, so it
// is deliberately a plain type and not a Zod schema: a schema of this shape
// invited being wired as a response validator, which would have leaked keys.
// Response shapes live in providerKeyListResponseSchema.
export type CustomEndpointSummary = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: CustomEndpointApiFormat;
  authHeader: CustomEndpointAuthHeader;
  models: CustomEndpointModel[];
  hasKey: boolean;
  // Stored key present but undecryptable (secret rotation) — see
  // providerKeyStatusSchema.needsReentry.
  keyUnreadable?: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

// Bridge providers (SERVER_MANAGED_PROVIDER_IDS) are deliberately absent: they
// are env-configured and the service rejected a per-user key for them anyway.
// Unknown keys are stripped by Zod, so an older client
// that still sends them gets a 400 only when nothing else is in the body.
export const updateProviderKeysRequestSchema = z.object({
  anthropic: z.string().trim().min(1).nullable().optional(),
  deepseek: z.string().trim().min(1).nullable().optional(),
  fireworks: z.string().trim().min(1).nullable().optional(),
  gmicloud: z.string().trim().min(1).nullable().optional(),
  google: z.string().trim().min(1).nullable().optional(),
  moonshot: z.string().trim().min(1).nullable().optional(),
  openai: z.string().trim().min(1).nullable().optional(),
  xai: z.string().trim().min(1).nullable().optional(),
  xiaomi: z.string().trim().min(1).nullable().optional(),
  zai: z.string().trim().min(1).nullable().optional(),
  customEndpoints: z.array(customEndpointInputSchema).max(20).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "at least one provider key update is required",
});

export type UpdateProviderKeysRequest = z.infer<typeof updateProviderKeysRequestSchema>;

export type CustomChatModel = {
  id: string;
  label: string;
  provider: `custom:${string}`;
  providerLabel: string;
  ctx: number;
  maxOut: number;
  customEndpointId: string;
  actualModelId: string;
  apiFormat: CustomEndpointApiFormat;
};

function buildCustomChatModelId(endpointId: string, modelId: string) {
  return `custom:${endpointId}:${modelId}`;
}

export function parseCustomChatModelId(value: string) {
  const match = /^custom:([^:]+):(.+)$/.exec(value.trim());
  if (!match) return null;
  return {
    endpointId: match[1]!,
    modelId: match[2]!,
  };
}

export function buildCustomChatModels(endpoints: Array<Pick<CustomEndpointSummary, "id" | "name" | "apiFormat" | "authHeader" | "hasKey" | "models">>) {
  const models: CustomChatModel[] = [];
  for (const endpoint of endpoints) {
    if (!endpoint.hasKey && endpoint.authHeader !== "none") continue;
    for (const model of endpoint.models) {
      models.push({
        id: buildCustomChatModelId(endpoint.id, model.id),
        label: model.label || model.id,
        provider: `custom:${endpoint.id}`,
        providerLabel: endpoint.name,
        ctx: model.ctx || 128000,
        maxOut: model.maxOut || 4096,
        customEndpointId: endpoint.id,
        actualModelId: model.id,
        apiFormat: endpoint.apiFormat,
      });
    }
  }
  return models;
}
