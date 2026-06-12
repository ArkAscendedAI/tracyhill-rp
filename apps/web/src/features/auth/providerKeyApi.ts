import { buildCustomChatModels, type ProviderKeyListResponse, type UpdateProviderKeysRequest } from "@tracyhill-rp/contracts";
import { CHAT_MODELS } from "@tracyhill-rp/model-catalog";

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

export type AvailableChatModel = {
  id: string;
  label: string;
  provider: string;
  providerLabel?: string;
  ctx?: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
  cacheReadCostPerMillionTokens?: number;
  cacheWrite5mCostPerMillionTokens?: number;
  cacheWrite1hCostPerMillionTokens?: number;
  supportsCacheTtl?: boolean;
  supportsThinkingBudget?: boolean;
  supportsAdaptiveThinking?: boolean;
  supportsToggleThinking?: boolean;
  supportsEffort?: boolean;
  effortOptions?: Array<"minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
  maxThinkingBudget?: number;
  customEndpointId?: string;
  actualModelId?: string;
  apiFormat?: "chat-completions" | "responses";
};

export function buildAvailableChatModels(config?: ProviderKeyListResponse | null) {
  return [
    ...CHAT_MODELS,
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
