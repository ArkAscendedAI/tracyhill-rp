export type ProviderId = "anthropic" | "claude-code" | "deepseek" | "google" | "openai" | "xai" | "xiaomi" | "zai";
// "none" = OpenAI 5.1+ non-reasoning value (older gpt-5 uses "minimal" for the same idea).
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ChatModel = {
  id: string;
  label: string;
  provider: ProviderId;
  ctx?: number;
  maxOutputTokens: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
  cacheReadCostPerMillionTokens?: number;
  cacheWrite5mCostPerMillionTokens?: number;
  cacheWrite1hCostPerMillionTokens?: number;
  supportsCacheTtl?: boolean;
  supportsThinkingBudget?: boolean;
  supportsAdaptiveThinking?: boolean;
  // Simple on/off thinking toggle (no adaptive, no token budget) — e.g. Xiaomi
  // MiMo's thinking:{type:"enabled"|"disabled"}. The UI shows an On/Off control
  // and the runtime maps the session's enabled/off to the provider's toggle.
  supportsToggleThinking?: boolean;
  // Thinking cannot be turned off (Fable 5 family): adaptive applies even when the
  // request omits the thinking param, and {type:"disabled"} is a 400. The runtime
  // always sends {type:"adaptive", display:"summarized"} so thinking stays visible,
  // and the UI locks the thinking control instead of offering Off.
  thinkingAlwaysOn?: boolean;
  supportsEffort?: boolean;
  effortOptions?: EffortLevel[];
  defaultEffort?: EffortLevel;
  maxThinkingBudget?: number;
  // Fast mode (Anthropic research preview, anthropic-beta: fast-mode-2026-02-01).
  // Presence of these fields implies the model supports speed:"fast". Cache rates
  // under fast mode are derived: read = fastInput × 0.1, write5m = × 1.25, write1h = × 2.
  // Bridge variants intentionally OMIT these — SDK doesn't accept the speed param.
  fastModeInputCostPerMillionTokens?: number;
  fastModeOutputCostPerMillionTokens?: number;
  // Long-context tiered pricing (Gemini 3.1 Pro / 2.5 Pro, grok-4.3): when the
  // prompt-side tokens (input + cache read/write) of a single request exceed
  // the threshold, the request bills at these rates instead of the base rates.
  longContextThresholdTokens?: number;
  longContextInputCostPerMillionTokens?: number;
  longContextOutputCostPerMillionTokens?: number;
  longContextCacheReadCostPerMillionTokens?: number;
};

export type ImageModel = {
  id: string;
  label: string;
  provider: ProviderId;
};

