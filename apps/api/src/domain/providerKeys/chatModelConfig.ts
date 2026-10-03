import { buildCustomChatModels, parseCustomChatModelId, type CustomEndpointSummary } from "@tracyhill-rp/contracts";
import { getChatModel } from "@tracyhill-rp/model-catalog";

import { CustomEndpointRepository } from "./customEndpointRepository";

export type ResolvedChatModelConfig = {
  id: string;
  label: string;
  provider: string;
  ctx: number;
  maxOut: number;
  maxThinkingBudget?: number;
  supportsAdaptiveThinking: boolean;
  supportsCacheTtl: boolean;
  supportsThinkingBudget: boolean;
  supportsEffort: boolean;
  // Catalog flag: thinking cannot be disabled (e.g. Fable, gemini-2.5-pro).
  thinkingAlwaysOn: boolean;
  // Derived from catalog: true iff model has fastModeInputCostPerMillionTokens
  // (Anthropic Opus 4.8 / Opus 5 / Opus 5.5 direct + OpenAI gpt-6-astra since
  // 2026-09-05 — never bridge variants; the 4.6/4.7 fast flags were deleted
  // 2026-07-24 when upstream dropped them). chatService maps the toggle to speed:"fast"; each
  // provider runtime owns its wire form (Anthropic speed param / OpenAI
  // service_tier).
  supportsFastMode: boolean;
  defaultEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  customEndpointId?: string;
  actualModelId?: string;
  apiFormat?: CustomEndpointSummary["apiFormat"];
};

export function resolveChatModelConfig(endpoints: CustomEndpointRepository, userId: string, modelId: string): ResolvedChatModelConfig | null {
  const builtIn = getChatModel(modelId);
  if (builtIn) {
    return {
      id: builtIn.id,
      label: builtIn.label,
      provider: builtIn.provider,
      ctx: builtIn.ctx ?? 200000,
      maxOut: builtIn.maxOutputTokens,
      maxThinkingBudget: builtIn.maxThinkingBudget,
      supportsAdaptiveThinking: Boolean(builtIn.supportsAdaptiveThinking),
      supportsCacheTtl: Boolean(builtIn.supportsCacheTtl),
      supportsThinkingBudget: Boolean(builtIn.supportsThinkingBudget || builtIn.supportsAdaptiveThinking),
      supportsEffort: Boolean(builtIn.supportsEffort),
      thinkingAlwaysOn: Boolean(builtIn.thinkingAlwaysOn),
      supportsFastMode: builtIn.fastModeInputCostPerMillionTokens != null,
      defaultEffort: builtIn.defaultEffort,
    };
  }
  const parsed = parseCustomChatModelId(modelId);
  if (!parsed) return null;
  const endpoint = endpoints.findById(userId, parsed.endpointId);
  if (!endpoint) return null;
  const model = buildCustomChatModels([endpoint]).find((entry) => entry.id === modelId);
  if (!model) return null;
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    // Honor the per-model ctx the user configured — hardcoding 200000 budgeted
    // an 8K local model as if it had 200K (overflow) and clamped 1M+ models.
    ctx: model.ctx,
    maxOut: model.maxOut,
    supportsAdaptiveThinking: false,
    supportsCacheTtl: false,
    supportsThinkingBudget: false,
    supportsEffort: false,
    thinkingAlwaysOn: false,
    supportsFastMode: false,
    customEndpointId: model.customEndpointId,
    actualModelId: model.actualModelId,
    apiFormat: model.apiFormat,
  };
}
