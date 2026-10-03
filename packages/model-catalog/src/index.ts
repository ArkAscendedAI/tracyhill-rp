export type ProviderId = "anthropic" | "claude-code" | "codex-bridge" | "deepseek" | "fireworks" | "gmicloud" | "google" | "moonshot" | "openai" | "xai" | "xiaomi" | "zai";
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
  // Thinking is the SERVER default when the request omits the thinking param
  // (Opus 5 family): "off" must go out as an explicit {type:"disabled"} or the
  // dial silently does nothing. Unlike thinkingAlwaysOn, disabling IS legal —
  // but only up to thinkingOffMaxEffort; the runtime clamps effort while
  // thinking is off and the composer hides the higher rungs.
  thinkingDefaultOn?: boolean;
  // Highest effort the API accepts while thinking is disabled (Opus 5: "high" —
  // disabled + xhigh/max is a live 400). Only meaningful with thinkingDefaultOn.
  thinkingOffMaxEffort?: EffortLevel;
  // The thinking type that turns thinking off on a thinkingDefaultOn model.
  // "disabled" when omitted (Opus 5 / Sonnet 5). Claude Sonnet 5.5 rejects
  // {type:"disabled"} with a 400 that names its replacement, {type:"between_tools"}
  // ("the model does not think before responding"), legal only at effort ≤ high
  // (measured 2026-10-01; thinkingOffMaxEffort carries the cap).
  thinkingOffType?: "disabled" | "between_tools";
  // The API's own default effort when a request omits output_config
  // (2026-09-22): "high" everywhere except Claude Opus 5.5 ("medium"). The
  // Anthropic runtime omits the effort field only when the resolved effort
  // EQUALS this value (explicit-default == omitted per the docs, cache-safe),
  // so a session dialed "high" on a medium-default model goes out explicitly
  // instead of silently running one rung lower. Bridge endpoints always send it.
  apiDefaultEffort?: EffortLevel;
  supportsEffort?: boolean;
  effortOptions?: EffortLevel[];
  defaultEffort?: EffortLevel;
  // Whether the runtime forwards a temperature parameter for this model —
  // on at least one legal thinking mode, i.e. "honored while thinking is Off"
  // counts as true. Derived catalog-wide by withTemperatureSupport(): false on
  // OpenAI and CodexBridge reasoning-effort models (the Responses path
  // rejects/ignores it) AND on Anthropic-family adaptive-ONLY models (Opus
  // 4.7+/5, Sonnet 5, Fable — the anthropic runtime drops temperature on every
  // branch for them); dual-mode 4.6-class models honor it while thinking is
  // Off, and so do Gemini 3.x and 2.5 Flash/Lite (thinking on pins
  // temperature 1 — Google's guidance for thinking models; Off = the lowest
  // legal thinkingLevel / budget 0 + the caller's temperature). An
  // entry may declare the flag explicitly to override the derived default.
  // Consumers (composer control gating) read this AND the session's thinking
  // mode instead of re-encoding provider special cases — a dial shown for a
  // model that ignores it is the "silently does nothing" class.
  supportsTemperature?: boolean;
  // A toggle-thinking model whose provider was MEASURED honouring the temperature
  // while the model thinks, so the dial stays with thinking on. Toggle models
  // otherwise show it only while thinking is Off (the provider is assumed to
  // ignore it while reasoning). Set only from a measurement: GLM-5.2
  // (2026-10-01). Requires supportsToggleThinking and the dial (invariant 15).
  temperatureWhileThinking?: boolean;
  maxThinkingBudget?: number;
  // Fast mode pricing (Anthropic research preview, anthropic-beta:
  // fast-mode-2026-02-01; OpenAI service_tier:"fast" on gpt-6-astra). Presence
  // of these fields implies the DIRECT model supports speed:"fast". Cache rates
  // under fast mode are derived: read = fastInput × the model's own base
  // cache-read ratio (0.1 for most; 0.05 on Opus 5.5), write5m = × 1.25,
  // write1h = × 2. Claude bridge variants intentionally OMIT these (2026-09-09:
  // the Agent SDK's fastMode session setting bills usage credits at the direct
  // rate and only covers Opus 4.8/5, so there is no Anthropic bridge fast mode).
  // CodexBridge entries carry fastServiceTier instead of pricing.
  fastModeInputCostPerMillionTokens?: number;
  fastModeOutputCostPerMillionTokens?: number;
  // CodexBridge only: the App Server service-tier id the sidecar requests when
  // the session's `openaiFastModeEnabled` dial is on. Measured on the production
  // sidecar 2026-09-09: `priority` = "Fast — 2x speed, increased usage" on
  // gpt-6-astra and "1.5x speed" on the 5.6 trio + 5.5; Spark advertises none.
  // No pricing fields: subscription cost stays modeled at $0 — the tier's own
  // description is "increased usage" of the weekly limit, not dollars.
  fastServiceTier?: string;
  // Long-context tiered pricing (the OpenAI gpt-6-astra and gpt-5.6 trio past
  // 272K; Gemini 3.1 Pro / 2.5 Pro and grok-4.3 / 4.5 / 4.6 past 200K): when the
  // prompt-side tokens (input + cache read/write) of a single request exceed
  // the threshold, the whole request bills at these rates instead of the base
  // rates, and cache writes scale by the tier's input ratio
  // (`resolveEffectiveRates`).
  longContextThresholdTokens?: number;
  longContextInputCostPerMillionTokens?: number;
  longContextOutputCostPerMillionTokens?: number;
  longContextCacheReadCostPerMillionTokens?: number;
};

export type ImageModel = {
  id: string;
  label: string;
  provider: ProviderId;
  // Request settings the image runtime sends for this model (2026-10-01). Absent, a provider
  // runtime sends its long-standing request: quality "high" on OpenAI, nothing on xAI and
  // Google. quality = OpenAI's or xAI's `quality`; imageSize = Google's
  // `imageConfig.imageSize`; aspectRatio = xAI's `aspect_ratio`.
  quality?: string;
  imageSize?: string;
  aspectRatio?: string;
};

