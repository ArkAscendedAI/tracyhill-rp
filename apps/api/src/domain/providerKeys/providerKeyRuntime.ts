import { createChatRuntimeWithCustomEndpoints, createClaudeSubscriptionRuntime, createRegistryChatRuntime, createRegistryImageRuntime } from "@tracyhill-rp/provider-runtime";
import type { ProviderId } from "@tracyhill-rp/contracts";

import type { ProviderRuntimeDefaults } from "./providerKeyService";
import { createCodexBridgeChatRuntime } from "./codexBridgeRuntime";
import { CustomEndpointRepository } from "./customEndpointRepository";
import { ProviderKeyRepository } from "./providerKeyRepository";
import type { ProviderConnectionRepository } from "../subscriptions/providerConnectionRepository";
import { SERVER_SUBSCRIPTION_HOME } from "../subscriptions/serverConnectionRepository";

export function resolveProviderRuntimeKeys(keys: ProviderKeyRepository, userId: string, defaults: ProviderRuntimeDefaults) {
  const stored = new Map(keys.listByUser(userId).map((row) => [row.provider as ProviderId, row.apiKey.trim()]));
  return {
    anthropicApiKey: stored.get("anthropic") || defaults.anthropicApiKey.trim(),
    deepseekApiKey: stored.get("deepseek") || defaults.deepseekApiKey.trim(),
    fireworksApiKey: stored.get("fireworks") || defaults.fireworksApiKey.trim(),
    gmicloudApiKey: stored.get("gmicloud") || defaults.gmicloudApiKey.trim(),
    googleApiKey: stored.get("google") || defaults.googleApiKey.trim(),
    moonshotApiKey: stored.get("moonshot") || defaults.moonshotApiKey.trim(),
    openaiApiKey: stored.get("openai") || defaults.openaiApiKey.trim(),
    xaiApiKey: stored.get("xai") || defaults.xaiApiKey.trim(),
    xiaomiApiKey: stored.get("xiaomi") || defaults.xiaomiApiKey.trim(),
    zaiApiKey: stored.get("zai") || defaults.zaiApiKey.trim(),
    // Local embeddings are env-level only (no per-user local endpoints) — pass through.
    localEmbeddingUrl: defaults.localEmbeddingUrl,
    localEmbeddingKey: defaults.localEmbeddingKey,
  };
}

/** The runner connection when the deployment has one; null hides both subscription paths. */
export function resolveRunner(defaults: ProviderRuntimeDefaults) {
  const runnerUrl = defaults.runnerUrl?.trim() ?? "";
  const runnerSecret = defaults.runnerSecret?.trim() ?? "";
  return runnerUrl && runnerSecret ? { runnerUrl, runnerSecret } : null;
}

/**
 * The per-user chat runtime. The two subscription paths exist only while the
 * user's own sign-in is recorded as connected,
 * or while the server-wide sign-in an administrator chose to share is
 * (the runner then uses its shared home); otherwise the registry answers with the
 * "not connected" message, never a silent fallback to another model.
 */
export function createChatRuntimeForUser(
  keys: ProviderKeyRepository,
  endpoints: CustomEndpointRepository,
  connections: ProviderConnectionRepository,
  userId: string,
  defaults: ProviderRuntimeDefaults,
) {
  const runner = resolveRunner(defaults);
  // The account's own sign-in wins; the shared one serves accounts without one.
  const homeFor = (provider: "claude" | "chatgpt") => (connections.isConnected(userId, provider) ? userId : connections.isServerConnected(provider) ? SERVER_SUBSCRIPTION_HOME : null);
  const claudeHome = runner ? homeFor("claude") : null;
  const chatgptHome = runner ? homeFor("chatgpt") : null;
  const claudeCodeRuntime = runner && claudeHome ? createClaudeSubscriptionRuntime({ ...runner, userId: claudeHome }) : null;
  const codexBridgeRuntime = runner && chatgptHome ? createCodexBridgeChatRuntime({ url: runner.runnerUrl, secret: runner.runnerSecret, userId: chatgptHome }) : null;
  return createChatRuntimeWithCustomEndpoints(
    createRegistryChatRuntime({
      ...resolveProviderRuntimeKeys(keys, userId, defaults),
      claudeCodeRuntime,
      codexBridgeRuntime,
    }),
    endpoints.listByUser(userId),
  );
}

export function createImageRuntimeForUser(keys: ProviderKeyRepository, userId: string, defaults: ProviderRuntimeDefaults) {
  return createRegistryImageRuntime(resolveProviderRuntimeKeys(keys, userId, defaults));
}
