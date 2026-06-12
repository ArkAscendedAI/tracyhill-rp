import { createChatRuntimeWithCustomEndpoints, createRegistryChatRuntime, createRegistryImageRuntime } from "@tracyhill-rp/provider-runtime";
import type { ProviderId } from "@tracyhill-rp/contracts";

import type { ProviderRuntimeDefaults } from "./providerKeyService";
import { CustomEndpointRepository } from "./customEndpointRepository";
import { ProviderKeyRepository } from "./providerKeyRepository";

export function resolveProviderRuntimeKeys(keys: ProviderKeyRepository, userId: string, defaults: ProviderRuntimeDefaults) {
  const stored = new Map(keys.listByUser(userId).map((row) => [row.provider as ProviderId, row.apiKey.trim()]));
  return {
    anthropicApiKey: stored.get("anthropic") || defaults.anthropicApiKey.trim(),
    claudeCodeBridgeSecret: defaults.claudeCodeBridgeSecret.trim(),
    claudeCodeBridgeUrl: defaults.claudeCodeBridgeUrl.trim(),
    deepseekApiKey: stored.get("deepseek") || defaults.deepseekApiKey.trim(),
    googleApiKey: stored.get("google") || defaults.googleApiKey.trim(),
    openaiApiKey: stored.get("openai") || defaults.openaiApiKey.trim(),
    xaiApiKey: stored.get("xai") || defaults.xaiApiKey.trim(),
    xiaomiApiKey: stored.get("xiaomi") || defaults.xiaomiApiKey.trim(),
    zaiApiKey: stored.get("zai") || defaults.zaiApiKey.trim(),
  };
}

export function createChatRuntimeForUser(
  keys: ProviderKeyRepository,
  endpoints: CustomEndpointRepository,
  userId: string,
  defaults: ProviderRuntimeDefaults,
) {
  return createChatRuntimeWithCustomEndpoints(
    createRegistryChatRuntime(resolveProviderRuntimeKeys(keys, userId, defaults)),
    endpoints.listByUser(userId),
  );
}

export function createImageRuntimeForUser(keys: ProviderKeyRepository, userId: string, defaults: ProviderRuntimeDefaults) {
  return createRegistryImageRuntime(resolveProviderRuntimeKeys(keys, userId, defaults));
}