const RAW_CHAT_MODELS: ChatModel[] = [
  {
    // Claude Fable 5.1 — Mythos-class successor to Fable 5 (released 2026-09-01;
    // live-verified 2026-09-02 with a direct API key: capabilities fetch + served
    // "DIRECT-OK" probe). Same $10/$50, 1M ctx, 128K out, thinkingAlwaysOn
    // contract, no-fast-mode, and 512-tok cache minimum as Fable 5 — but cache
    // READS drop 75% to $0.25/MTok (0.025×; every other Claude model is 0.1×).
    // Full effort ladder incl. xhigh+max capability-verified. Cutoff Jun 2026.
    // Retirement not before 2027-09-01; Fable 5 stays served (no deprecation).
    // Breaking vs Fable 5 — none reach this runtime (verified 2026-09-02):
    // forced tool_choice ("any"/"tool") is a live 400 (we never send
    // tool_choice on any Anthropic path); thinking blocks are one-way readable
    // (5.1 reads older models' blocks, older models drop 5.1's) and prefix-edit
    // binding checks apply only to REPLAYED thinking blocks — this runtime
    // replays text-only transcripts, so RP's edit/resend/regenerate history
    // rebuilds stay safe. Sibling claude-mythos-5-1 is Project Glasswing-only
    // (not carried). NOTE: Anthropic shipped NO "Opus 5.1" in this wave —
    // /v1/models/claude-opus-5-1 is a live 404; claude-opus-5 remains current.
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 10,
    outputCostPerMillionTokens: 50,
    cacheReadCostPerMillionTokens: 0.25,
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
    // Fast mode REMOVED upstream: dead on 4.6 since 2026-06-29 (speed:"fast"
    // requests ran standard speed at standard billing) — flags deleted 2026-07-24.
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
    // Fast mode REMOVED upstream 2026-07-24 (was $30/$150) — flags deleted same day.
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
    // Claude Opus 5.5 — released 2026-09-22 (Models API created_at 2026-09-21T16:24Z),
    // onboarded the same day.
    // $4/$20, 1M ctx, 128K out, cutoff Jun 2026, retirement ≥ 2027-09-22, the
    // 4.7+ tokenizer. Cache reads 0.05× ($0.20/MTok — unique in the Opus line),
    // writes 1.25×/2× ($5/$8), 512-token cache minimum. Thinking is ALWAYS ON
    // (the Fable contract, not Opus 5's): {type:"disabled"} and
    // {type:"enabled",budget_tokens} are live 400s at every effort, temperature
    // is a live 400, tool_choice any/tool 400 (never sent by this runtime).
    // Effort ladder low→max; the API DEFAULT IS MEDIUM (every other Claude model
    // defaults to high) — apiDefaultEffort makes the runtime send "high"
    // explicitly; the house default stays max. Fast mode is offered at $8/$40
    // (research preview, direct API only), but the measuring org's fast-mode
    // allocation was 0 tokens/min on BOTH Opus 5 and 5.5 on 2026-09-22
    // (HTTP 429, loud in the composer, dial default-off); still a watch item.
    // Per-message effort, 300K batch output and the computer-use
    // toolset exist upstream and are not wired.
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 4,
    outputCostPerMillionTokens: 20,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWrite5mCostPerMillionTokens: 5,
    cacheWrite1hCostPerMillionTokens: 8,
    supportsCacheTtl: true,
    supportsAdaptiveThinking: true,
    thinkingAlwaysOn: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    apiDefaultEffort: "medium",
    fastModeInputCostPerMillionTokens: 8,
    fastModeOutputCostPerMillionTokens: 40,
  },
  {
    // Launched 2026-07-24. Same price/request surface as Opus 4.8 with two
    // thinking deltas: adaptive is the SERVER default when the param is omitted
    // (thinkingDefaultOn), and {type:"disabled"} is only accepted at effort
    // ≤ high (thinkingOffMaxEffort — disabled + xhigh/max is a live 400).
    // Cache minimum 512 tok (was 1024). Cyber classifiers stricter than 4.8;
    // refusals surface via stop_reason/stop_details like Fable. Knowledge
    // cutoff May 2026. Web-fetch server tool + Priority Tier not offered (n/a here).
    id: "claude-opus-5",
    label: "Claude Opus 5",
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
    thinkingDefaultOn: true,
    thinkingOffMaxEffort: "high",
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    // Fast mode: ~2.5× speed at 2× price (research preview, direct API only).
    fastModeInputCostPerMillionTokens: 10,
    fastModeOutputCostPerMillionTokens: 50,
  },
  {
    // Claude Sonnet 5.5 — released 2026-09-28 (Models API created_at), added
    // 2026-10-01.
    // $2/$10, cache read $0.20, writes $2.50/$4, 1M ctx / 128K out (128,001 is a
    // live 400; a 268K-token needle prompt was recalled), cutoff Jun 2026,
    // retirement ≥ 2027-09-28, 512-token cache minimum. Thinking is ON by default
    // (thinking omitted → a thinking block) but NOT always on: {type:"disabled"}
    // is a live 400 whose message names the replacement, {type:"between_tools"}
    // (no thinking before the answer), which is legal only at effort ≤ high
    // (between_tools + xhigh/max = 400) — thinkingOffType + thinkingOffMaxEffort.
    // {type:"enabled",budget_tokens} 400. temperature is a 400 in every mode
    // ("may only be set to 1" under adaptive, "deprecated" under between_tools),
    // so the runtime never sends it. Effort low→max (none/minimal 400); the API
    // default is high (Claude Code's own default is medium). No fast mode.
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWrite5mCostPerMillionTokens: 2.5,
    cacheWrite1hCostPerMillionTokens: 4,
    supportsCacheTtl: true,
    supportsAdaptiveThinking: true,
    thinkingDefaultOn: true,
    thinkingOffType: "between_tools",
    thinkingOffMaxEffort: "high",
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    // Claude Sonnet 5 — added 2026-08-29 (released upstream
    // 2026-06-30, between our Fable and Opus 5 waves). $2/$10 — cheaper AND
    // newer than Sonnet 4.6. Opus-5-generation contract (live docs + Models-API
    // capability fetch 2026-08-29): adaptive thinking is the SERVER default
    // when the param is omitted (thinkingDefaultOn -> runtime sends explicit
    // {type:"disabled"} for Off), manual budget_tokens 400s (capabilities:
    // enabled=false), non-default temperature/top_p/top_k 400. Full effort
    // ladder incl. xhigh+max capability-verified. No fast mode offered. Cutoff
    // Jan 2026. Unlike Opus 5, {type:"disabled"} is legal at EVERY effort (live
    // 200 at high, xhigh and max on 2026-10-01; Opus 5 still 400s above high),
    // so this entry carries no thinkingOffMaxEffort since that date.
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWrite5mCostPerMillionTokens: 2.5,
    cacheWrite1hCostPerMillionTokens: 4,
    supportsCacheTtl: true,
    supportsAdaptiveThinking: true,
    thinkingDefaultOn: true,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    // maxOutputTokens 64,000 → 128,000 on 2026-10-01: the Models API reports
    // max_tokens 128,000 and max_tokens 128,000 is a live 200 (128,001 = 400).
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    ctx: 1000000,
    maxOutputTokens: 128000,
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
    defaultEffort: "max",
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
  // Routes through the built-in subscription runner (apps/runner → Claude
  // Agent SDK under the user's own Claude subscription sign-in). Same Anthropic models, zero marginal
  // cost on a Max plan, but bound by subscription rate limits.
  // Cache TTL is forced to 1h by the SDK; supportsCacheTtl is therefore
  // false (UI shouldn't expose the 5m option).
  {
    // Fable 5.1 on the Max/CLI path — serving live-verified 2026-09-02 (CLI
    // probe on the Max sub; then through BOTH agent services after their SDK
    // upgrade to 0.3.258 / CLI 2.1.258 — the launch-day CLIs 400'd the id).
    // ctx 200K mirrors the MEASURED Fable 5 Max-path window (~210K-token
    // prompt → "Prompt is too long"); UNMEASURED for 5.1 — a prose-size probe
    // is the only thing that can move it. Zero marginal cost mirrors the standing bridge
    // convention (Fable-bridge billing after the 06-22 window end is unconfirmed).
    id: "claude-fable-5-1-bridge",
    label: "Claude Fable 5.1 (Bridge)",
    provider: "claude-code",
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
    // NOTE: Fable on Pro/Max subscriptions was announced free only through
    // 2026-06-22 — from June 23 this bridge variant may bill usage credits at
    // API rates. Whether that window closed is STILL UNCONFIRMED (unresolved
    // since 2026-09-02); the zero pricing below is the
    // standing bridge convention until a billing view says otherwise.
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
    // Opus 5.5 on the Max/CLI path (2026-09-22). Same always-on thinking contract
    // and medium API default as the direct entry; the bridge endpoint sends the
    // session's effort explicitly on every turn, so the dial is what runs — never
    // the CLI's own per-model default. ctx 1M: the launch-day "unknown model →
    // 200K" reason never applied to this model (CLI 2.1.280 lists Opus 5.5 at
    // 1M) and a 442K-token prose needle prompt was served correctly through the
    // CLI on 2026-09-22; the 1M edge itself is not probed. $0
    // marginal (standing bridge convention); no fast (2026-09-09).
    id: "claude-opus-5-5-bridge",
    label: "Claude Opus 5.5 (Bridge)",
    provider: "claude-code",
    ctx: 1000000,
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
    apiDefaultEffort: "medium",
  },
  {
    // Opus 5 on the Max/CLI path (launched 2026-07-24). Same thinking contract
    // as the direct entry: thinkingDefaultOn + disabled-capped-at-high. The
    // shared anthropic runtime sends the explicit disable through the bridge
    // dialect too. Fast mode is intentionally omitted
    // (2026-09-09): the Agent SDK's fastMode setting bills
    // usage credits at the direct fast rate (see the fastMode field comment).
    // ctx 1M since 2026-09-22 (was 200K from launch, when the bundled CLIs
    // predated Opus 5 and getContextUsage assumed 200K): a 442K-token prose
    // needle prompt was served correctly through CLI 2.1.280 on
    // 2026-09-22; the 1M edge itself is not probed.
    id: "claude-opus-5-bridge",
    label: "Claude Opus 5 (Bridge)",
    provider: "claude-code",
    ctx: 1000000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheWrite1hCostPerMillionTokens: 0,
    supportsAdaptiveThinking: true,
    thinkingDefaultOn: true,
    thinkingOffMaxEffort: "high",
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    // Sonnet 5.5 on the Max/CLI path (2026-10-01). Needs Claude Code ≥ 2.1.284
    // (the runner pins Agent SDK 0.3.287 = CLI 2.1.287; the 2.1.280 CLI answers
    // 400 claude_code_version_too_old). thinkingAlwaysOn here although the direct
    // entry can turn thinking off: the CLI cannot express the model's off type —
    // `--thinking between_tools` is rejected ("Allowed choices are enabled,
    // adaptive, disabled") and `--thinking disabled` still ran 190 thinking tokens
    // at xhigh and 3,010 at max (2026-10-01, CLI 2.1.287 on the Max login), so an
    // Off on this bridge would be a dial that silently does nothing. ctx 1M: the
    // CLI reports contextWindow 1,000,000 / maxOutputTokens 128,000 for the model,
    // and a 452,621-token needle prompt was recalled through the bridge. $0 marginal (standing
    // bridge convention); no fast.
    id: "claude-sonnet-5-5-bridge",
    label: "Claude Sonnet 5.5 (Bridge)",
    provider: "claude-code",
    ctx: 1000000,
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
    // Max-sub serving live-verified 2026-08-29 (CLI probe). ctx stays 200K:
    // a larger window was never measured on the bridge. claude-opus-5-bridge
    // went to 1M on 2026-09-22 only after a 442K-token needle prompt was served
    // through CLI 2.1.280; raise this entry the same way, after its own probe.
    // thinkingOffMaxEffort stays "high" here although the DIRECT API now accepts
    // {type:"disabled"} at every effort (2026-10-01): whether the CLI forwards a
    // disable above high was not measured for Sonnet 5 (for Sonnet 5.5 it does not).
    id: "claude-sonnet-5-bridge",
    label: "Claude Sonnet 5 (Bridge)",
    provider: "claude-code",
    ctx: 200000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheWrite1hCostPerMillionTokens: 0,
    supportsAdaptiveThinking: true,
    thinkingDefaultOn: true,
    thinkingOffMaxEffort: "high",
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
    defaultEffort: "max",
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
  // ── CodexBridge variants ────────────────────────────────
  // These are the exact selectable models advertised by the live Codex App
  // Server on 2026-07-12. They use the ChatGPT/Codex subscription path through
  // the local sidecar, so marginal API cost is zero. "ultra" is deliberately
  // excluded: it enables proactive multi-agent behavior, which is inappropriate
  // for a stateless, tool-disabled Composer generation call.
  {
    // GPT-6 Astra on the Codex subscription (added 2026-09-05, upstream GA
    // 09-03/05). Advertised by the live App Server after the codex CLI upgrade
    // 0.147.0 → 0.153.4 (which also made Astra the App Server DEFAULT model —
    // the panel's new-session default moved off Sol). `ultra` advertised but
    // deliberately excluded (standing rule: proactive multi-agent delegation
    // breaks the stateless composer contract). App Server default effort is
    // medium; catalog default max per the bridge convention (highest non-Ultra).
    // ctx models the 1,050,000 TOTAL window (input ceiling = ctx − maxOut ≈
    // 922K, measured on the direct API 2026-09-05 — windowConversation already
    // budgets exactly that).
    id: "gpt-6-astra-codex-bridge",
    label: "GPT-6 Astra (CodexBridge)",
    provider: "codex-bridge",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastServiceTier: "priority",
  },
  {
    // GPT-6.1 Sol on the Codex subscription (released 2026-09-29; added 2026-10-01).
    // Codex CLI ≥ 0.159.1 lists it (the runner pins 0.159.3), where it is the App
    // Server's DEFAULT model (default effort low). Efforts low→max + ultra on the
    // App Server; ultra excluded (standing composer rule). Plus plans and up.
    // defaultServiceTier null (standard).
    id: "gpt-6.1-sol-codex-bridge",
    label: "GPT-6.1 Sol (CodexBridge)",
    provider: "codex-bridge",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastServiceTier: "priority",
  },
  {
    // GPT-6 Sol on the Codex subscription (released 2026-09-22; Codex CLI ≥ 0.156.1).
    // ITS CATALOG DEFAULT SERVICE TIER IS "priority" (Fast: 1.5× speed, 2.5× the
    // included usage) — the composer clears the tier to standard on every turn
    // whose Engine fast dial is off (composerService #applyServiceTier), so the
    // dial, not the model's default, decides. Efforts low→max (+ ultra, excluded).
    id: "gpt-6-sol-codex-bridge",
    label: "GPT-6 Sol (CodexBridge)",
    provider: "codex-bridge",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastServiceTier: "priority",
  },
  {
    // GPT-6 Luna on the Codex subscription (released 2026-09-22; Codex CLI ≥ 0.156.1).
    // Catalog default service tier "priority" like 6 Sol (the composer clears it when
    // the dial is off). Efforts low→max; no ultra advertised.
    id: "gpt-6-luna-codex-bridge",
    label: "GPT-6 Luna (CodexBridge)",
    provider: "codex-bridge",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastServiceTier: "priority",
  },
  {
    id: "gpt-5.6-sol-codex-bridge",
    label: "GPT-5.6 Sol (CodexBridge)",
    provider: "codex-bridge",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastServiceTier: "priority",
  },
  {
    id: "gpt-5.6-terra-codex-bridge",
    label: "GPT-5.6 Terra (CodexBridge)",
    provider: "codex-bridge",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastServiceTier: "priority",
  },
  {
    id: "gpt-5.6-luna-codex-bridge",
    label: "GPT-5.6 Luna (CodexBridge)",
    provider: "codex-bridge",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastServiceTier: "priority",
  },
  // gpt-5.5-codex-bridge REMOVED 2026-10-01: GPT-5.5 leaves Codex and ChatGPT on
  // 2026-10-14 (the API id gpt-5.5 stays). gpt-5.3-codex-spark-codex-bridge
  // REMOVED the same day: Codex retired Spark on 2026-09-14 and the 0.159.3 App
  // Server no longer lists it. Migration 0090 retargets both (5.5 → GPT-6.1 Sol,
  // Spark → GPT-6 Luna); no stored session used either.
  // gpt-5.4-codex-bridge + gpt-5.4-mini-codex-bridge REMOVED 2026-08-29:
  // ChatGPT-side Codex retires 5.4 + 5.4 Mini on 2026-08-31 (learn.chatgpt.com
  // model notes; API-key surfaces unaffected) — the App Server list drops them
  // and the sidecar's live-list validation would fail every send. Migration
  // 0080 retargets terra/luna.
  // ── GPT-5.6 family (Sol / Terra / Luna) — GA 2026-07-09, added 2026-07-12 ──
  // New tier naming: the number is the generation, Sol/Terra/Luna are durable
  // capability tiers (flagship/mini/nano analogues). Alias-only ids — no dated
  // snapshots exist upstream. Cutoff 2026-02-16. Whole-request long-context
  // tier above 272K input tokens (2x input + cached, 1.5x output). Cache
  // writes billed at 1.25x input (a first for OpenAI; 30-min minimum cache
  // life; usage reports input_tokens_details.cache_write_tokens — captured).
  // Effort ladder gains "max" and drops "minimal"; "none" is true off.
  // "Sol Pro" is NOT a model — it's gpt-5.6-sol + reasoning.mode:"pro" on the
  // Responses API (not wired; add on request). Chat Completions rejects
  // function tools when reasoning is active on this family — we serve all
  // effort models via Responses, so unaffected. Live-verified 2026-07-12: all
  // three ids resolve; effort "none" AND "max" accepted (Sol@max spent zero
  // reasoning tokens on a trivial prompt — max is a ceiling, not a floor).
  {
    // GPT-6 Astra (added 2026-09-05; GA 2026-09-03, public API 09-05) — "the
    // most capable model" tier above the 5.6 family. Live-measured
    // 2026-09-05:
    // effort ladder low|medium|high|xhigh|max EXACTLY — "none"/"minimal" are
    // live 400s (unlike 5.6, thinking cannot be off; the runtime folds
    // thinking-off callers to "low"), "ultra" is ChatGPT/Codex-side only (400
    // on the API). temperature AND top_p are hard 400s ("Unsupported
    // parameter") — derivesTemperatureless covers it. ctx 1,050,000 is the
    // TOTAL window: measured input ceiling ≈ 922K (915,126-token needle = 200
    // with exact recall in 34 s; ~940K = 400 "exceeds the context window") =
    // ctx − maxOut, which is exactly what windowConversation budgets. maxOut
    // 128,000 (values above it are accepted and clamped upstream, no 400).
    // Prompt caching is implicit like 5.6: cache_write_tokens (1.25× billed)
    // on first send, cached_tokens ($1 = 0.1×) on repeat — both captured
    // disjoint. >272K long-context tier: 2× input/cache, 1.5× output, whole
    // request. FAST MODE (new for OpenAI, 2× applicable rates): wire is
    // `service_tier: "fast"` on Responses ("priority" aliases to it; the
    // Anthropic-style `speed` param is an Unknown-parameter 400); the response
    // echoes service_tier "fast" — the runtime maps the session fast toggle to
    // it and stamps usage.speed from the echo. `text.verbosity` is accepted
    // but not wired (no dial anywhere; 5.6 same). Flex/Batch tiers (50%)
    // deliberately not wired. Image input yes; Chat Completions works but the
    // runtime routes all effort models via Responses. Cutoff 2026-04-30.
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 10,
    outputCostPerMillionTokens: 50,
    cacheReadCostPerMillionTokens: 1,
    cacheWrite5mCostPerMillionTokens: 12.5,
    cacheWrite1hCostPerMillionTokens: 12.5,
    longContextThresholdTokens: 272000,
    longContextInputCostPerMillionTokens: 20,
    longContextOutputCostPerMillionTokens: 75,
    longContextCacheReadCostPerMillionTokens: 2,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastModeInputCostPerMillionTokens: 20,
    fastModeOutputCostPerMillionTokens: 100,
  },
  // ── GPT-6 Sol / Luna (2026-09-22) and GPT-6.1 Sol (2026-09-29) — added 2026-10-01 ──
  // Live-verified on 2026-10-01:
  // 1,050,000 total window with a 922K input ceiling (an over-limit prompt is a 400
  // "exceeds the context window"; needles recalled at 290K on both Sols and 824K on
  // Luna), max_output_tokens 128,000 accepted (larger values clamp, no 400),
  // service_tier "fast" echoed "fast" ("priority" aliases to it; "flex" also served).
  // Pricing per MTok ≤272K input; above 272K the whole request bills 2× input and
  // cache, 1.5× output; cache writes 1.25× input; Fast 2× the applicable rates.
  {
    // GPT-6.1 Sol — no "none" rung (and no "minimal"/"ultra"): efforts low→max, so
    // thinking-off callers fold to "low" like Astra; temperature and top_p are
    // 400s at every effort. Cached input is 5% of input ($0.10). Cutoff 2026-04-30.
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.1,
    cacheWrite5mCostPerMillionTokens: 2.5,
    cacheWrite1hCostPerMillionTokens: 2.5,
    longContextThresholdTokens: 272000,
    longContextInputCostPerMillionTokens: 4,
    longContextOutputCostPerMillionTokens: 15,
    longContextCacheReadCostPerMillionTokens: 0.2,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastModeInputCostPerMillionTokens: 4,
    fastModeOutputCostPerMillionTokens: 20,
  },
  {
    // GPT-6 Sol — efforts none→max ("minimal"/"ultra" 400); temperature and top_p
    // are accepted only at effort "none" (400 "Unsupported parameter" above it), so
    // the catalog hides the dial as for every OpenAI reasoning model. Cached input
    // 10% ($0.20). Cutoff 2026-04-20.
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWrite5mCostPerMillionTokens: 2.5,
    cacheWrite1hCostPerMillionTokens: 2.5,
    longContextThresholdTokens: 272000,
    longContextInputCostPerMillionTokens: 4,
    longContextOutputCostPerMillionTokens: 15,
    longContextCacheReadCostPerMillionTokens: 0.4,
    supportsEffort: true,
    effortOptions: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastModeInputCostPerMillionTokens: 4,
    fastModeOutputCostPerMillionTokens: 20,
  },
  {
    // GPT-6 Luna — the small tier: same contract as GPT-6 Sol (efforts none→max,
    // temperature only at "none"). Cutoff 2026-05-18.
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    inputCostPerMillionTokens: 0.1,
    outputCostPerMillionTokens: 0.5,
    cacheReadCostPerMillionTokens: 0.01,
    cacheWrite5mCostPerMillionTokens: 0.125,
    cacheWrite1hCostPerMillionTokens: 0.125,
    longContextThresholdTokens: 272000,
    longContextInputCostPerMillionTokens: 0.2,
    longContextOutputCostPerMillionTokens: 0.75,
    longContextCacheReadCostPerMillionTokens: 0.02,
    supportsEffort: true,
    effortOptions: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    fastModeInputCostPerMillionTokens: 0.2,
    fastModeOutputCostPerMillionTokens: 1,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    // 2026-08-21 cut (−20% in/−33% out; promotional floor holds >= 2026-11-21
    // per the model page — re-check after).
    inputCostPerMillionTokens: 4,
    outputCostPerMillionTokens: 20,
    cacheReadCostPerMillionTokens: 0.4,
    cacheWrite5mCostPerMillionTokens: 5,
    cacheWrite1hCostPerMillionTokens: 5,
    longContextThresholdTokens: 272000,
    longContextInputCostPerMillionTokens: 8,
    longContextOutputCostPerMillionTokens: 30,
    longContextCacheReadCostPerMillionTokens: 0.8,
    supportsEffort: true,
    effortOptions: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    // 2026-07-30 cut (−20%).
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 12,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWrite5mCostPerMillionTokens: 2.5,
    cacheWrite1hCostPerMillionTokens: 2.5,
    longContextThresholdTokens: 272000,
    longContextInputCostPerMillionTokens: 4,
    longContextOutputCostPerMillionTokens: 18,
    longContextCacheReadCostPerMillionTokens: 0.4,
    supportsEffort: true,
    effortOptions: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    ctx: 1050000,
    maxOutputTokens: 128000,
    // 2026-07-30 cut (−80%).
    inputCostPerMillionTokens: 0.2,
    outputCostPerMillionTokens: 1.2,
    cacheReadCostPerMillionTokens: 0.02,
    cacheWrite5mCostPerMillionTokens: 0.25,
    cacheWrite1hCostPerMillionTokens: 0.25,
    longContextThresholdTokens: 272000,
    longContextInputCostPerMillionTokens: 0.4,
    longContextOutputCostPerMillionTokens: 1.8,
    longContextCacheReadCostPerMillionTokens: 0.04,
    supportsEffort: true,
    effortOptions: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
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
    defaultEffort: "xhigh",
  },
  {
    // Alias for the latest ChatGPT Instant tuning — the most conversational
    // register OpenAI offers; plain chat-completions (no reasoning controls by
    // design). Repointed upstream 2026-08-06: now tracks the GPT-5.6-based
    // Instant model (was GPT-5.5 Instant). Price unchanged.
    // Wire: routes to Chat Completions (no effort
    // ladder) as the bare id with `max_completion_tokens` (the runtime's
    // first-party OpenAI cap name; `max_tokens` is rejected by reasoning-
    // family chat models). Whether OpenAI serves the bare alias `chat-latest`
    // (published aliases are `gpt-<n>-chat-latest`-shaped) has NO live
    // verification on record — live-confirm on first use and record the
    // served id here.
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
    defaultEffort: "xhigh",
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
  // gpt-5.1-codex-mini removed 2026-07-12 (OpenAI shutdown 2026-07-23; migration 0073 -> gpt-5.4-mini)
  // gpt-5 / gpt-5-mini / gpt-5-nano removed 2026-07-12 (dated snapshots backing
  // the aliases deprecated 2026-06-11, API removal 2026-12-11; migration 0073
  // -> gpt-5.5 / gpt-5.4-mini / gpt-5.4-nano per OpenAI's official remaps)
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
    // PEAK/OFF-PEAK since 2026-08-16 (official changelog): stored rates = PEAK
    // (01:00-04:00 + 06:00-10:00 UTC Mon-Fri — which covers US-evening play);
    // off-peak = exactly HALF, weekends fully off-peak. Costs display the
    // worst case, disclosed. Cache-hit peak: pro $0.044 / flash $0.014.
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    ctx: 1000000,
    maxOutputTokens: 384000,
    // Permanent price cut 2026-05-22 (was the 1.74/3.48 launch rate).
    inputCostPerMillionTokens: 1.32,
    outputCostPerMillionTokens: 3.96,
    cacheReadCostPerMillionTokens: 0.044,
    // V4 thinking: {type:"enabled"|"disabled"}, server default enabled.
    supportsToggleThinking: true,
    // DeepSeek's documented effort ladder, wired 2026-10-01. The
    // runtime sends reasoning_effort only while thinking runs; the toggle governs on
    // and off (thinking disabled plus effort low ran no reasoning, measured). The server
    // default is high. Measured over six calls per rung on a counting question, the
    // median reasoning tokens were 903 at low (3 of 6 answers right), 3,470 at high and
    // 4,816 at max (6 of 6 each).
    supportsEffort: true,
    effortOptions: ["low", "high", "max"],
    defaultEffort: "max",
  },
  {
    // DeepSeek V4.1 Flash (released 2026-09-10) under the id DeepSeek's /models now
    // lists, "deepseek-flash" — added 2026-10-01, replacing deepseek-v4-flash
    // (that model is retired; its name "temporarily" routes to V4.1 Flash with no
    // end date; migration 0090 retargets stored references). Peak $0.30/$1.20,
    // cache hit $0.006 (off-peak half; see the v4-pro note), cheaper than V4 Flash.
    // 1M ctx / 384K out, thinking on by default with the same {type} toggle.
    // The effort ladder is the V4 Pro one (see there). Measured over six calls per rung,
    // the median reasoning tokens were 2,086 at low, 2,667 at high and 3,642 at max,
    // and every answer was right. Flash streamed no tokens for over three minutes per
    // call through the afternoon of 2026-10-01 while V4 Pro answered; by 22:20 UTC it
    // answered within 1.5 s again.
    id: "deepseek-flash",
    label: "DeepSeek Flash (V4.1)",
    provider: "deepseek",
    ctx: 1000000,
    maxOutputTokens: 384000,
    inputCostPerMillionTokens: 0.3,
    outputCostPerMillionTokens: 1.2,
    cacheReadCostPerMillionTokens: 0.006,
    supportsToggleThinking: true,
    supportsEffort: true,
    effortOptions: ["low", "high", "max"],
    defaultEffort: "max",
  },
  // deepseek-chat + deepseek-reasoner removed 2026-06-12 — both became aliases of
  // deepseek-v4-flash (non-thinking/thinking) and retire 2026-07-24; migration
  // 0060 -> deepseek-v4-flash.
  // ── Google Gemini ──────────────────────────────────────────────────────────
  // Cache reads: Gemini's implicit caching bills cached prompt tokens at 0.1×
  // the input rate (the runtime captures cachedContentTokenCount into
  // usage.cacheReadTokens, disjoint from inputTokens). Every entry carries the
  // BASE cache-read rate — until 2026-09-02 only the >200K tier rows had one,
  // so cached tokens billed $0 below the threshold and $0.40 above it, and
  // sessions never showed cache savings. Rates = 0.1× input per the
  // pricing page; verify live when a rate changes.
  // Temperature on Gemini 3.x (measured 2026-10-01, 20 calls per setting
  // at the lowest thinking level — the only state the runtime ever sent a caller's
  // temperature in — asking for a random whole number from 1 to 100; Google deprecated
  // temperature/top_p/top_k for 3.x on 2026-07-21): 3.8 Flash 3 distinct answers at
  // 0.01 vs 3 at 1.0, 3.7 Flash 3 vs 4, 3.5 Flash 2 vs 4, 3.5 Flash-Lite 2 vs 2,
  // 3.1 Flash-Lite 1 vs 1 — no effect, so those five carry supportsTemperature:false
  // (the dial is hidden and the runtime sends no temperature). 3.1 Pro answered 2 vs
  // 5 and keeps its dial; the control, 2.5 Flash at budget 0, answered 2 vs 11.
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 12,
    cacheReadCostPerMillionTokens: 0.2,
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
    cacheReadCostPerMillionTokens: 0.15,
    supportsEffort: true,
    effortOptions: ["minimal", "low", "medium", "high"],
    defaultEffort: "high",
    supportsTemperature: false,
  },
  {
    // Added 2026-09-04: Gemini 3.8 Flash — GA 2026-09-02, the
    // new flagship Flash ("our most intelligent Flash model"), built on 3.7
    // Flash per Google's model card; Google now lists 3.7 as previous-gen.
    // Live-verified 2026-09-04 (models.get, generateContent,
    // SSE streaming, image + PDF inlineData, multi-turn, large-context needle): 1,048,576
    // in / 65,536 out (maxOutputTokens above the cap is accepted and clamped
    // upstream, no 400); INTRO PRICING identical to 3.7 ($0.75/$3.75, cache
    // $0.075) through 2026-12-31 — DOUBLES to $1.50/$7.50/$0.15 on 2027-01-01,
    // update then. No long-context tier. thinkingLevel low|medium|high only:
    // "minimal" is a live 400 ("Thinking level MINIMAL is not supported for
    // this model"); thinkingBudget 0 does NOT disable thinking (3.x contract —
    // thinking-off pins "low"); includeThoughts still streams thought
    // summaries; text-only multi-turn replay needs no thought signatures
    // (live 200, incl. the Content Honesty spliced model turn). Upstream
    // default level is medium; session default high per the max-defaults
    // rule. temperature/topP/topK are wire-accepted (200 at 0.2/1.0/2.0) but have
    // no effect even at the lowest thinking level (measured 2026-10-01, see the
    // Gemini block note) — no dial, none sent; candidateCount > 1 is a 400 (never sent). Cutoff
    // Mar 2026 (some domains Jan 2025). Sibling gemini-3.8-flash-cyber is
    // Fairwind-program-only (not in models.list; not carried).
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 0.75,
    outputCostPerMillionTokens: 3.75,
    cacheReadCostPerMillionTokens: 0.075,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high"],
    defaultEffort: "high",
    supportsTemperature: false,
  },
  {
    // Added 2026-08-29: the flagship Flash until 3.8 shipped
    // (2026-09-02 — Google now lists 3.7 as "previous-generation"); released
    // 2026-08-13 (a post-training point release of 3.6 Flash — 3.6 skipped as
    // redundant). INTRO PRICING through 2026-12-31; DOUBLES to
    // $1.50/$7.50 on 2027-01-01 (official pricing page) — update then.
    // "minimal" thinking_level is NOT supported and returns an error (models
    // page verbatim) — same floor as 3.1 Pro; thinking-off sends "low".
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 0.75,
    outputCostPerMillionTokens: 3.75,
    cacheReadCostPerMillionTokens: 0.075,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high"],
    defaultEffort: "high",
    supportsTemperature: false,
  },
  {
    // Added 2026-08-29: released 2026-07-21; the high-throughput
    // budget tier at exactly old 2.5-flash pricing. thinking default minimal.
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 0.3,
    outputCostPerMillionTokens: 2.5,
    cacheReadCostPerMillionTokens: 0.03,
    supportsEffort: true,
    effortOptions: ["minimal", "low", "medium", "high"],
    defaultEffort: "high",
    supportsTemperature: false,
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 0.25,
    outputCostPerMillionTokens: 1.5,
    cacheReadCostPerMillionTokens: 0.025,
    supportsEffort: true,
    effortOptions: ["minimal", "low", "medium", "high"],
    defaultEffort: "high",
    supportsTemperature: false,
  },
  {
    // 2.5 status (re-audited 2026-08-29): Google REMOVED the announced
    // 2026-10-16 shutdown ("no shutdown date announced"); since ~07-28 the 2.5
    // chat trio 404s for NEW API users, existing users (this key incl.,
    // live-verified) serve "until further notice". Kept deliberately; it
    // can end on short notice — thinkingBudget is no longer documented either.
    // 2.5 Pro thinking cannot be disabled (min budget 128): modeled as always-on
    // dynamic thinking; the runtime sends thinkingConfig:{includeThoughts:true}.
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.125,
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
    cacheReadCostPerMillionTokens: 0.03,
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
    cacheReadCostPerMillionTokens: 0.01,
    supportsThinkingBudget: true,
    maxThinkingBudget: 24576,
  },
  {
    // Grok 4.7 — added 2026-10-01 (API created 2026-09-02, announced 2026-09-21).
    // Live-verified: ctx exactly 500,000 (a 654,587-token prompt
    // is a 400 "654587 tokens > 500000 tokens"; a 179K needle recalled), max_tokens
    // 131072 accepted (larger values clamp; "no text output limit" upstream). Effort
    // low|medium|high|xhigh accepted; "none" is a 400 (reasoning cannot be disabled)
    // and "max"/"ultra" are 400 "Invalid reasoning effort"; undocumented "minimal" is
    // accepted but not surfaced. Temperature IS honoured with reasoning on (8 calls:
    // 1 distinct answer at 0.01, 3 at 1.0), so the dial stays. Penalties and `stop`
    // are documented errors (never sent). $2/$0.50 cached/$6, ≥200K prompt 2×.
    // Slow at depth: a short arithmetic question took 110 s at high, 50 s at xhigh.
    id: "grok-4.7",
    label: "Grok 4.7",
    provider: "xai",
    ctx: 500000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 6,
    cacheReadCostPerMillionTokens: 0.5,
    longContextThresholdTokens: 200000,
    longContextInputCostPerMillionTokens: 4,
    longContextOutputCostPerMillionTokens: 12,
    longContextCacheReadCostPerMillionTokens: 1,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
  },
  {
    // Grok 4.6 — added 2026-08-29 (launched 2026-08-12). First
    // xAI xhigh rung; "Reasoning cannot be disabled" (docs) and no wire
    // "none" — thinking-off clamps to "low" like 4.5. Long-context >=200K =
    // 2x in/cache/out ($4/$1/$12). maxOut undocumented; family-standard
    // 131072 like 4.5. A "fast variant at twice the price" exists upstream
    // but has no documented API id — not carried.
    id: "grok-4.6",
    label: "Grok 4.6",
    provider: "xai",
    ctx: 500000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 6,
    cacheReadCostPerMillionTokens: 0.5,
    longContextThresholdTokens: 200000,
    longContextInputCostPerMillionTokens: 4,
    longContextOutputCostPerMillionTokens: 12,
    longContextCacheReadCostPerMillionTokens: 1,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
  },
  {
    // Launched 2026-07-08 (xAI flagship; upstream aliases grok-4.5-latest /
    // grok-build-latest — we pin the bare id). Cutoff 2026-02-01. Launched
    // with flat pricing; the >=200K 2× tier below was modeled on 2026-08-29
    // (same shape as grok-4.3). Reasoning is always-on: effort
    // low/medium/high, server default high; wire reasoning_effort "none" is a
    // live 400 ("does not support `reasoning_effort` value `none`",
    // 2026-07-12), so there is no "minimal" (wire-none) option here and the
    // runtime clamps the thinking-off fallback to "low". maxOutputTokens is
    // undocumented upstream — the wire accepted max_tokens=400000 without
    // error (live 2026-07-12); family-standard 131072 chosen. Implicit prompt
    // caching observed live; the runtime sends x-grok-conv-id (session key)
    // to improve cache affinity.
    // xhigh added 2026-10-01, and it is the default like 4.6
    // and 4.7. xAI accepts it, but it measured no deeper than high: over three calls
    // each on a harder question, xhigh averaged 1,391 reasoning tokens and high
    // 1,023, and the ranges overlapped.
    id: "grok-4.5",
    label: "Grok 4.5",
    provider: "xai",
    ctx: 500000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 6,
    // Cache cut $0.50 -> $0.30 post-launch (official models page 2026-08-29);
    // >=200K long-context tier added the same day (2x, cache $0.60).
    cacheReadCostPerMillionTokens: 0.3,
    longContextThresholdTokens: 200000,
    longContextInputCostPerMillionTokens: 4,
    longContextOutputCostPerMillionTokens: 12,
    longContextCacheReadCostPerMillionTokens: 0.6,
    supportsEffort: true,
    effortOptions: ["low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
  },
  // grok-4.20-multi-agent-0309 (1M ctx, $1.25/$2.50) deliberately NOT added
  // 2026-07-12 — it 400s on plain chat-completions (likely needs xAI's new
  // Responses/agents surface); revisit if xAI documents it.
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
    // Session default raised low -> high 2026-07-12 (the max-reasoning
    // defaults sweep). xhigh added 2026-10-01, and it is now
    // the default and the workers' top rung. xAI accepts it, but it measured no
    // deeper than high: over three calls each on a harder question, xhigh averaged
    // 2,710 reasoning tokens and high 3,131.
    effortOptions: ["minimal", "low", "medium", "high", "xhigh"],
    defaultEffort: "xhigh",
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
    // GLM-5.3 — added 2026-08-29 (API release 2026-08-18).
    // Reasoning is MANDATORY ("Disabling reasoning is no longer supported";
    // thinking.type only accepts "enabled") -> thinkingAlwaysOn; the zai
    // runtime never sends {type:"disabled"} for alwaysOn models and folds
    // catalog-external effort levels to documented rungs (low|high|max).
    // Same price as 5.2. Text-only input.
    // No temperature dial (measured 2026-10-01 against api.z.ai: six calls
    // per setting asking for a random whole number from 1 to 100). At
    // temperature 0.01 GLM-5.3 gave 5 different answers in 6 and GLM-5.3 Flash
    // 3 (at 1.0: 4 and 5), so z.ai ignores temperature while they reason, which
    // they always do. The control, GLM-5.2, gave 1 in 6 at 0.01 with thinking
    // off, and with thinking on 2 in 6 at 0.01 against 4 at 1.0: it honours the
    // dial. Both clients hide the dial on this flag, and the runtime sends no
    // temperature for these two.
    id: "glm-5.3",
    label: "GLM-5.3",
    provider: "zai",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 1.4,
    outputCostPerMillionTokens: 4.4,
    cacheReadCostPerMillionTokens: 0.26,
    thinkingAlwaysOn: true,
    supportsTemperature: false,
    supportsEffort: true,
    effortOptions: ["low", "high", "max"],
    defaultEffort: "max",
  },
  {
    // GLM-5.3-Flash — added 2026-08-29 (released 2026-08-26): first natively
    // multimodal GLM-5 (video/image/text/file input), 320B-A18B MoE, MIT
    // weights. Thinking always-on, NO effort ladder documented. LIST price
    // stored ($0.15/$0.50 + $0.03 cache = the standard 20% ratio); a 50%-off
    // promo ($0.075/$0.25/$0.015) runs until 2026-09-09 24:00 UTC+8 — costs
    // display slightly high for those 11 days.
    // No temperature dial: z.ai ignores it while Flash reasons (measured
    // 2026-10-01; the numbers are on the GLM-5.3 entry above).
    // Effort ladder low|high|max added 2026-10-01: the API accepts exactly those
    // (none/minimal/medium/xhigh are 400 "please use low, high, or max"; max ran
    // 3,292 reasoning tokens where low/high ran ~80 on the same prime-count
    // question). Default max = the server default, so turns sent before the ladder
    // existed already ran at max.
    id: "glm-5.3-flash",
    label: "GLM-5.3 Flash",
    provider: "zai",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.15,
    outputCostPerMillionTokens: 0.5,
    cacheReadCostPerMillionTokens: 0.03,
    thinkingAlwaysOn: true,
    supportsTemperature: false,
    supportsEffort: true,
    effortOptions: ["low", "high", "max"],
    defaultEffort: "max",
  },
  {
    // GLM-5.3 FlashX — added 2026-10-01: the same model as GLM-5.3 Flash served at
    // ~200 tok/s (z.ai docs; released ~2026-09-18). Live-verified:
    // thinking cannot be disabled (400 "always engages in thinking"), effort low|high|
    // max only, max_tokens capped at exactly 131,072 (131,073 = 400), temperature not
    // honoured while it reasons (8 calls: 5 distinct answers at 0.01, 4 at 1.0 — no
    // dial, as on Flash), an over-limit prompt is a 400 "Prompt exceeds max length",
    // and an 808K-token needle was recalled at effort high (missed at effort low).
    // $0.37/$0.075 cached/$1.25; image/video/file input like Flash.
    id: "glm-5.3-flashx",
    label: "GLM-5.3 FlashX",
    provider: "zai",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.37,
    outputCostPerMillionTokens: 1.25,
    cacheReadCostPerMillionTokens: 0.075,
    thinkingAlwaysOn: true,
    supportsTemperature: false,
    supportsEffort: true,
    effortOptions: ["low", "high", "max"],
    defaultEffort: "max",
  },
  {
    // GLM-5.2 (z.ai) — added 2026-06-18, flagship coding/agentic model. LIVE-verified
    // against the first-party API (api.z.ai): ctx 1M (a 248,577-token prompt was
    // accepted; the docs' `glm-5.2[1m]` suffix is rejected, bare id is the only one),
    // maxOut cap 131072, pricing = GLM-5.1. HYBRID reasoning — BOTH the binary
    // thinking:{type} toggle (supportsToggleThinking, on/off) AND a granular
    // reasoning_effort (supportsEffort, depth) apply. "minimal" effort yields zero
    // reasoning even with thinking enabled, so it's excluded from effortOptions
    // (the toggle owns on/off). Since 2026-10-01 only high and max are offered: the
    // z.ai API reference says "low and medium will be mapped to high; xhigh will be
    // mapped to max", and the 2026-10-01 measurement agrees (reasoning tokens on the
    // same question, two calls each: low 5,391/4,624, medium 5,388/4,757, high
    // 4,342/8,071, max 6,720/7,664). A stale low/medium still reaches the wire as
    // high (zai runtime fold), which is what z.ai ran for it anyway.
    // Temperature while thinking (measured 2026-10-01 against api.z.ai, a
    // random whole number from 1 to 100, thinking on, 20 calls per setting): at
    // 0.01, 4 distinct answers in 20 with the same completion token count 8
    // times; at 1.0, 7 in 20 with a wider spread. z.ai honours the dial while
    // GLM-5.2 reasons, so temperatureWhileThinking keeps it shown then (the
    // runtime sends the caller's temperature in both modes). The 6-call probe
    // before it agreed (2 in 6 at 0.01 against 4 at 1.0; thinking off 1 in 6).
    id: "glm-5.2",
    label: "GLM-5.2",
    provider: "zai",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 1.4,
    outputCostPerMillionTokens: 4.4,
    cacheReadCostPerMillionTokens: 0.26,
    supportsToggleThinking: true,
    temperatureWhileThinking: true,
    supportsEffort: true,
    effortOptions: ["high", "max"],
    defaultEffort: "max",
  },
  {
    id: "glm-5.1",
    label: "GLM-5.1",
    provider: "zai",
    ctx: 200000,
    maxOutputTokens: 131072,
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
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 1,
    outputCostPerMillionTokens: 3.2,
    cacheReadCostPerMillionTokens: 0.2,
    // thinking:{type:"enabled"|"disabled"} both legal first-party (live-verified
    // 2026-06-12); 5.x/4.7 think compulsorily when enabled, 4.6/4.5 dynamically.
    supportsToggleThinking: true,
  },
  {
    // As of 2026-08-29: VANISHED from the official pricing page but still
    // serves (live /models and a live key), so it is kept; watch for a quiet retirement.
    id: "glm-5-turbo",
    label: "GLM-5 Turbo",
    provider: "zai",
    ctx: 200000,
    maxOutputTokens: 131072,
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
    maxOutputTokens: 131072,
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
    maxOutputTokens: 131072,
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
    maxOutputTokens: 131072,
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
    maxOutputTokens: 98304,
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
  // Pricing is the post-2026-05-27 FLAT first-party schedule (the 256K-doubling
  // was removed then); cache-hit input is the per-entry rate below ($0.0036 pro
  // / $0.0028 base). v2.5-pro: 1.02T MoE / 42B active.
  // MiMo V2.5 / V2.5 Pro REMOVED 2026-10-01: Xiaomi shuts both down on 2026-10-21
  // 10:00 Beijing (02:00 UTC) with "no system replacement model" (calls error after
  // that). Migration 0090 retargets them to V2.6 Flash / V2.6 Pro at the same prices.
  // MiMo V2.6 (released 2026-09-22) — added 2026-10-01, live-verified:
  // thinking is ON by default and the {type} toggle works (disabled = 0 reasoning
  // tokens); reasoning_effort none|low|medium|high is ACCEPTED but changes nothing
  // (Pro ran 7,637 / 6,172 / 5,205 / 6,962 reasoning tokens on the same question)
  // and minimal|xhigh|max are 400s — so toggle-only like V2.5. Temperature is honoured
  // with thinking off (8 calls: 1 distinct answer at 0.01, 4 at 1.0; Xiaomi documents
  // that it is ignored while thinking). max_tokens capped at 131,072 (larger = 400).
  // Context: a 1,048,570-token prompt was ACCEPTED and answered empty — the API
  // truncates an over-limit prompt instead of rejecting it (windowConversation never
  // sends one); needles recalled at 286K (Ultraspeed, neutral wording). The first
  // Ultraspeed needle prompt came back "rejected because it was considered high risk"
  // (Xiaomi moderation on the phrase "secret passphrase"), not a context limit.
  {
    id: "mimo-v2.6-pro",
    label: "MiMo V2.6 Pro",
    provider: "xiaomi",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.435,
    outputCostPerMillionTokens: 0.87,
    cacheReadCostPerMillionTokens: 0.0036,
    supportsToggleThinking: true,
  },
  {
    id: "mimo-v2.6-flash",
    label: "MiMo V2.6 Flash",
    provider: "xiaomi",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.14,
    outputCostPerMillionTokens: 0.28,
    cacheReadCostPerMillionTokens: 0.0028,
    supportsToggleThinking: true,
  },
  {
    // V2.6 Pro served "up to 20×" faster (the earlier Ultraspeed was FP4-quantized,
    // so outputs may differ from Pro) at 10× Pro's price; measured ~545 tok/s of
    // reasoning. Same contract as Pro. No Batch API; rate limits "contact us".
    id: "mimo-v2.6-pro-ultraspeed",
    label: "MiMo V2.6 Pro UltraSpeed",
    provider: "xiaomi",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 4.35,
    outputCostPerMillionTokens: 8.7,
    cacheReadCostPerMillionTokens: 0.036,
    supportsToggleThinking: true,
  },
  // ── Moonshot AI (Kimi) — added 2026-07-12 ──────────────────────────────────
  // First-party OpenAI-compatible chat-completions at api.moonshot.ai/v1.
  // Flagship pair per platform.kimi.ai/docs/models; the older kimi-k2 series
  // (incl. kimi-latest + kimi-thinking-preview) is retired upstream, the legacy
  // moonshot-v1-* line is deliberately not carried, and kimi-k2.7-code (coding
  // specialist) is skipped — add on request. Thinking is a z.ai-style
  // {type:"enabled"|"disabled"} toggle (server default enabled); reasoning
  // streams in delta.reasoning_content; usage is the standard subset shape
  // (prompt_tokens_details.cached_tokens + completion_tokens_details.
  // reasoning_tokens). Automatic context caching — live-verified 1057/1057
  // cached on a repeat call (2026-07-12); the runtime passes
  // prompt_cache_key=conversationKey for affinity. Temperature is HARD-CAPPED
  // at 1 upstream (1.5 → live 400 "only 1 is allowed") — the runtime clamps.
  // maxOutputTokens undocumented — wire accepted max_completion_tokens=400000
  // without error (2026-07-12); family-standard 131072 chosen. Both models
  // report image+video input flags in /v1/models (we send text+image only).
  // k2.6's optional thinking.keep ("Preserved Thinking") is unused — our
  // transcripts never echo reasoning back.
  // ── Kimi K3 — added 2026-07-21 (Moonshot FIRST-PARTY entry.
  // The weights dropped 07-27 and the `fireworks`-hosted sibling
  // kimi-k3-fireworks SHIPPED 2026-08-29 — one entry + one
  // WIRE_MODEL_OVERRIDES row, see the Fireworks block below).
  // 2.8T-MoE flagship (launched 07-16), native vision, 1M ctx. EVERYTHING
  // below live-verified 2026-07-21 (12-probe battery + a 312,130-
  // token context probe with perfect needle recall — beyond the K2.x 262,144
  // class; ctx/maxOut = the documented 1,048,576):
  // - thinkingAlwaysOn + a reasoning_effort ladder low|high|max (docs; default
  //   max — the max-defaults rule AND the server default). Wire also accepts
  //   undocumented "medium" (behaves ≈low) — never send it; the runtime folds
  //   catalog-external levels to documented rungs.
  // - Sampling is FIXED upstream: temperature 1/top_p 0.95 — temperature≠1 is
  //   a live 400 ("only 1 is allowed"); the runtime OMITS temperature for K3
  //   (supportsTemperature:false hides the dial; the K2.x clamp path would 400
  //   below 1).
  // - The K2.x thinking:{type} param is DISAVOWED by the docs for K3 — the
  //   runtime never sends it. (Wire quirk: {type:"disabled"} actually DOES
  //   suppress reasoning today — undocumented, do not build on it; effort=low
  //   is the sanctioned near-off at ~5 reasoning tokens.)
  // - Automatic context caching (live: cache hits from the 2nd probe on, no
  //   key needed); prompt_cache_key is accepted harmlessly and still sent for
  //   affinity parity with K2.x. Cache-hit input $0.30.
  // - Usage: standard subset (prompt_tokens_details.cached_tokens +
  //   completion_tokens_details.reasoning_tokens) — no accounting changes.
  //   Reasoning streams in delta.reasoning_content; reasoning shares the
  //   output budget. max_completion_tokens is NOT cap-enforced by the wire
  //   (2M accepted silently); the DOCUMENTED cap equals the context
  //   (1,048,576). maxOutputTokens below is deliberately the family-standard
  //   131072 (K2.6 / K3-Fireworks class), NOT the documented 1,048,576:
  //   windowConversation budgets the transcript at ctx − maxOut, so an entry
  //   with maxOut == ctx reads as "no model ceiling" and a session dialed
  //   above ~1M would window past the real context.
  //   131072 is the wire cap we send as max_completion_tokens; no RP turn
  //   approaches it and the wire does not enforce the number anyway.
  {
    id: "kimi-k3",
    label: "Kimi K3",
    provider: "moonshot",
    ctx: 1_048_576,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
    cacheReadCostPerMillionTokens: 0.3,
    thinkingAlwaysOn: true,
    supportsEffort: true,
    effortOptions: ["low", "high", "max"],
    defaultEffort: "max",
    supportsTemperature: false,
  },
  {
    id: "kimi-k2.6",
    label: "Kimi K2.6",
    provider: "moonshot",
    ctx: 262144,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.95,
    outputCostPerMillionTokens: 4,
    cacheReadCostPerMillionTokens: 0.16,
    supportsToggleThinking: true,
  },
  // kimi-k2.5 REMOVED 2026-08-29: Moonshot sunsets it 2026-08-31 (official
  // model list; announced 08-24). Migration 0080 retargets kimi-k2.6.
  // Fireworks still serves the open weights (kimi-k2p5) if ever wanted back.
  // ── Fireworks AI (Kimi, Western-hosted) — added 2026-07-19 ─────────────────
  // Serves the open-weight Kimi family off the Moonshot (Chinese) first-party
  // endpoint — the response to the 2026-07 CN "AI Anthropomorphic Interactive
  // Services" rules (companion/roleplay crackdown on CN-operated services).
  // Fireworks is Moonshot's official launch partner (K2.5/K2.6/K2.7) and a
  // day-zero host for new Kimi releases — K3 landed here as kimi-k3-fireworks
  // on 2026-08-29 (entry below + its WIRE_MODEL_OVERRIDES row; a new Fireworks
  // model = one entry + one override row). OpenAI-compatible chat-completions
  // at api.fireworks.ai/inference/v1; reasoning streams in delta.reasoning_content.
  // Unlike Moonshot-direct's on/off thinking toggle, Fireworks exposes a
  // reasoning_effort ladder (low|medium|high; no true "off") — so this is an
  // EFFORT model (default "high" per the max-reasoning rule), which is also the
  // more honest model of the host's wire contract. The "-fireworks" catalog-id
  // suffix lets it coexist with the Moonshot-direct kimi-k2.6; the runtime maps
  // it to the wire id accounts/fireworks/models/kimi-k2p6 (Fireworks slugs the
  // version dot as "p"). maxOut 65536 is Fireworks' documented Kimi cap (below
  // Moonshot's 131072). LIVE-VERIFIED 2026-07-19: wire id serves, reasoning_effort
  // low|med|high accepted, temperature honored alongside effort, reasoning streams
  // in delta.reasoning_content, standard usage shape.
  // kimi-k2.6-fireworks REMOVED 2026-10-01: Fireworks took K2.6 (and K2.7 Code) off
  // serverless on 2026-09-25 — the id still appears in /models but every request is a
  // 404 "Model not found, inaccessible, and/or not deployed" (measured 2026-10-01).
  // Migration 0090 retargets it to the Moonshot-direct kimi-k2.6 (same weights).
  {
    // Kimi K3 (Fireworks) — added 2026-08-29 (serverless since
    // the 2026-07-27 weights drop, Day-0 per the Fireworks blog). Live-verified
    // with a live key: slug accounts/fireworks/models/kimi-k3 (NO p-notation —
    // that is only for version dots). $3/$15 + $0.30 cache-read mirrors
    // Moonshot first-party. ctx 1,048,576 (Fireworks serves the full window);
    // maxOut unpublished by the host — the sibling k2.6 cap (65,536) kept
    // until probed (reasoning shares the output budget; raise after a live
    // check). Effort per the Fireworks Kimi page = K3 semantics low|high|max.
    // Temperature dial since 2026-10-01. Moonshot fixes K3's
    // temperature, but Fireworks honours it: asked 20 times per setting for a random
    // number from 1 to 100, K3 gave 1 distinct answer at 0.01 and 5 at 1.0 at effort
    // low, and 2 and 6 at effort max. Workers send temperature 0 at effort max; on a
    // worker-shaped JSON task, three calls each with and without it all stopped
    // normally with valid JSON and no repeated text.
    id: "kimi-k3-fireworks",
    label: "Kimi K3 (Fireworks)",
    provider: "fireworks",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
    cacheReadCostPerMillionTokens: 0.3,
    supportsEffort: true,
    effortOptions: ["low", "high", "max"],
    defaultEffort: "max",
  },
  {
    // Kimi K3 Fast (Fireworks) — added 2026-10-01: Fireworks' fast serving tier of the
    // SAME K3 weights (wire id accounts/fireworks/routers/kimi-k3-fast; the response
    // reports accounts/fireworks/models/kimi-k3, which WIRE_SERVED_EQUIVALENTS maps back
    // so no substitution badge shows). Measured 2026-10-01: ~60–68 tok/s against ~23 on
    // kimi-k3-fireworks for the same 500-word answer; context limit 1,048,571 tokens (a
    // 1.43M prompt = 400), a 290K needle recalled; effort none|low|medium|high|xhigh|max
    // accepted ("none" turns thinking off; Fireworks maps medium->high, xhigh->max);
    // temperature honoured, with the dial since 2026-10-01 as on kimi-k3-fireworks (6
    // calls at effort low: 1 distinct answer at 0.01, 4 at 1.0; 20 calls at effort max: 3
    // and 4; temperature 0 at max on the worker JSON task: two calls, both clean).
    // $4.50/$0.45/$22.50 (1.5× K3).
    id: "kimi-k3-fast-fireworks",
    label: "Kimi K3 Fast (Fireworks)",
    provider: "fireworks",
    ctx: 1048576,
    maxOutputTokens: 65536,
    inputCostPerMillionTokens: 4.5,
    outputCostPerMillionTokens: 22.5,
    cacheReadCostPerMillionTokens: 0.45,
    supportsEffort: true,
    effortOptions: ["low", "high", "max"],
    defaultEffort: "max",
  },
  // ── GMICloud (Xiaomi MiMo, Western-hosted) — added 2026-07-19 ──────────────
  // US (San Jose) GPU cloud serving the open-weight MiMo family off the Xiaomi
  // (Chinese) first-party endpoint — same regulatory rationale as Fireworks/Kimi
  // above. OpenAI-compatible chat-completions at api.gmi-serving.com/v1; MiMo
  // reasoning streams in delta.reasoning_content. Thinking is ON by default;
  // the runtime disables it via the vLLM chat_template_kwargs.enable_thinking
  // flag (GMICloud's gateway 422s on MiMo's native thinking:{type} param). The
  // "-gmicloud" catalog-id suffix lets these coexist with the Xiaomi-direct mimo
  // entries; the runtime maps them to the wire ids XiaomiMiMo/MiMo-V2.5-Pro |
  // MiMo-V2.5 (no quant suffix). Pricing is GMICloud's rate (Pro is bf16
  // full-precision, and cheaper than Xiaomi-direct). LIVE-VERIFIED 2026-07-19:
  // both wire ids serve, reasoning on by default (reasoning_tokens>0), enable_
  // thinking:false zeroes reasoning, reasoning streams in delta.reasoning_content.
  // Prices are GMI's LIST prices (the same as Xiaomi-direct since V2.6); GMI applies a
  // per-model "discount_to_user" (2026-10-01: 5% on V2.6, 30% on V2.5 Pro, 15% on V2.5),
  // so costs display the undiscounted worst case, like DeepSeek's peak rates. The V2.5
  // rows used GMI's July rates ($0.35/$0.70, $0.11/$0.22) until this date.
  // MiMo V2.6 on GMI — added 2026-10-01 (Pro 2026-09-25, Flash 2026-09-28): the
  // chat_template_kwargs.enable_thinking=false switch zeroes reasoning (measured), as does
  // reasoning_effort "none"; low|medium|high are accepted, minimal|xhigh|max are 400s;
  // max_tokens capped at 131,072 ("This model supports at most 131072 completion
  // tokens"); temperature honoured with thinking off; a 286K needle recalled on Pro.
  // GMI still serves V2.5 (Xiaomi's 10-21 shutdown is its own API's).
  {
    id: "mimo-v2.6-pro-gmicloud",
    label: "MiMo V2.6 Pro (GMICloud)",
    provider: "gmicloud",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.435,
    outputCostPerMillionTokens: 0.87,
    cacheReadCostPerMillionTokens: 0.004,
    supportsToggleThinking: true,
  },
  {
    id: "mimo-v2.6-flash-gmicloud",
    label: "MiMo V2.6 Flash (GMICloud)",
    provider: "gmicloud",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.14,
    outputCostPerMillionTokens: 0.28,
    cacheReadCostPerMillionTokens: 0.003,
    supportsToggleThinking: true,
  },
  {
    id: "mimo-v2.5-pro-gmicloud",
    label: "MiMo v2.5 Pro (GMICloud)",
    provider: "gmicloud",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.435,
    outputCostPerMillionTokens: 0.87,
    supportsToggleThinking: true,
  },
  {
    id: "mimo-v2.5-gmicloud",
    label: "MiMo v2.5 (GMICloud)",
    provider: "gmicloud",
    ctx: 1000000,
    maxOutputTokens: 131072,
    inputCostPerMillionTokens: 0.14,
    outputCostPerMillionTokens: 0.28,
    supportsToggleThinking: true,
  },
];

// Mirrors the runtime predicates that decide whether `temperature` reaches the
// wire (see the ChatModel.supportsTemperature comment). Kept as a pure function
// so the catalog test can pin the derivation per family.
export function derivesTemperatureless(model: ChatModel): boolean {
  if (model.supportsEffort && (model.provider === "openai" || model.provider === "codex-bridge")) return true;
  // provider-runtime's `useAdaptiveThinking` is unconditional for adaptive-only
  // models (no supportsThinkingBudget), and every adaptive branch omits
  // temperature — including thinking-Off, which sends {} or {type:"disabled"}.
  if ((model.provider === "anthropic" || model.provider === "claude-code") && model.supportsAdaptiveThinking && !model.supportsThinkingBudget) return true;
  return false;
}

function withTemperatureSupport(models: ChatModel[]): ChatModel[] {
  return models.map((model) => ({
    supportsTemperature: !derivesTemperatureless(model),
    ...model,
  }));
}

export const CHAT_MODELS: ChatModel[] = withTemperatureSupport(RAW_CHAT_MODELS);

export function getChatModel(modelId: string) {
  return CHAT_MODELS.find((model) => model.id === modelId) ?? null;
}

// ── Usage → cost (single source for the server sessionStats and the web
// status-strip calculators, which until 2026-09-02 were hand-synchronized
// copies carrying the same two pricing bugs) ────────────────────────────────
export type UsageTokensForCost = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
};
export type EffectiveRates = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

// Per-million rates that apply to one request. Fast mode (per what the API
// actually applied) stacks its own cache multipliers (read 0.1×, write5m 1.25×,
// write1h 2×); otherwise the long-context tier reprices the WHOLE request when
// prompt-side tokens (input + cache read/write — cached tokens count toward the
// threshold, strict ">") exceed it; else base rates. Null when the model has no
// list price — a $0 entry (the subscription bridges) counts as unpriced, so
// those sessions show no cost rather than "$0.00" (parity with the calculators
// this replaces).
export function resolveEffectiveRates(model: ChatModel | null, usage: UsageTokensForCost, fastMode = false): EffectiveRates | null {
  if (!model?.inputCostPerMillionTokens || !model.outputCostPerMillionTokens) return null;
  if (fastMode && model.fastModeInputCostPerMillionTokens != null && model.fastModeOutputCostPerMillionTokens != null) {
    let fastInput = model.fastModeInputCostPerMillionTokens;
    let fastOutput = model.fastModeOutputCostPerMillionTokens;
    // Fast × long-context (gpt-6-astra, 2026-09-05): OpenAI's fast mode is "2×
    // the APPLICABLE rates", and past the >272K threshold the applicable rates
    // are the tier's. Scale the fast rates by the model's own tier ratios so a
    // fast long-context request doesn't bill at the short-context fast rate.
    // Anthropic fast entries carry no tier fields, so their math is untouched.
    if (model.longContextThresholdTokens != null) {
      const promptSide = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      if (promptSide > model.longContextThresholdTokens) {
        fastInput *= (model.longContextInputCostPerMillionTokens ?? model.inputCostPerMillionTokens) / model.inputCostPerMillionTokens;
        fastOutput *= (model.longContextOutputCostPerMillionTokens ?? model.outputCostPerMillionTokens) / model.outputCostPerMillionTokens;
      }
    }
    // Cache multipliers stack on the fast rates (pricing page): writes are 1.25×/2×
    // of fast input; the READ multiplier is the model's own base ratio (0.1×
    // for most, 0.05× on Claude Opus 5.5, 0.025× on Fable 5.1) — a flat 0.1×
    // would double-bill 5.5's cached reads under fast (2026-09-22).
    const cacheReadRatio = model.cacheReadCostPerMillionTokens != null ? model.cacheReadCostPerMillionTokens / model.inputCostPerMillionTokens : 0.1;
    return { input: fastInput, output: fastOutput, cacheRead: fastInput * cacheReadRatio, cacheWrite5m: fastInput * 1.25, cacheWrite1h: fastInput * 2 };
  }
  if (model.longContextThresholdTokens != null) {
    const promptSide = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (promptSide > model.longContextThresholdTokens) {
      // The tier reprices cache WRITES by the same ratio as input (OpenAI
      // pricing page, read 2026-09-23: gpt-6-astra cache writes $12.50 →
      // $25.00 past the threshold, gpt-5.6-sol $5 → $10 — 2×, like input).
      // Returning the BASE write rate here billed standard-mode writes at 1×
      // while the fast branch above billed them tier-scaled (fast is defined
      // as 2× the applicable rate; the two branches sat 4× apart).
      // Scaling the model's own write rates keeps entries without writes
      // (Gemini, Grok) at 0 and the 5m/1h slots in their catalog ratio.
      const tierInput = model.longContextInputCostPerMillionTokens ?? model.inputCostPerMillionTokens;
      const writeScale = tierInput / model.inputCostPerMillionTokens;
      return {
        input: tierInput,
        output: model.longContextOutputCostPerMillionTokens ?? model.outputCostPerMillionTokens,
        cacheRead: model.longContextCacheReadCostPerMillionTokens ?? model.cacheReadCostPerMillionTokens ?? 0,
        cacheWrite5m: (model.cacheWrite5mCostPerMillionTokens ?? 0) * writeScale,
        cacheWrite1h: (model.cacheWrite1hCostPerMillionTokens ?? 0) * writeScale,
      };
    }
  }
  return {
    input: model.inputCostPerMillionTokens,
    output: model.outputCostPerMillionTokens,
    cacheRead: model.cacheReadCostPerMillionTokens ?? 0,
    cacheWrite5m: model.cacheWrite5mCostPerMillionTokens ?? 0,
    cacheWrite1h: model.cacheWrite1hCostPerMillionTokens ?? 0,
  };
}

// The cache-WRITE rate a request bills at. The session TTL only picks 5m vs
// 1h (an Anthropic-only choice); it is NOT a gate on whether writes are
// billed — that is decided by the captured cacheWriteTokens. Providers whose
// sessions are pinned to cacheTtl "off" still write caches and report the
// tokens (OpenAI GPT-5.6 `cache_write_tokens` at 1.25× input; the ClaudeCode
// bridge's SDK-forced 1h) — gating on the TTL billed them at $0.
// Entries with a single write rate (OpenAI: 5m == 1h; bridges: 1h only) fall
// through to whichever rate exists.
export function resolveCacheWriteRate(rates: EffectiveRates, cacheTtl: "off" | "5m" | "1h" | null | undefined): number {
  if (cacheTtl === "1h") return rates.cacheWrite1h || rates.cacheWrite5m;
  return rates.cacheWrite5m || rates.cacheWrite1h;
}

// USD cost of one request's usage under the model's list price. Null when the
// model has no price (custom endpoints). Cache reads bill at the cache-read
// rate whenever one exists (Gemini implicit caching, Anthropic, OpenAI, the
// cache-hit providers); cache writes bill whenever tokens were written.
export function estimateUsageCostUsd(
  model: ChatModel | null,
  usage: UsageTokensForCost,
  options: { cacheTtl?: "off" | "5m" | "1h" | null; fastMode?: boolean } = {},
): number | null {
  const rates = resolveEffectiveRates(model, usage, options.fastMode ?? false);
  if (!rates) return null;
  let total = (usage.inputTokens ?? 0) * rates.input + (usage.outputTokens ?? 0) * rates.output;
  if (rates.cacheRead) total += (usage.cacheReadTokens ?? 0) * rates.cacheRead;
  const writeRate = resolveCacheWriteRate(rates, options.cacheTtl);
  if (writeRate) total += (usage.cacheWriteTokens ?? 0) * writeRate;
  return total / 1_000_000;
}

// Savings versus paying the input rate for the cached tokens — the status
// strip's "cache savings" figure. Null when nothing was read from cache or the
// model has no cache-read rate.
export function estimateCacheSavingsUsd(model: ChatModel | null, usage: UsageTokensForCost, fastMode = false): number | null {
  const rates = resolveEffectiveRates(model, usage, fastMode);
  const read = usage.cacheReadTokens ?? 0;
  if (!rates || !rates.cacheRead || read <= 0) return null;
  return (read * (rates.input - rates.cacheRead)) / 1_000_000;
}

// Helper overhead (researcher, HyDE, validator, presence, antagonist, contest,
// rolling diff): each entry carries a model and its tokens but no speed or
// cache split, so it prices at standard rates, with the long-context tier
// chosen by the call's own prompt size. ONE rule for the server's sessionStats
// and the web's fallback (the server used to price per-message overhead at
// base rates while the web tiered the rolling diff).
// Unpriced models (the $0 subscription bridges, custom endpoints) add nothing;
// null when nothing was priced.
export type HelperOverheadUsage = { modelId: string; inputTokens: number; outputTokens: number };
export function estimateHelperOverheadUsd(entries: ReadonlyArray<HelperOverheadUsage>): number | null {
  let total = 0;
  for (const entry of entries) {
    total += estimateUsageCostUsd(getChatModel(entry.modelId), { inputTokens: entry.inputTokens, outputTokens: entry.outputTokens }) ?? 0;
  }
  return total || null;
}

// Catalog id -> provider wire id, for surfaces whose catalog ids deliberately
// differ from the host's model slugs (the Western-hosted coexistence suffixes).
// SINGLE SOURCE: provider-runtime sends these on the wire, and the served-model
// transparency compare (web SessionConversation + the android port) treats a
// wire-form echo as "served exactly what was requested" — never a substitution
// badge. Add a row here when a new provider's wire ids diverge from catalog ids.
export const WIRE_MODEL_OVERRIDES: Record<string, string> = {
  // K3 has no dot to slug (live-verified 2026-08-29); Fireworks slugs version dots
  // as "p" (kimi-k2p6, removed 2026-10-01).
  "kimi-k3-fireworks": "accounts/fireworks/models/kimi-k3",
  // A Fireworks router, not a model: serves the K3 weights on its fast tier.
  "kimi-k3-fast-fireworks": "accounts/fireworks/routers/kimi-k3-fast",
  "mimo-v2.6-pro-gmicloud": "XiaomiMiMo/MiMo-V2.6-Pro",
  "mimo-v2.6-flash-gmicloud": "XiaomiMiMo/MiMo-V2.6-Flash",
  "mimo-v2.5-pro-gmicloud": "XiaomiMiMo/MiMo-V2.5-Pro",
  "mimo-v2.5-gmicloud": "XiaomiMiMo/MiMo-V2.5",
};

// Served-model echoes that mean "served exactly what was requested" for a wire id that
// is a router rather than a model: the Fireworks kimi-k3-fast router answers with the
// K3 model id it routed to (measured 2026-10-01). The runtimes' served-model normalizer
// maps these back to the catalog id, so the substitution badge stays for real swaps.
export const WIRE_SERVED_EQUIVALENTS: Record<string, readonly string[]> = {
  "kimi-k3-fast-fireworks": ["accounts/fireworks/models/kimi-k3"],
};

// The wire model id a request for this catalog id actually carries: explicit
// override, else the bridge-suffix strip (claude-code / codex-bridge variants),
// else the id itself.
export function wireChatModelId(modelId: string): string {
  const override = WIRE_MODEL_OVERRIDES[modelId];
  if (override) return override;
  if (modelId.endsWith("-codex-bridge")) return modelId.slice(0, -"-codex-bridge".length);
  if (modelId.endsWith("-bridge")) return modelId.slice(0, -"-bridge".length);
  return modelId;
}

// Pipeline workers' explicit reasoning effort (Engine dial `workerEffort`).
// Scope: EVERY model whose reasoning depth is
// governed by an effort ladder (`effortOptions`) — CodexBridge, OpenAI direct,
// xAI, Fireworks Kimi, Moonshot K3, z.ai GLM-5.3, Gemini 3.x (thinkingLevel).
// The 2026-07-14 version was a provider allowlist {codex-bridge, openai, xai}
// that froze the set at that day's ladders; every ladder added since (K3,
// K3-Fireworks, GLM-5.3, the Gemini 3.x levels) silently ran workers on the
// LOWEST rung because `effort: null` lands on each runtime's thinking-off
// floor (fixed 2026-09-02: the allowlist is gone, the ladder is the key).
// Excluded on purpose, because a different convention owns their
// reasoning and that convention is long-standing deliberate behavior, not
// this dial's business:
// - anthropic/claude-code — thinkingMode governs (Fable is always-adaptive;
//   the other bridges run the workers' thinking-off convention, and the
//   Opus-5 class 400s on disabled + xhigh/max).
// - toggle-thinking models (supportsToggleThinking: GLM-5.2 and older GLMs,
//   DeepSeek, Xiaomi/GMICloud MiMo, Moonshot K2.x) — the on/off toggle
//   governs; workers send thinking off, so no ladder depth applies even where
//   a hybrid model (GLM-5.2) also lists rungs.
// "model-max" or a rung the model doesn't offer resolves to the TOP of its
// ladder (the standing max-reasoning rule). NEVER silently tier
// workers below this resolution (a hidden "medium" worker tier once gutted
// the audit's refute gate).
const WORKER_EFFORT_THINKING_MODE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["anthropic", "claude-code"]);
export function workerEffortFor(modelId: string, dial?: string | null): EffortLevel | null {
  const model = getChatModel(modelId);
  if (!model?.effortOptions?.length) return null;
  if (WORKER_EFFORT_THINKING_MODE_PROVIDERS.has(model.provider) || model.supportsToggleThinking) return null;
  const options = model.effortOptions;
  if (dial && dial !== "model-max" && (options as string[]).includes(dial)) return dial as EffortLevel;
  return options[options.length - 1]!;
}

