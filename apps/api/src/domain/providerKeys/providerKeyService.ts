import { customEndpointModelSchema, isServerManagedProvider, SERVER_MANAGED_PROVIDER_IDS, type ProviderId, type ProviderKeyListResponse, type ProviderKeyStatusMap, type UpdateProviderKeysRequest, type UserManagedProviderId } from "@tracyhill-rp/contracts";
import { buildSubscriptionsResponse } from "../subscriptions/subscriptionStatus";
import type { ProviderConnectionRepository } from "../subscriptions/providerConnectionRepository";
import { getConfiguredDefaultModelId } from "@tracyhill-rp/model-catalog";

import { HttpError } from "../../lib/httpError";
import type { ApiEnv } from "../../config/env";
import { assertPublicHostname, parseAllowedHosts } from "../../lib/safeUrl";
import type { UserRepository } from "../users/userRepository";
import { CustomEndpointRepository } from "./customEndpointRepository";
import { ProviderKeyRepository } from "./providerKeyRepository";

export const PROVIDER_IDS = ["anthropic", "claude-code", "codex-bridge", "deepseek", "fireworks", "gmicloud", "google", "moonshot", "openai", "xai", "xiaomi", "zai"] as const satisfies ProviderId[];
// The set itself lives in contracts (shared with the web dialog).
export const SERVER_MANAGED_PROVIDERS = new Set<ProviderId>(SERVER_MANAGED_PROVIDER_IDS);
const USER_MANAGED_PROVIDER_IDS = PROVIDER_IDS.filter((provider): provider is UserManagedProviderId => !isServerManagedProvider(provider));

// Server-level fallbacks for the per-token providers plus the subscription
// runner connection (2026-09-25). The two subscription providers have no key:
// they exist per user through the runner.
export type ProviderRuntimeDefaults = Pick<ApiEnv, "anthropicApiKey" | "deepseekApiKey" | "fireworksApiKey" | "gmicloudApiKey" | "googleApiKey" | "moonshotApiKey" | "openaiApiKey" | "xaiApiKey" | "xiaomiApiKey" | "zaiApiKey" | "localEmbeddingUrl" | "localEmbeddingKey">
  & Partial<Pick<ApiEnv, "runnerUrl" | "runnerSecret">>;

export class ProviderKeyService {
  private readonly allowedCustomEndpointHosts: ReadonlySet<string>;

  constructor(
    private readonly users: UserRepository,
    private readonly keys: ProviderKeyRepository,
    private readonly endpoints: CustomEndpointRepository,
    private readonly connections: ProviderConnectionRepository,
    private readonly runtimeDefaults: ProviderRuntimeDefaults,
    customEndpointAllowHosts: string = "",
  ) {
    this.allowedCustomEndpointHosts = parseAllowedHosts(customEndpointAllowHosts);
  }

