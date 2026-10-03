import { buildCustomChatModels, type ProviderKeyListResponse, type UpdateProviderKeysRequest } from "@tracyhill-rp/contracts";
import { CHAT_MODELS, getChatModel, type ChatModel } from "@tracyhill-rp/model-catalog";

import { apiFetch } from "../../shared/api/client";

export function getProviderKeys() {
  return apiFetch<ProviderKeyListResponse>("/api/provider-keys", { method: "GET" });
}

export function updateProviderKeys(payload: UpdateProviderKeysRequest) {
  return apiFetch<ProviderKeyListResponse>("/api/provider-keys", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

// The catalog row, widened for custom endpoints (provider is `custom:<id>`,
// no maxOutputTokens) — ONE type, not a hand-copied subset that drifts every
// time the catalog grows a flag.
export type AvailableChatModel = Omit<ChatModel, "provider" | "maxOutputTokens"> & {
  provider: string;
  maxOutputTokens?: number;
  providerLabel?: string;
  customEndpointId?: string;
  actualModelId?: string;
  apiFormat?: "chat-completions" | "responses";
};

export function buildAvailableChatModels(config?: ProviderKeyListResponse | null) {
  // Only surface models whose provider has a configured key (user or server) —
  // an unkeyed provider's models are dead weight in every picker (first visible
  // 2026-07-19: fireworks/gmicloud shipped as the first-ever keyless catalog
  // providers). Before the key config loads, keep the full catalog so pickers
  // don't flash empty; custom endpoints already self-gate (no key → skipped in
  // buildCustomChatModels). Removing a provider's key hides its models from
  // pickers; sessions still pointing at one keep working server-side until the
  // next model switch (labels resolve via getChatModel fallbacks).
  const providerStatus = config?.providers;
  const builtIn = providerStatus
    ? CHAT_MODELS.filter((model) => providerStatus[model.provider]?.configured)
    : CHAT_MODELS;
  return [
    ...builtIn,
    ...buildCustomChatModels(config?.customEndpoints ?? []).map((model) => ({
      ...model,
      supportsCacheTtl: false,
      supportsThinkingBudget: false,
      supportsAdaptiveThinking: false,
      supportsEffort: false,
      effortOptions: undefined,
      maxThinkingBudget: undefined,
    })),
  ] as AvailableChatModel[];
}

/** The deployment's default model (DEFAULT_MODEL_ID) when it is among this account's models, else null, so a picker
 *  that falls back to it never preselects a model the account cannot run. */
export function usableDefaultModelId(config: ProviderKeyListResponse | null | undefined, models: ReadonlyArray<{ id: string }>): string | null {
  const configured = config?.defaultModelOverride ?? null;
  return configured && models.some((model) => model.id === configured) ? configured : null;
}

/** Resolve the saved selection even after its key was removed. Never substitute a different model. */
export function getSavedChatModel(modelId: string | null, config?: ProviderKeyListResponse | null): AvailableChatModel | null {
  if (!modelId) return null;
  const builtin = getChatModel(modelId);
  if (builtin) return builtin;
  return buildAvailableChatModels(config ? { ...config, customEndpoints: config.customEndpoints.map((endpoint) => ({ ...endpoint, hasKey: true })) } : config)
    .find((model) => model.id === modelId) ?? null;
}
