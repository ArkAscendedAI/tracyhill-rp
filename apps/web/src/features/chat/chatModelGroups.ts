import type { AvailableChatModel } from "../auth/providerKeyApi";

// The chat model menu's provider groups (moved out of SessionConversation for a test:
// Fireworks and GMICloud headed their groups with the raw ids "fireworks" / "gmicloud").

export function buildChatModelGroups(models: ReadonlyArray<AvailableChatModel>) {
  const groups: Array<{ provider: string; label: string; models: AvailableChatModel[] }> = [];
  for (const model of models) {
    const existing = groups.find((group) => group.provider === model.provider);
    if (existing) {
      existing.models.push(model);
      continue;
    }
    groups.push({
      provider: model.provider,
      label: "providerLabel" in model && typeof model.providerLabel === "string" ? model.providerLabel : providerLabel(model.provider),
      models: [model],
    });
  }
  return groups;
}

export function providerLabel(provider: string) {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "claude-code") return "ClaudeCode Bridge";
  if (provider === "codex-bridge") return "CodexBridge";
  if (provider === "deepseek") return "DeepSeek";
  // The Providers dialog's names for the two US hosts (Android's providerDisplayName agrees).
  if (provider === "fireworks") return "Fireworks AI";
  if (provider === "gmicloud") return "GMICloud";
  if (provider === "google") return "Google";
  if (provider === "moonshot") return "Moonshot (Kimi)";
  if (provider === "openai") return "OpenAI";
  if (provider === "xai") return "xAI";
  if (provider === "xiaomi") return "Xiaomi (MiMo)";
  if (provider === "zai") return "z.ai";
  return provider;
}