/** Worker thinking mode for a model.
 *  Pipeline workers send `thinkingMode: "off"` plus an explicit effort. Gemini 3.x
 *  can never disable thinking and its "off" branch pins the LOWEST thinkingLevel
 *  regardless of effort, so on Google ladder models the resolved worker effort
 *  only reaches the wire with thinking ON. Every other provider keeps the "off"
 *  convention (the interactive Off dial stays real there). */
export function workerThinkingModeFor(modelId: string, effort: EffortLevel | null | undefined): "enabled" | "off" {
  if (!effort) return "off";
  const model = getChatModel(modelId);
  return model?.provider === "google" && (model.effortOptions?.length ?? 0) > 0 ? "enabled" : "off";
}

/** OpenAI fast mode — the session dial `openaiFastModeEnabled`
 *  (2026-09-09). A model "supports" it when it is a DIRECT OpenAI entry with
 *  catalog fast pricing (the Responses runtime sends service_tier:"fast" and
 *  bills the fast rates) or a CodexBridge entry with `fastServiceTier` (the
 *  sidecar requests that App Server tier; $0 marginal). Every other provider —
 *  including the Claude bridges — is untouched by this dial. */
export function supportsOpenAIFastMode(model: ChatModel | null | undefined): boolean {
  if (!model) return false;
  if (model.provider === "openai") return model.fastModeInputCostPerMillionTokens != null && model.fastModeOutputCostPerMillionTokens != null;
  if (model.provider === "codex-bridge") return Boolean(model.fastServiceTier);
  return false;
}

