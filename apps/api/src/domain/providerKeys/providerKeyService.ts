import { customEndpointModelSchema, type ProviderId, type ProviderKeyListResponse, type ProviderKeyStatusMap, type UpdateProviderKeysRequest } from "@tracyhill-rp/contracts";

import { HttpError } from "../../lib/httpError";
import type { ApiEnv } from "../../config/env";
import { assertPublicHostname, parseAllowedHosts } from "../../lib/safeUrl";
import type { UserRepository } from "../users/userRepository";
import { CustomEndpointRepository } from "./customEndpointRepository";
import { ProviderKeyRepository } from "./providerKeyRepository";

export const PROVIDER_IDS = ["anthropic", "claude-code", "deepseek", "google", "openai", "xai", "xiaomi", "zai"] as const satisfies ProviderId[];

export type ProviderRuntimeDefaults = Pick<ApiEnv, "anthropicApiKey" | "claudeCodeBridgeUrl" | "claudeCodeBridgeSecret" | "deepseekApiKey" | "googleApiKey" | "openaiApiKey" | "xaiApiKey" | "xiaomiApiKey" | "zaiApiKey">;

export class ProviderKeyService {
  private readonly allowedCustomEndpointHosts: ReadonlySet<string>;

  constructor(
    private readonly users: UserRepository,
    private readonly keys: ProviderKeyRepository,
    private readonly endpoints: CustomEndpointRepository,
    private readonly runtimeDefaults: ProviderRuntimeDefaults,
    customEndpointAllowHosts: string = "",
  ) {
    this.allowedCustomEndpointHosts = parseAllowedHosts(customEndpointAllowHosts);
  }

  listKeys(userId: string): ProviderKeyListResponse {
    this.assertUser(userId);
    const stored = new Map(this.keys.listByUser(userId).map((row) => [row.provider as ProviderId, row]));
    const providers = PROVIDER_IDS.reduce<ProviderKeyStatusMap>((acc, provider) => {
      const row = stored.get(provider);
      if (row) {
        acc[provider] = {
          source: "user",
          configured: true,
          keyPreview: maskKey(row.apiKey),
          updatedAt: row.updatedAt,
        };
        return acc;
      }
      const fallback = getRuntimeDefault(this.runtimeDefaults, provider);
      acc[provider] = {
        source: fallback ? "server" : "none",
        configured: Boolean(fallback),
        keyPreview: null,
        updatedAt: null,
      };
      return acc;
    }, {
      anthropic: emptyStatus(),
      "claude-code": emptyStatus(),
      deepseek: emptyStatus(),
      google: emptyStatus(),
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
        updatedAt: endpoint.updatedAt,
      })),
    };
  }

  async updateKeys(userId: string, input: UpdateProviderKeysRequest) {
    this.assertUser(userId);
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
    for (const provider of PROVIDER_IDS) {
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
      const sanitized = input.customEndpoints.slice(0, 20).flatMap((endpoint) => {
        const endpointId = endpoint.id?.trim() && /^ep_[a-z0-9]{6,12}$/.test(endpoint.id.trim())
          ? endpoint.id.trim()
          : `ep_${Math.random().toString(16).slice(2, 10)}`;
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
  };
}

function maskKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= 4 ? "••••" : `••••${trimmed.slice(-4)}`;
}

function getRuntimeDefault(defaults: ProviderRuntimeDefaults, provider: ProviderId) {
  if (provider === "anthropic") return defaults.anthropicApiKey.trim();
  // claude-code is "configured" when both the bridge URL and secret are set
  // server-side. Users don't supply per-user keys for it.
  if (provider === "claude-code") return defaults.claudeCodeBridgeUrl.trim() && defaults.claudeCodeBridgeSecret.trim() ? defaults.claudeCodeBridgeSecret.trim() : "";
  if (provider === "deepseek") return defaults.deepseekApiKey.trim();
  if (provider === "google") return defaults.googleApiKey.trim();
  if (provider === "openai") return defaults.openaiApiKey.trim();
  if (provider === "xai") return defaults.xaiApiKey.trim();
  if (provider === "xiaomi") return defaults.xiaomiApiKey.trim();
  return defaults.zaiApiKey.trim();
}