  listKeys(userId: string): ProviderKeyListResponse {
    this.assertUser(userId);
    const stored = new Map(this.keys.listByUser(userId).map((row) => [row.provider as ProviderId, row]));
    const runnerConfigured = Boolean(this.runtimeDefaults.runnerUrl?.trim() && this.runtimeDefaults.runnerSecret?.trim());
    const subscriptions = buildSubscriptionsResponse(this.connections.listByUser(userId), runnerConfigured);
    const providers = PROVIDER_IDS.reduce<ProviderKeyStatusMap>((acc, provider) => {
      if (provider === "claude-code" || provider === "codex-bridge") {
        // Subscription providers: "configured" means THIS user's own sign-in is
        // connected through the runner. Every picker keys on this flag, so the
        // bridge models stay hidden until a sign-in succeeds.
        const status = provider === "claude-code" ? subscriptions.claude : subscriptions.chatgpt;
        const connected = runnerConfigured && status.status === "connected";
        // The server-wide sign-in serves an account that has none of its own.
        const shared = runnerConfigured && !connected && this.connections.isServerConnected(provider === "claude-code" ? "claude" : "chatgpt");
        acc[provider] = { source: connected ? "user" : shared ? "server" : "none", configured: connected || shared, keyPreview: null, updatedAt: status.verifiedAt ?? status.connectedAt, needsReentry: false };
        return acc;
      }
      const row = stored.get(provider);
      if (row && !SERVER_MANAGED_PROVIDERS.has(provider)) {
        if (row.unreadable) {
          // Stored but undecryptable: report it as absent so older
          // clients show "not configured", and flag re-entry for newer ones.
          // No server fallback is claimed either — the runtime DOES fall back
          // to an env key when one exists, but the user's intent was their own
          // key, and "configured" here would hide that it is gone.
          acc[provider] = {
            source: "none",
            configured: false,
            keyPreview: null,
            updatedAt: row.updatedAt,
            needsReentry: true,
          };
          return acc;
        }
        acc[provider] = {
          source: "user",
          configured: true,
          keyPreview: maskKey(row.apiKey),
          updatedAt: row.updatedAt,
          needsReentry: false,
        };
        return acc;
      }
      const fallback = getRuntimeDefault(this.runtimeDefaults, provider);
      acc[provider] = {
        source: fallback ? "server" : "none",
        configured: Boolean(fallback),
        keyPreview: null,
        updatedAt: null,
        needsReentry: false,
      };
      return acc;
    }, {
      anthropic: emptyStatus(),
      "claude-code": emptyStatus(),
      "codex-bridge": emptyStatus(),
      deepseek: emptyStatus(),
      fireworks: emptyStatus(),
      gmicloud: emptyStatus(),
      google: emptyStatus(),
      moonshot: emptyStatus(),
      openai: emptyStatus(),
      xai: emptyStatus(),
      xiaomi: emptyStatus(),
      zai: emptyStatus(),
    });
    return {
      providers,
      customEndpoints: this.endpoints.listByUser(userId).map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        apiFormat: endpoint.apiFormat,
        authHeader: endpoint.authHeader,
        models: endpoint.models,
        hasKey: endpoint.hasKey,
        keyNeedsReentry: Boolean(endpoint.keyUnreadable),
        updatedAt: endpoint.updatedAt,
      })),
      defaultModelOverride: getConfiguredDefaultModelId(),
      subscriptions,
    };
  }

  async updateKeys(userId: string, input: UpdateProviderKeysRequest) {
    this.assertUser(userId);
    // Bridge providers are server-managed; the request schema no longer carries
    // their keys, so the old 400 guard here was unreachable.
    if (Array.isArray(input.customEndpoints)) {
      // Validate every baseUrl before touching the DB. Throws HttpError(400, ...) on bad URL.
      // Allowlist (set via CUSTOM_ENDPOINT_ALLOW_HOSTS env var) lets operators opt-in to LAN endpoints.
      await Promise.all(input.customEndpoints.slice(0, 20).map(async (endpoint) => {
        // Schema already validated the URL parses; this is the IP-resolution layer.
        const url = new URL(endpoint.baseUrl.trim());
        await assertPublicHostname(url.hostname.replace(/^\[|\]$/g, ""), this.allowedCustomEndpointHosts);
      }));
    }
    const now = new Date().toISOString();
    for (const provider of USER_MANAGED_PROVIDER_IDS) {
      if (!(provider in input)) continue;
      const raw = input[provider];
      const value = typeof raw === "string" ? raw.trim() : raw;
      if (!value) {
        this.keys.deleteForUserProvider(userId, provider);
        continue;
      }
      this.keys.upsert({
        userId,
        provider,
        apiKey: value,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (Array.isArray(input.customEndpoints)) {
      const existing = new Map(this.endpoints.listByUser(userId).map((endpoint) => [endpoint.id, endpoint]));
      // Ids are validated individually by the schema; a repeated id used to reach
      // the transactional replace and die on the PRIMARY KEY as a 500 with the
      // whole list rolled back. Reject up front as a 400.
      const seenIds = new Set<string>();
      const sanitized = input.customEndpoints.slice(0, 20).flatMap((endpoint) => {
        const endpointId = endpoint.id?.trim() && /^ep_[a-z0-9]{6,12}$/.test(endpoint.id.trim())
          ? endpoint.id.trim()
          : `ep_${Math.random().toString(16).slice(2, 10)}`;
        if (seenIds.has(endpointId)) throw new HttpError(400, `duplicate custom endpoint id ${endpointId}`);
        seenIds.add(endpointId);
        const previous = existing.get(endpointId);
        const name = endpoint.name.trim().slice(0, 64);
        const baseUrl = endpoint.baseUrl.trim().slice(0, 512);
        if (!name || !baseUrl) return [];
        const models = endpoint.models.slice(0, 50).flatMap((model) => {
          const result = customEndpointModelSchema.safeParse(model);
          if (!result.success) return [];
          return [{
            id: result.data.id,
            label: (result.data.label || result.data.id).slice(0, 128),
            maxOut: result.data.maxOut,
            ctx: result.data.ctx,
          }];
        });
        return [{
          id: endpointId,
          name,
          baseUrl,
          apiKey: typeof endpoint.apiKey === "string" ? endpoint.apiKey.slice(0, 512) : (previous?.apiKey ?? ""),
          apiFormat: endpoint.apiFormat,
          authHeader: endpoint.authHeader,
          models,
          hasKey: Boolean((typeof endpoint.apiKey === "string" ? endpoint.apiKey : previous?.apiKey ?? "").trim()),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        }];
      });
      this.endpoints.replaceForUser(userId, sanitized);
    }
    return this.listKeys(userId);
  }

  private assertUser(userId: string) {
    if (!this.users.findById(userId)) throw new HttpError(401, "user not found");
  }
}

function emptyStatus() {
  return {
    source: "none" as const,
    configured: false,
    keyPreview: null,
    updatedAt: null,
    needsReentry: false,
  };
}

function maskKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= 4 ? "••••" : `••••${trimmed.slice(-4)}`;
}

function getRuntimeDefault(defaults: ProviderRuntimeDefaults, provider: ProviderId) {
  if (provider === "anthropic") return defaults.anthropicApiKey.trim();
  // The subscription providers have no server key (per-user sign-ins through the runner).
  if (provider === "claude-code" || provider === "codex-bridge") return "";
  if (provider === "deepseek") return defaults.deepseekApiKey.trim();
  if (provider === "fireworks") return defaults.fireworksApiKey.trim();
  if (provider === "gmicloud") return defaults.gmicloudApiKey.trim();
  if (provider === "google") return defaults.googleApiKey.trim();
  if (provider === "moonshot") return defaults.moonshotApiKey.trim();
  if (provider === "openai") return defaults.openaiApiKey.trim();
  if (provider === "xai") return defaults.xaiApiKey.trim();
  if (provider === "xiaomi") return defaults.xiaomiApiKey.trim();
  return defaults.zaiApiKey.trim();
}