/** The `speed` a caller passes to ChatRuntime.streamChat for this model under
 *  the dial: "fast" only when the dial is on AND the model supports OpenAI fast
 *  mode; otherwise undefined (standard), never a silent substitute. Workers,
 *  the per-turn helpers and the composer all resolve through this one helper
 *  so the caption's "supported models" list and the wire agree. */
export function openaiFastModeFor(modelId: string, dial: boolean | null | undefined): "fast" | undefined {
  if (!dial) return undefined;
  return supportsOpenAIFastMode(getChatModel(modelId)) ? "fast" : undefined;
}

/** Catalog models the dial can affect — the UI caption's source of truth. */
export function openaiFastModeSupportedModels(): ChatModel[] {
  return CHAT_MODELS.filter((model) => supportsOpenAIFastMode(model));
}

// New-session default, pinned explicitly so catalog display order can't silently
// change it (Fable 5.1 sits first in the picker but costs 2× Opus per token).
export const DEFAULT_CHAT_MODEL_ID = "claude-opus-4-6";

// Deployment-level default-model override. When the DEFAULT_MODEL_ID env var
// names a valid catalog chat model, it replaces the shipped default everywhere
// a default applies: new sessions, the campaign wizard, and every automated
// worker's model fallback (embedding models are unaffected). Unset or invalid
// → null, and callers keep their shipped per-surface defaults, so a stock
// install behaves identically. An invalid value is surfaced as a catalog
// invariant error at boot. Browser bundles have no process.env — the client
// reads the resolved value from the provider-keys bootstrap
// (defaultModelOverride), never from this function.
export function getConfiguredDefaultModelId(): string | null {
  const raw = typeof process === "undefined" ? undefined : process.env?.DEFAULT_MODEL_ID;
  const trimmed = raw?.trim();
  return trimmed && getChatModel(trimmed) ? trimmed : null;
}