export const CHAT_MODELS: ChatModel[] = [
  {
    // Mythos-class tier above Opus (GA 2026-06-09). Same tokenizer + request
    // surface as Opus 4.8 except thinking is always-on (thinkingAlwaysOn) and
    // fast mode is not offered. Safety classifiers can refuse with
    // stop_details.category cyber/bio/reasoning_extraction. Cache minimum 512 tok.
    id: "claude-fable-5",
    label: "Claude Fable 5",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 10,
    outputCostPerMillionTokens: 50,
    cacheReadCostPerMillionTokens: 1,
    cacheWrite5mCostPerMillionTokens: 12.5,
    cacheWrite1hCostPerMillionTokens: 20,
    supportsCacheTtl: true,
    supportsAdaptiveThinking: true,
    thinkingAlwaysOn: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 5,
    outputCostPerMillionTokens: 25,
    cacheReadCostPerMillionTokens: 0.5,
    cacheWrite5mCostPerMillionTokens: 6.25,
    cacheWrite1hCostPerMillionTokens: 10,
    supportsCacheTtl: true,
    supportsThinkingBudget: true,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "max"],
    defaultEffort: "max",
    maxThinkingBudget: 127999,
    // Fast mode for 4.6 is deprecated as of 4.8 launch; removal ~30 days after.
    fastModeInputCostPerMillionTokens: 30,
    fastModeOutputCostPerMillionTokens: 150,
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 5,
    outputCostPerMillionTokens: 25,
    cacheReadCostPerMillionTokens: 0.5,
    cacheWrite5mCostPerMillionTokens: 6.25,
    cacheWrite1hCostPerMillionTokens: 10,
    supportsCacheTtl: true,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastModeInputCostPerMillionTokens: 30,
    fastModeOutputCostPerMillionTokens: 150,
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 5,
    outputCostPerMillionTokens: 25,
    cacheReadCostPerMillionTokens: 0.5,
    cacheWrite5mCostPerMillionTokens: 6.25,
    cacheWrite1hCostPerMillionTokens: 10,
    supportsCacheTtl: true,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    // Fast mode for 4.8: $10 input / $50 output (3× cheaper than 4.6/4.7 fast).
    fastModeInputCostPerMillionTokens: 10,
    fastModeOutputCostPerMillionTokens: 50,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 64000,
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
    cacheReadCostPerMillionTokens: 0.3,
    cacheWrite5mCostPerMillionTokens: 3.75,
    cacheWrite1hCostPerMillionTokens: 6,
    supportsCacheTtl: true,
    supportsThinkingBudget: true,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    maxThinkingBudget: 63999,
  },
  // claude-sonnet-4-20250514 removed 2026-06-12 — Anthropic retires it 2026-06-15
  // (and its real context was 200K, not 1M). Migration 0060 remaps stored ids
  // to claude-sonnet-4-6.
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    ctx: 200000,
    maxOutputTokens: 64000,
    inputCostPerMillionTokens: 1,
    outputCostPerMillionTokens: 5,
    cacheReadCostPerMillionTokens: 0.1,
    cacheWrite5mCostPerMillionTokens: 1.25,
    cacheWrite1hCostPerMillionTokens: 2,
    supportsCacheTtl: true,
    supportsThinkingBudget: true,
    maxThinkingBudget: 63999,
  },
  // ── ClaudeCode Bridge variants ────────────────────────────────────
  // Routes through ~/projects/claude-rp-bridge → claude-agent-service →
  // Claude Agent SDK on Max OAuth subscription. Same Anthropic models,
  // zero marginal cost (Max plan), but bound by subscription rate limits.
  // Cache TTL is forced to 1h by the SDK; supportsCacheTtl is therefore
  // false (UI shouldn't expose the 5m option).
  {
    // NOTE: Fable on Pro/Max subscriptions is free only through 2026-06-22 —
    // from June 23 this bridge variant bills usage credits at API rates unless
    // Anthropic extends the window. Re-check ~June 20 and update the zero
    // pricing below if the window closes.
    id: "claude-fable-5-bridge",
    label: "Claude Fable 5 (Bridge)",
    provider: "claude-code",
    // Empirical (2026-06-09): the Max/CLI path serves Fable 5 with a ~200K
    // context — a ~210K-token prompt errors "Prompt is too long" while ~140K
    // works. The direct API entry keeps 1M. Revisit if the sub tier changes.
    ctx: 200000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheWrite1hCostPerMillionTokens: 0,
    supportsAdaptiveThinking: true,
    thinkingAlwaysOn: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    id: "claude-opus-4-7-bridge",
    label: "Claude Opus 4.7 (Bridge)",
    provider: "claude-code",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheWrite1hCostPerMillionTokens: 0,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    id: "claude-opus-4-8-bridge",
    label: "Claude Opus 4.8 (Bridge)",
    provider: "claude-code",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheWrite1hCostPerMillionTokens: 0,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    id: "claude-opus-4-6-bridge",
    label: "Claude Opus 4.6 (Bridge)",
    provider: "claude-code",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheWrite1hCostPerMillionTokens: 0,
    supportsThinkingBudget: true,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "max"],
    defaultEffort: "max",
    maxThinkingBudget: 127999,
  },
  {
    id: "claude-sonnet-4-6-bridge",
    label: "Claude Sonnet 4.6 (Bridge)",
    provider: "claude-code",
    ctx: 1000000,
    maxOutputTokens: 64000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheWrite1hCostPerMillionTokens: 0,
    supportsThinkingBudget: true,
    supportsAdaptiveThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    maxThinkingBudget: 63999,
  },
  {
    id: "claude-haiku-4-5-bridge",
    label: "Claude Haiku 4.5 (Bridge)",
    provider: "claude-code",
    ctx: 200000,
    maxOutputTokens: 64000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheWrite1hCostPerMillionTokens: 0,
    supportsThinkingBudget: true,
    maxThinkingBudget: 63999,
  },
  {
    // id corrected 2026-06-12 from "gpt-5-5" (dotted id per official docs;
    // live-confirm on first use once the OpenAI key is replaced).
    id: "gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 5,
    outputCostPerMillionTokens: 30,
    cacheReadCostPerMillionTokens: 0.5,
    supportsEffort: true,
    effortOptions: ["none", "low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
  },
  {
    id: "gpt-5.5-pro",
    label: "GPT-5.5 Pro",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 30,
    outputCostPerMillionTokens: 180,
    supportsEffort: true,
    // Pro models accept medium/high/xhigh only (no low/none) and have no
    // cached-input discount.
    effortOptions: ["medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  {
    // Alias for the latest ChatGPT Instant tuning (GPT-5.5 Instant) — the most
    // conversational register OpenAI offers; plain chat-completions (no
    // reasoning controls by design).
    id: "chat-latest",
    label: "GPT Chat (Instant)",
    provider: "openai",
    ctx: 400000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 5,
    outputCostPerMillionTokens: 30,
    cacheReadCostPerMillionTokens: 0.5,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 2.5,
    outputCostPerMillionTokens: 15,
    cacheReadCostPerMillionTokens: 0.25,
    supportsEffort: true,
    effortOptions: ["none", "low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
  },
  {
    id: "gpt-5.4-pro",
    label: "GPT-5.4 Pro",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 30,
    outputCostPerMillionTokens: 180,
    supportsEffort: true,
    effortOptions: ["medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    provider: "openai",
    ctx: 400000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.75,
    outputCostPerMillionTokens: 4.5,
    cacheReadCostPerMillionTokens: 0.075,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 Nano",
    provider: "openai",
    ctx: 400000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.2,
    outputCostPerMillionTokens: 1.25,
    cacheReadCostPerMillionTokens: 0.02,
    // Only GPT-5-family model that was missing effort support — an omission,
    // not a capability difference (gpt-5-nano has it).
    supportsEffort: true,
    effortOptions: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "gpt-5.1",
    label: "GPT-5.1",
    provider: "openai",
    ctx: 400000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.125,
    supportsEffort: true,
    effortOptions: ["none", "low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "gpt-5.1-codex-mini",
    label: "GPT-5.1 Codex-Mini",
    provider: "openai",
    ctx: 400000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.25,
    outputCostPerMillionTokens: 2,
    cacheReadCostPerMillionTokens: 0.025,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    provider: "openai",
    ctx: 400000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.125,
    supportsEffort: true,
    effortOptions: ["minimal", "low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    provider: "openai",
    ctx: 400000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.25,
    outputCostPerMillionTokens: 2,
    cacheReadCostPerMillionTokens: 0.025,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 Nano",
    provider: "openai",
    ctx: 400000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.05,
    outputCostPerMillionTokens: 0.4,
    cacheReadCostPerMillionTokens: 0.005,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  // o4-mini removed 2026-06-12 (OpenAI shutdown 2026-10-23; migration 0060 -> gpt-5.4-mini)
  // o3 removed 2026-06-12 (OpenAI shutdown 2026-07-23; migration 0060 -> gpt-5.4)
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    provider: "openai",
    ctx: 1047576,
    maxOutputTokens: 32768,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 8,
    cacheReadCostPerMillionTokens: 0.5,
  },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    provider: "openai",
    ctx: 1047576,
    maxOutputTokens: 32768,
    inputCostPerMillionTokens: 0.4,
    outputCostPerMillionTokens: 1.6,
    // verify-live: -mini cached rate not individually doc-confirmed
    cacheReadCostPerMillionTokens: 0.1,
  },
  // gpt-4.1-nano removed 2026-06-12 (OpenAI shutdown 2026-10-23; migration 0060 -> gpt-5.4-nano)
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    ctx: 1000000,
    maxOutputTokens: 384000,
    // Permanent price cut 2026-05-22 (was the 1.74/3.48 launch rate).
    inputCostPerMillionTokens: 0.435,
    outputCostPerMillionTokens: 0.87,
    cacheReadCostPerMillionTokens: 0.0036,
    // V4 thinking: {type:"enabled"|"disabled"}, server default enabled.
    supportsToggleThinking: true,
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "deepseek",
    ctx: 1000000,
    maxOutputTokens: 384000,
    inputCostPerMillionTokens: 0.14,
    outputCostPerMillionTokens: 0.28,
    cacheReadCostPerMillionTokens: 0.0028,
    supportsToggleThinking: true,
  },
  // deepseek-chat + deepseek-reasoner removed 2026-06-12 — both became aliases of
  // deepseek-v4-flash (non-thinking/thinking) and retire 2026-07-24; migration
  // 0060 -> deepseek-v4-flash.
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 12,
    longContextThresholdTokens: 200000,
    longContextInputCostPerMillionTokens: 4,
    longContextOutputCostPerMillionTokens: 18,
    longContextCacheReadCostPerMillionTokens: 0.4,
    supportsEffort: true,
    // "minimal" is NOT legal on 3.1 Pro (live 400 2026-06-12); it IS legal on
    // 3.5 Flash / 3.1 Flash-Lite.
    effortOptions: ["low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 1.5,
    outputCostPerMillionTokens: 9,
    supportsEffort: true,
    effortOptions: ["minimal", "low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 0.25,
    outputCostPerMillionTokens: 1.5,
    supportsEffort: true,
    effortOptions: ["minimal", "low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    // Deprecated upstream — Google shuts 2.5 Pro/Flash/Flash-Lite down 2026-10-16.
    // 2.5 Pro thinking cannot be disabled (min budget 128): modeled as always-on
    // dynamic thinking; the runtime sends thinkingConfig:{includeThoughts:true}.
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 10,
    longContextThresholdTokens: 200000,
    longContextInputCostPerMillionTokens: 2.5,
    longContextOutputCostPerMillionTokens: 15,
    longContextCacheReadCostPerMillionTokens: 0.25,
    thinkingAlwaysOn: true,
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 0.3,
    outputCostPerMillionTokens: 2.5,
    supportsThinkingBudget: true,
    maxThinkingBudget: 24576,
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 0.1,
    outputCostPerMillionTokens: 0.4,
    supportsThinkingBudget: true,
    maxThinkingBudget: 24576,
  },
  {
    id: "grok-4.3",
    label: "Grok 4.3",
    provider: "xai",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 2.5,
    cacheReadCostPerMillionTokens: 0.2,
    // xAI reprices the WHOLE request above 200K total prompt tokens (cached
    // tokens count toward the threshold). Doubled rates per third-party
    // sources — verify-live once a >200K turn lands.
    longContextThresholdTokens: 200000,
    longContextInputCostPerMillionTokens: 2.5,
    longContextOutputCostPerMillionTokens: 5,
    longContextCacheReadCostPerMillionTokens: 0.4,
    supportsEffort: true,
    effortOptions: ["minimal", "low", "medium", "high"],
    defaultEffort: "low",
  },
  // grok-4, grok-4-fast-*, grok-4-1-fast-*, grok-3, grok-3-mini removed
  // 2026-06-12 — xAI retired all of them 2026-05-15; the slugs silently served
  // grok-4.3 at grok-4.3 billing. Migration 0060 -> grok-4.3.
  {
    // GA'd id (the -beta- slug remains a server-side alias); ctx corrected 2M -> 1M.
    id: "grok-4.20-0309-reasoning",
    label: "Grok 4.20 (R)",
    provider: "xai",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 2.5,
    cacheReadCostPerMillionTokens: 0.2,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    label: "Grok 4.20",
    provider: "xai",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 2.5,
    cacheReadCostPerMillionTokens: 0.2,
  },
  {
    id: "glm-5.1",
    label: "GLM-5.1",
    provider: "zai",
    ctx: 200000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 1.4,
    outputCostPerMillionTokens: 4.4,
    cacheReadCostPerMillionTokens: 0.26,
    // thinking:{type:"enabled"|"disabled"} both legal first-party (live-verified
    // 2026-06-12); 5.x/4.7 think compulsorily when enabled, 4.6/4.5 dynamically.
    supportsToggleThinking: true,
  },
  {
    id: "glm-5",
    label: "GLM-5",
    provider: "zai",
    ctx: 200000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 1,
    outputCostPerMillionTokens: 3.2,
    cacheReadCostPerMillionTokens: 0.2,
    // thinking:{type:"enabled"|"disabled"} both legal first-party (live-verified
    // 2026-06-12); 5.x/4.7 think compulsorily when enabled, 4.6/4.5 dynamically.
    supportsToggleThinking: true,
  },
  {
    id: "glm-5-turbo",
    label: "GLM-5 Turbo",
    provider: "zai",
    ctx: 200000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 1.2,
    outputCostPerMillionTokens: 4,
    cacheReadCostPerMillionTokens: 0.24,
    // thinking:{type:"enabled"|"disabled"} both legal first-party (live-verified
    // 2026-06-12); 5.x/4.7 think compulsorily when enabled, 4.6/4.5 dynamically.
    supportsToggleThinking: true,
  },
  {
    id: "glm-4.7",
    label: "GLM-4.7",
    provider: "zai",
    ctx: 200000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.6,
    outputCostPerMillionTokens: 2.2,
    cacheReadCostPerMillionTokens: 0.11,
    // thinking:{type:"enabled"|"disabled"} both legal first-party (live-verified
    // 2026-06-12); 5.x/4.7 think compulsorily when enabled, 4.6/4.5 dynamically.
    supportsToggleThinking: true,
  },
  {
    id: "glm-4.7-flashx",
    label: "GLM-4.7 FlashX",
    provider: "zai",
    ctx: 200000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.07,
    outputCostPerMillionTokens: 0.4,
    cacheReadCostPerMillionTokens: 0.01,
    // thinking:{type:"enabled"|"disabled"} both legal first-party (live-verified
    // 2026-06-12); 5.x/4.7 think compulsorily when enabled, 4.6/4.5 dynamically.
    supportsToggleThinking: true,
  },
  {
    id: "glm-4.6",
    label: "GLM-4.6",
    provider: "zai",
    ctx: 200000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.6,
    outputCostPerMillionTokens: 2.2,
    cacheReadCostPerMillionTokens: 0.11,
    // thinking:{type:"enabled"|"disabled"} both legal first-party (live-verified
    // 2026-06-12); 5.x/4.7 think compulsorily when enabled, 4.6/4.5 dynamically.
    supportsToggleThinking: true,
  },
  {
    id: "glm-4.5",
    label: "GLM-4.5",
    provider: "zai",
    ctx: 131000,
    maxOutputTokens: 96000,
    inputCostPerMillionTokens: 0.6,
    outputCostPerMillionTokens: 2.2,
    cacheReadCostPerMillionTokens: 0.11,
    // thinking:{type:"enabled"|"disabled"} both legal first-party (live-verified
    // 2026-06-12); 5.x/4.7 think compulsorily when enabled, 4.6/4.5 dynamically.
    supportsToggleThinking: true,
  },
  // Xiaomi (MiMo models) — OpenAI-compatible chat-completions API at
  // api.xiaomimimo.com/v1. Reasoning models with a `thinking:{type}` toggle
  // (disabled | enabled | adaptive); reasoning streams in delta.reasoning_content.
  // Pricing is the first-party platform rate at <=256K context (doubles above);
  // cache-hit input is $0.20. v2.5-pro: 1.02T MoE / 42B active.
  {
    id: "mimo-v2.5-pro",
    label: "MiMo v2.5 Pro",
    provider: "xiaomi",
    ctx: 1000000,
    // Live-verified 2026-06-12: API caps max_completion_tokens at 131072 (the
    // old 16384 was 8x under). Prices are the post-2026-05-27 flat schedule
    // (256K-doubling removed) — confirm in the MiMo console.
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.435,
    outputCostPerMillionTokens: 0.87,
    cacheReadCostPerMillionTokens: 0.0036,
    supportsToggleThinking: true,
  },
  {
    id: "mimo-v2.5",
    label: "MiMo v2.5",
    provider: "xiaomi",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.14,
    outputCostPerMillionTokens: 0.28,
    cacheReadCostPerMillionTokens: 0.0028,
    supportsToggleThinking: true,
  },
];

export function getChatModel(modelId: string) {
  return CHAT_MODELS.find((model) => model.id === modelId) ?? null;
}

// New-session default, pinned explicitly so catalog display order can't silently
// change it (Fable 5 sits first in the picker but costs 2× Opus per token).
const DEFAULT_CHAT_MODEL_ID = "claude-opus-4-6";

export function getDefaultChatModelId() {
  return getChatModel(DEFAULT_CHAT_MODEL_ID)?.id ?? CHAT_MODELS[0]?.id ?? DEFAULT_CHAT_MODEL_ID;
}

export const IMAGE_MODELS: ImageModel[] = [
  {
    // gpt-image-1 deprecated upstream (shutdown 2026-12-01); successor.
    id: "gpt-image-2",
    label: "GPT Image 2",
    provider: "openai",
  },
  {
    // gemini-2.5-flash-image shuts down 2026-10-02; 3.1 successor live-verified.
    id: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image",
    provider: "google",
  },
  {
    id: "grok-imagine-image",
    label: "Grok Imagine",
    provider: "xai",
  },
  {
    id: "glm-image",
    label: "GLM Image",
    provider: "zai",
  },
];

export function getImageModel(modelId: string) {
  return IMAGE_MODELS.find((model) => model.id === modelId) ?? null;
}

export type EmbeddingModel = {
  id: string;
  label: string;
  provider: ProviderId;
  dimensions: number;
  inputCostPerMillionTokens?: number;
};

export const EMBEDDING_MODELS: EmbeddingModel[] = [
  { id: "openai:text-embedding-3-large", label: "OpenAI Embed 3 Large", provider: "openai", dimensions: 3072, inputCostPerMillionTokens: 0.13 },
  { id: "openai:text-embedding-3-small", label: "OpenAI Embed 3 Small", provider: "openai", dimensions: 1536, inputCostPerMillionTokens: 0.02 },
  { id: "google:gemini-embedding-2", label: "Google Embed 2", provider: "google", dimensions: 3072, inputCostPerMillionTokens: 0.2 },
];

export function getEmbeddingModel(modelId: string) {
  return EMBEDDING_MODELS.find((model) => model.id === modelId) ?? null;
}