export function getDefaultChatModelId() {
  return getConfiguredDefaultModelId() ?? getChatModel(DEFAULT_CHAT_MODEL_ID)?.id ?? CHAT_MODELS[0]?.id ?? DEFAULT_CHAT_MODEL_ID;
}

// The first entry is the web picker's default. The 2026-10-01 additions run at each model's top
// quality setting at the app's existing landscape sizes; their measured times and prices are on
// each entry (one image each unless noted, model-audits/2026-10-01-model-refresh).
export const IMAGE_MODELS: ImageModel[] = [
  {
    // gpt-image-1 deprecated upstream (shutdown 2026-12-01); successor.
    id: "gpt-image-2",
    label: "GPT Image 2",
    provider: "openai",
  },
  {
    // GPT Image 2.5 (released 2026-09-08). Flare is OpenAI's small, fast model; Sunburst
    // (below) its base model, rated above GPT Image 2. Both bill at GPT Image 2's token
    // rates and add the quality settings xhigh and max. At max, 1536x1024 is 5,488 output
    // tokens (about $0.16), what GPT Image 2 spends at high. Flare took 49 and 54 s.
    id: "gpt-image-2.5-flare",
    label: "GPT Image 2.5 Flare",
    provider: "openai",
    quality: "max",
  },
  {
    // At max: 114, 123 and 124 s over three images, inside the runtime's 180 s ceiling
    // (xhigh took 57 s for 2,459 tokens).
    id: "gpt-image-2.5-sunburst",
    label: "GPT Image 2.5 Sunburst",
    provider: "openai",
    quality: "max",
  },
  {
    // gemini-2.5-flash-image shuts down 2026-10-02; 3.1 successor live-verified.
    id: "gemini-3.1-flash-image",
    label: "Gemini 3.1 Flash Image",
    provider: "google",
  },
  {
    // Gemini 3 Pro Image (GA 2026-05-28), thinking always on. 1K and 2K both bill 1,120
    // image tokens ($0.134), so the runtime asks for 2K: 2752x1536 at 16:9 in 20 s
    // (the default 1K gave 1376x768 in 13 s). 4K bills $0.24.
    id: "gemini-3-pro-image",
    label: "Gemini 3 Pro Image",
    provider: "google",
    imageSize: "2K",
  },
  {
    id: "grok-imagine-image",
    label: "Grok Imagine",
    provider: "xai",
  },
  {
    // Grok Imagine 2.0. Its quality setting is low, medium or auto (auto runs low).
    // The runtime sends medium, $0.08 at 2k against $0.06 for low; medium took 76 s for
    // a 2496x1664 image at 3:2, auto 28 s. With no aspect ratio it chose portrait
    // (1664x2496) where Grok Imagine 1.0 returned 16:9 for the same prompt, so it asks
    // for 16:9.
    id: "grok-imagine-image-2.0",
    label: "Grok Imagine 2.0",
    provider: "xai",
    quality: "medium",
    aspectRatio: "16:9",
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
  // "local" is embedding-only (an OpenAI-compatible endpoint), not a chat provider,
  // so it widens EmbeddingModel.provider WITHOUT polluting the chat ProviderId union.
  provider: ProviderId | "local";
  dimensions: number;
  inputCostPerMillionTokens?: number;
  // Living-off-the-grid embedding support. `local:` models resolve to an
  // OpenAI-compatible endpoint (Ollama / HF TEI / LM Studio / vLLM) set via
  // LOCAL_EMBEDDING_URL. Local models were trained with TASK PREFIXES on the
  // input text (nomic: search_document:/search_query:, e5: passage:/query:) —
  // WITHOUT the right prefix retrieval silently degrades, so they're first-class
  // catalog data, not optional. recommendedThreshold is surfaced as a HINT next
  // to the semantic-threshold control (cosine geometry differs by model family);
  // it never auto-overrides the user's semanticThreshold (never-silently-override).
  documentPrefix?: string;
  queryPrefix?: string;
  recommendedThreshold?: number;
  // Marks a model whose provider endpoint comes from an env base URL rather than
  // a hosted API. Purely informational for the UI ("requires a local server").
  local?: boolean;
};

export const EMBEDDING_MODELS: EmbeddingModel[] = [
  { id: "openai:text-embedding-3-large", label: "OpenAI Embed 3 Large", provider: "openai", dimensions: 3072, inputCostPerMillionTokens: 0.13 },
  { id: "openai:text-embedding-3-small", label: "OpenAI Embed 3 Small", provider: "openai", dimensions: 1536, inputCostPerMillionTokens: 0.02 },
  { id: "google:gemini-embedding-2", label: "Google Embed 2", provider: "google", dimensions: 3072, inputCostPerMillionTokens: 0.2 },
  // Local / self-hosted (no API key, lorebook never leaves the box). Dormant
  // until LOCAL_EMBEDDING_URL is configured. Model id after `local:` is the wire
  // model name sent to the endpoint. Thresholds are model-geometry estimates —
  // confirm with a golden-turn eval before trusting a default.
  { id: "local:nomic-embed-text-v1.5", label: "Local · nomic-embed-text v1.5 (768d, CPU)", provider: "local", dimensions: 768, inputCostPerMillionTokens: 0, local: true, documentPrefix: "search_document: ", queryPrefix: "search_query: ", recommendedThreshold: 0.35 },
  { id: "local:bge-m3", label: "Local · BGE-M3 (1024d)", provider: "local", dimensions: 1024, inputCostPerMillionTokens: 0, local: true, recommendedThreshold: 0.55 },
];

export function getEmbeddingModel(modelId: string) {
  return EMBEDDING_MODELS.find((model) => model.id === modelId) ?? null;
}

// Startup + test-time validation of the catalog's internal invariants. Re-exported
// at the bottom so CHAT_MODELS et al. are defined before invariants.ts evaluates.
export { checkCatalogInvariants } from "./invariants";
// The effort a composer turn puts on the wire, for the web's Effort select.
export { composerEffortOnWire } from "./composerEffort";

// Canonical default embedding model. Was openai:text-embedding-3-large; flipped to
// google:gemini-embedding-2 on 2026-06-17 because the OpenAI key is dead — campaigns
// without an explicit embeddingModel were defaulting to a model that cannot embed at
// all (permanent coverage gaps + keyword-only retrieval). Per-campaign/session
// embeddingModel overrides still take precedence over this.
export const DEFAULT_EMBEDDING_MODEL = "google:gemini-embedding-2";
