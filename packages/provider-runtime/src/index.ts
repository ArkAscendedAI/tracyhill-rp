import { hkdfSync } from "node:crypto";

import { buildCustomChatModels, parseCustomChatModelId, type AttachmentContentMode, type ChatRole, type ChatUsage, type CustomEndpointSummary, type SessionCacheTtl, type SessionEffort, type SessionThinkingMode, type StopDetails } from "@tracyhill-rp/contracts";
import { WIRE_SERVED_EQUIVALENTS, getChatModel, getImageModel, wireChatModelId } from "@tracyhill-rp/model-catalog";

export type ChatPromptAttachment = {
  filename: string;
  mimeType: string;
  contentMode: AttachmentContentMode;
  content: string;
};

export type ChatPromptMessage = {
  role: ChatRole;
  content: string;
  attachments?: ChatPromptAttachment[];
};

export type ChatSpeed = "fast" | "standard";

export type ChatStreamCallbacks = {
  onStart: () => void;
  onDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onComplete: (result: {
    usage: ChatUsage;
    outputTruncated: boolean;
    stopReason: string | null;
    stopDetails: StopDetails;
    // Model that actually produced the response, as reported by the upstream
    // (message_start.message.model on direct Anthropic; served_model on the
    // bridge's final message_delta). Null when the provider doesn't report it.
    // Fable 5 safeguard fallbacks can silently serve from another model — the
    // UI surfaces a mismatch against the requested model.
    servedModel?: string | null;
  }) => void;
};

export type ChatRuntime = {
  streamChat: (input: {
    modelId: string;
    systemPrompt?: string | null;
    messages: ChatPromptMessage[];
    requestId: string;
    // Stable per-conversation key (session id). xAI sends it as x-grok-conv-id
    // to improve prompt-cache affinity; other providers ignore it.
    conversationKey?: string | null;
    maxOutputTokens?: number | null;
    temperature?: number | null;
    thinkingMode?: SessionThinkingMode | null;
    thinkingBudget?: number | null;
    effort?: SessionEffort | null;
    cacheTtl?: SessionCacheTtl | null;
    // Anthropic fast mode opt-in. chatService gates this — only set when the
    // model has fastModeInputCostPerMillionTokens AND model.provider !== "claude-code".
    speed?: ChatSpeed | null;
    signal?: AbortSignal;
    // Per-call total-stream ceiling override. undefined = the 35-min
    // CHAT_STREAM_TIMEOUT_MS backstop; 0 = NO total ceiling — the caller's
    // signal and the SSE inactivity gate are the only stops. The wizard runs
    // undeadlined (2026-08-09): a corpus generation may
    // legitimately outrun any fixed timer, and the run's Cancel aborts it.
    streamTimeoutMs?: number | null;
  }, callbacks: ChatStreamCallbacks) => Promise<void>;
};

export type ImageGenerationRuntime = {
  generateImage: (input: {
    modelId: string;
    prompt: string;
    requestId: string;
    // LOW tail: optional caller abort. Threaded into withTimeout so a cancelled
    // request tears down the in-flight image fetch instead of running to the
    // 3-min ceiling. Backward-compatible — callers that omit it are unaffected.
    signal?: AbortSignal;
  }) => Promise<{
    mimeType: string;
    bytes: Uint8Array;
  }>;
};

export type CodexAgentConnection = {
  codexAgentHost: string;
  codexAgentPort: number;
  codexAgentSecret: string;
  codexAgentCaPath: string;
  codexAgentServername: string;
};

// Single resolver for the CODEX_* connection env — the api, the dedicated
// worker, and the maintenance tools all spread this into their runtime
// defaults. A new CODEX_* variable lands here once instead of in five copies
// that drift.
export function resolveCodexAgentConnection(env: Record<string, string | undefined> = process.env): CodexAgentConnection {
  return {
    codexAgentHost: env.CODEX_HOST ?? "",
    codexAgentPort: parseEnvPort(env.CODEX_PORT, 7701),
    codexAgentSecret: env.CODEX_SECRET ?? "",
    codexAgentCaPath: env.CODEX_CA_PATH ?? "",
    codexAgentServername: env.CODEX_SERVERNAME ?? "codex-agent",
  };
}

export type RunnerConnection = { runnerUrl: string; runnerSecret: string };
export const DEFAULT_RUNNER_URL = "http://tracyhill-rp-runner:7710";

/**
 * The shared secret between the API/worker and the subscription runner. An
 * explicit RUNNER_SECRET wins (cross-host deployments); otherwise it derives from
 * SESSION_SECRET with the same HKDF parameters the runner uses
 * (apps/runner/lib/config.js), so the shipped Compose file needs no extra
 * variable. Pinned vector in the tests on both sides.
 */
export function deriveRunnerSecret(sessionSecret: string | undefined): string {
  const secret = String(sessionSecret ?? "").trim();
  if (!secret) return "";
  return Buffer.from(hkdfSync("sha256", secret, "tracyhill-rp", "runner-secret", 32)).toString("hex");
}

export function resolveRunnerConnection(env: Record<string, string | undefined> = process.env): RunnerConnection {
  const explicit = (env.RUNNER_SECRET ?? "").trim();
  return {
    runnerUrl: ((env.RUNNER_URL ?? "").trim() || DEFAULT_RUNNER_URL).replace(/\/$/, ""),
    runnerSecret: explicit || deriveRunnerSecret(env.SESSION_SECRET),
  };
}

// Env port parser. `Number(env.X ?? default)` had two failure modes: a compose
// interpolation that resolves to the EMPTY string is not nullish, so it became
// port 0, and a stray character (`7701;`) became NaN — both surfacing much later
// as an opaque ERR_SOCKET_BAD_PORT on the first bridge call instead of the
// default. Anything that isn't a whole in-range port number falls back.
function parseEnvPort(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const port = Number.parseInt(trimmed, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

export function createMockChatRuntime(): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      if (input.signal?.aborted) throw abortError();
      callbacks.onStart();
      const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
      const text = input.systemPrompt?.includes("Campaign Creation Wizard")
        ? buildMockWizardReply(lastUser?.content ?? "")
        : `Echo: ${lastUser?.content ?? ""}`.trim();
      if (input.signal?.aborted) throw abortError();
      const chunks = chunkText(text, 8);
      for (const chunk of chunks) {
        callbacks.onDelta(chunk);
        await wait(40);
        if (input.signal?.aborted) throw abortError();
      }
      if (input.signal?.aborted) throw abortError();
      callbacks.onComplete({
        usage: {
          inputTokens: lastUser?.content.length ?? 0,
          outputTokens: text.length,
          totalTokens: (lastUser?.content.length ?? 0) + text.length,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          speed: null,
        },
        outputTruncated: false,
        stopReason: null,
        stopDetails: null,
      });
    },
  };
}

function chunkText(value: string, size: number) {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length ? chunks : [value];
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockImageGenerationRuntime(): ImageGenerationRuntime {
  return {
    async generateImage() {
      return {
        mimeType: "image/png",
        bytes: base64ToBytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII="),
      };
    },
  };
}

export function createOpenAIResponsesRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return createOpenAICompatibleResponsesRuntime({
    baseUrl: "https://api.openai.com/v1",
    apiKey,
    authHeader: "Bearer",
  }, fetchImpl);
}

export function createOpenAIChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return createOpenAICompatibleChatCompletionsRuntime({
    baseUrl: "https://api.openai.com/v1",
    apiKey,
    authHeader: "Bearer",
  }, {
    includeStreamUsage: true,
    pdfMode: "native",
    errorLabel: "openai",
    // OpenAI's own chat-completions wire: `max_tokens` is deprecated in favor of
    // `max_completion_tokens` and rejected by the reasoning-family chat models
    // ("Unsupported parameter: 'max_tokens'"); every current OpenAI chat model
    // accepts the new name (`chat-latest` tracks a GPT-5.6-based
    // tuning). Custom OpenAI-compatible endpoints keep `max_tokens`, the name
    // the wider ecosystem understands.
    outputCapParam: "max_completion_tokens",
  }, fetchImpl);
}

// Internal: shared by the OpenAI-direct and custom `responses` runtimes (no external consumer).
function createOpenAICompatibleResponsesRuntime(
  endpoint: Pick<CustomEndpointSummary, "baseUrl" | "apiKey" | "authHeader">,
  fetchImpl: typeof fetch = fetch,
  options: { stripUpstreamErrors?: boolean; errorLabel?: string } = {},
): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const model = getChatModel(input.modelId);
      const response = await fetchImpl(joinEndpointUrl(endpoint.baseUrl, "responses"), {
        method: "POST",
        // Custom endpoints are validated at save time; following redirects
        // would let a 3xx re-route the request to an unvalidated host.
        redirect: "error",
        headers: {
          ...buildAuthHeaders(endpoint.authHeader, endpoint.apiKey),
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          // Responses has no system message — the prompt rides `instructions`,
          // which bypasses withSystemPrompt, so strip the Anthropic-only cache
          // sentinels here (every campaign turn carries them).
          instructions: input.systemPrompt ? stripCacheSentinels(input.systemPrompt) : undefined,
          input: input.messages.map((message) => ({
            role: message.role,
            content: buildOpenAIResponsesMessageContent(message),
          })),
          max_output_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 100000),
          // Only attach `reasoning` for a KNOWN reasoning model (a resolved
          // catalog entry with effort support). For a custom `responses` endpoint
          // `getChatModel` returns null, so the old default-"high" reasoning param
          // was sent unconditionally — non-reasoning custom models 400 on it. And
          // since the responses path otherwise never forwards temperature, pass it
          // through for custom endpoints when the caller provided one.
          ...(model?.supportsEffort
            ? { reasoning: { effort: resolveOpenAIResponsesEffort(model, input.effort, input.thinkingMode), summary: "detailed" } }
            : input.temperature != null ? { temperature: input.temperature } : {}),
          // OpenAI fast mode (gpt-6-astra, 2026-09-05): the session fast toggle
          // arrives as speed:"fast" (the same input Anthropic uses); the OpenAI
          // wire is service_tier:"fast" (2× applicable rates; the response
          // echoes it — captured below into usage.speed so the fast badge and
          // fast-rate billing engage only when the API actually applied it).
          // Gated on catalog fast pricing so custom endpoints and non-fast
          // models never see the param.
          ...(input.speed === "fast" && model?.fastModeInputCostPerMillionTokens != null ? { service_tier: "fast" } : {}),
          stream: true,
        }),
      });
      if (!response.ok || !response.body) {
        // Custom endpoint sink: drop the upstream body so it can't be used as an
        // SSRF readback channel.
        throw await providerHttpError(options.stripUpstreamErrors ? "custom endpoint" : options.errorLabel ?? "openai", response, {
          secret: endpoint.apiKey,
          stripBody: options.stripUpstreamErrors,
        });
      }
      callbacks.onStart();
      let outputTruncated = false;
      let terminalReceived = false;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      // A refused turn streams `response.refusal.delta/.done` (and a `refusal`
      // content part on the output item) instead of text, then completes
      // normally. Those events used to fall through, so the turn was persisted
      // as an empty SUCCESSFUL reply with stopReason null and the model's own
      // refusal sentence lost. Capture it and end the turn the way the
      // Anthropic runtime ends one: stopReason "refusal" + stop_details carrying
      // the text, which the web/Android refusal cards already render.
      let refusalText = "";
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") {
          // Some custom Responses adapters use the chat-completions sentinel.
          if (options.stripUpstreamErrors) terminalReceived = true;
          break;
        }
        if (event.name === "response.output_text.delta") {
          const payload = safeJson(event.data) as { delta?: string };
          if (payload.delta) callbacks.onDelta(payload.delta);
        }
        if (event.name === "response.refusal.delta") {
          const payload = safeJson(event.data) as { delta?: string };
          if (payload.delta) refusalText += payload.delta;
        }
        if (event.name === "response.refusal.done") {
          const payload = safeJson(event.data) as { refusal?: string };
          if (payload.refusal) refusalText = payload.refusal;
        }
        if (event.name === "response.output_item.done") {
          const payload = safeJson(event.data) as { item?: { content?: OpenAIResponsesRefusalPart[] } };
          const refusal = findResponsesRefusalPart(payload.item?.content);
          if (refusal && !refusalText) refusalText = refusal;
        }
        if (event.name === "response.created") {
          const payload = safeJson(event.data) as { response?: { model?: string } };
          if (payload.response?.model) servedModel = payload.response.model;
        }
        if (event.name === "response.reasoning_summary_text.delta" || event.name === "response.reasoning_text.delta") {
          const payload = safeJson(event.data) as { delta?: string };
          if (payload.delta) callbacks.onThinkingDelta(payload.delta);
        }
        if (event.name === "response.completed" || event.name === "response.done" || event.name === "response.incomplete") {
          const payload = safeJson(event.data) as OpenAIResponsesTerminalPayload;
          usage = buildOpenAIResponsesUsage(payload.response?.usage ?? payload.usage);
          const tier = payload.response?.service_tier ?? payload.service_tier;
          if (tier === "fast" || tier === "standard") usage = { ...usage, speed: tier };
          servedModel = payload.response?.model ?? payload.model ?? servedModel;
          if (event.name === "response.incomplete") {
            outputTruncated = true;
            stopReason = payload.response?.incomplete_details?.reason ? `incomplete:${payload.response.incomplete_details.reason}` : "incomplete";
          }
          if (!refusalText) {
            for (const item of payload.response?.output ?? []) {
              const refusal = findResponsesRefusalPart(item?.content);
              if (refusal) { refusalText = refusal; break; }
            }
          }
          terminalReceived = true;
          break;
        }
        if (event.name === "response.failed") {
          const payload = safeJson(event.data) as { response?: { error?: { message?: string } }; error?: { message?: string }; message?: string };
          throw new Error(payload.response?.error?.message ?? payload.error?.message ?? payload.message ?? "openai streaming error");
        }
        if (event.name === "error") {
          const payload = safeJson(event.data) as { error?: { message?: string }; message?: string };
          throw new Error(payload.error?.message ?? payload.message ?? "openai streaming error");
        }
      }
      requireStreamTerminal(terminalReceived, "Responses");
      // Mirror the Anthropic representation (stop_reason "refusal" +
      // stop_details {type, category, explanation}): Responses carries no
      // category, so the model's refusal text rides `explanation`. An
      // incomplete terminal keeps its own stopReason; the details still carry
      // the text.
      const stopDetails: StopDetails = refusalText ? { type: "refusal", category: null, explanation: refusalText } : null;
      callbacks.onComplete({ usage, outputTruncated, stopReason: stopReason ?? (refusalText ? "refusal" : null), stopDetails, servedModel });
    },
  };
}

// Google's documented per-request filter configuration (v1beta
// `safetySettings`). We previously sent NOTHING, which silently ran every
// Gemini call at Google's default thresholds — the strictest posture — and is
// why Gemini looked unusable for adult fiction here while the same models are
// used for it elsewhere. This is first-party API configuration, not a prompt
// trick: the caller declares the filtering appropriate to a private,
// adult, single-tenant deployment, and Google's own non-configurable floors
// still apply underneath (they are not ours to move and we do not try).
//
// "OFF" is the newer threshold (Gemini 2.0+) and disables the configurable
// filter for that category; "BLOCK_NONE" is the legacy equivalent and on some
// accounts historically required allowlisting. If a model ever rejects OFF, the
// request 400s loudly rather than silently degrading — swap to BLOCK_NONE here.
const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
] as const;

export function createGoogleGeminiRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const model = getChatModel(input.modelId);
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${input.modelId}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          // systemInstruction bypasses withSystemPrompt — strip the
          // Anthropic-only cache sentinels here. Before this, every
          // campaign turn on Gemini carried literal <<<TR_SEC>>> delimiters.
          ...(input.systemPrompt ? {
            systemInstruction: {
              parts: [{ text: stripCacheSentinels(input.systemPrompt) }],
            },
          } : {}),
          contents: buildGeminiContents(input.messages),
          generationConfig: buildGeminiGenerationConfig(model, input),
          safetySettings: GEMINI_SAFETY_SETTINGS,
        }),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("google", response, { secret: apiKey });
      }
      callbacks.onStart();
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let outputTruncated = false;
      for await (const event of readSseEvents(response.body)) {
        const payload = safeJson(event.data) as {
          candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
          modelVersion?: string;
          error?: { message?: string };
          promptFeedback?: { blockReason?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        // A filter block is NOT an error response on this API: the stream ends
        // with promptFeedback (input blocked) or finishReason SAFETY/PROHIBITED
        // (output stopped) and zero text parts. Left unhandled that surfaces as
        // a silent empty turn, which is exactly the failure class the
        // watchdog work exists to kill — fail loud instead so the reason is
        // visible in the message and in system events.
        if (payload.promptFeedback?.blockReason) {
          throw new Error(`google blocked the request before generation (${payload.promptFeedback.blockReason}) — model-level filtering, not a configurable safetySettings category`);
        }
        const finish = payload.candidates?.[0]?.finishReason;
        if (finish && ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"].includes(finish)) {
          throw new Error(`google stopped generation (${finish}) — model-level filtering, not a configurable safetySettings category`);
        }
        if (payload.modelVersion) servedModel = payload.modelVersion;
        if (payload.candidates?.[0]?.finishReason) stopReason = payload.candidates[0].finishReason;
        if (payload.candidates?.[0]?.finishReason === "MAX_TOKENS") outputTruncated = true;
        for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
          if (typeof part.text !== "string") continue;
          if (part.thought) callbacks.onThinkingDelta(part.text);
          else callbacks.onDelta(part.text);
        }
        if (payload.usageMetadata) {
          // candidatesTokenCount EXCLUDES thoughts; Google bills thoughts as
          // output, so outputTokens = candidates + thoughts (billing-true).
          const thoughts = payload.usageMetadata.thoughtsTokenCount ?? 0;
          const candidates = payload.usageMetadata.candidatesTokenCount ?? null;
          // cachedContentTokenCount is a SUBSET of promptTokenCount — normalize
          // to disjoint so inputTokens excludes the cached portion.
          const { inputTokens, cacheReadTokens } = normalizeSubsetCacheUsage(
            payload.usageMetadata.promptTokenCount ?? null,
            payload.usageMetadata.cachedContentTokenCount ?? null,
          );
          usage = {
            inputTokens,
            outputTokens: candidates != null || thoughts > 0 ? (candidates ?? 0) + thoughts : null,
            totalTokens: payload.usageMetadata.totalTokenCount ?? null,
            cacheReadTokens,
            cacheWriteTokens: null,
            reasoningTokens: payload.usageMetadata.thoughtsTokenCount ?? null,
            speed: null,
          };
        }
      }
      requireStreamTerminal(Boolean(stopReason && stopReason !== "FINISH_REASON_UNSPECIFIED"), "Google");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

export function createAnthropicMessagesRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return createAnthropicMessagesRuntimeWithEndpoint({
    url: "https://api.anthropic.com/v1/messages",
    authMode: "x-api-key",
    apiKey,
    forceCacheTtl1h: false,
  }, fetchImpl);
}

// Shared between the direct-Anthropic runtime and the ClaudeCode-bridge
// runtime. The bridge speaks the same Anthropic Messages dialect; the only
// differences are the URL, the auth header style (Bearer vs x-api-key), and
// the SDK's hard requirement that all cache_control breakpoints use ttl:"1h"
// (the SDK auto-injects 1h breakpoints and rejects mixed-TTL requests). The
// model ID transformer maps "claude-opus-4-7-bridge" → "claude-opus-4-7"
// before the wire payload is built.
export function createAnthropicMessagesRuntimeWithEndpoint(
  endpoint: {
    url: string;
    authMode: "x-api-key" | "Bearer";
    apiKey: string;
    forceCacheTtl1h?: boolean;
    mapModelId?: (id: string) => string;
    // Always put the resolved effort on the wire (2026-09-22). The Claude bridge
    // hands an OMITTED effort to the Agent SDK, whose CLI then applies its own
    // per-model default (not necessarily the API's) — so a session dialed "high"
    // could run at whatever the CLI chose. The bridge endpoint sets this so the
    // dial is what runs; the direct API keeps omitting the API default (equal
    // behavior and cache-safe per the docs). Only for models whose catalog
    // entry supports effort: resolveAnthropicEffort yields null for the rest
    // (Haiku bridge), so nothing is sent there.
    alwaysSendEffort?: boolean;
    // Extra request headers, e.g. the subscription runner's per-user id.
    extraHeaders?: Record<string, string>;
  },
  fetchImpl: typeof fetch = fetch,
): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const wireModelId = endpoint.mapModelId ? endpoint.mapModelId(input.modelId) : input.modelId;
      const model = getChatModel(input.modelId);
      // Opus 5 family (thinkingDefaultOn): disabled thinking is only legal at
      // effort ≤ thinkingOffMaxEffort ("high" — disabled + xhigh/max is a live
      // 400), so clamp the resolved effort while thinking is off. The composer
      // hides the higher rungs too; this covers workers and stale session dials.
      const anthropicThinkingOff = !input.thinkingMode || input.thinkingMode === "off";
      const anthropicEffort = clampEffortForDisabledThinking(
        resolveAnthropicEffort(model, input.effort), model, anthropicThinkingOff);
      const anthropicMaxThinkingBudget = model?.maxThinkingBudget ?? 4095;
      // Adaptive-only models always use adaptive; dual-mode models (Opus 4.6 /
      // Sonnet 4.6) honor the session's explicit thinkingMode — the old
      // !supportsThinkingBudget condition made the UI's "Adaptive" silently
      // send budget thinking on them.
      const useAdaptiveThinking = Boolean(model?.supportsAdaptiveThinking)
        && (!model?.supportsThinkingBudget || input.thinkingMode === "adaptive");
      // Fast mode: only forward to upstream if the caller asked AND this is the direct
      // API endpoint, never the Claude bridge route. The bridge exclusion is deliberate
      // (2026-09-09): Agent SDK 0.3.258 accepts a
      // `fastMode` session setting, but it bills usage credits at the direct fast rate
      // and only exists on Opus 4.8/5 — chatService gates it and this is defense in depth.
      const fastMode = input.speed === "fast" && !endpoint.forceCacheTtl1h;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-client-request-id": input.requestId,
      };
      if (endpoint.authMode === "x-api-key") {
        headers["x-api-key"] = endpoint.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["authorization"] = `Bearer ${endpoint.apiKey}`;
      }
      if (fastMode) {
        // Beta header required by the fast-mode research preview. If multiple beta
        // features are ever needed simultaneously, comma-join in a single header.
        headers["anthropic-beta"] = "fast-mode-2026-02-01";
      }
      if (endpoint.extraHeaders) Object.assign(headers, endpoint.extraHeaders);
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers,
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify((() => {
          const requestedTtl = endpoint.forceCacheTtl1h ? "1h" : (input.cacheTtl ?? "off");
          const cacheTag = buildCacheTag(requestedTtl);
          const mergedMessages = buildAnthropicMessages(input.messages);
          addMessageCacheBreakpoints(mergedMessages, cacheTag);
          const reqBody = {
            model: wireModelId,
            ...(input.systemPrompt ? { system: buildAnthropicSystemPrompt(input.systemPrompt, cacheTag) } : {}),
            // Resolve the output cap by the CATALOG id (input.modelId), not the
            // stripped wire id: claude-haiku-4-5-bridge → claude-haiku-4-5, whose
            // direct catalog entry is claude-haiku-4-5-20251001, so a wireModelId
            // lookup misses and silently falls back to 4096 instead of 64000.
            max_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 4096),
            // Always-on models (Fable 5 family): thinking runs even when the param is
            // omitted and {type:"disabled"} is a 400 — send adaptive+summarized
            // unconditionally so the (always billed) thinking stays visible instead of
            // silently running with display:"omitted".
            ...(model?.thinkingAlwaysOn
              ? { thinking: { type: "adaptive", display: "summarized" } }
              : input.thinkingMode && input.thinkingMode !== "off"
              ? useAdaptiveThinking
                ? { thinking: { type: "adaptive", display: "summarized" } }
                : { thinking: { type: "enabled", budget_tokens: clamp(input.thinkingBudget ?? anthropicMaxThinkingBudget, 1024, anthropicMaxThinkingBudget) }, temperature: 1 }
              // Adaptive-thinking-only models (Opus 4.7 family) reject the temperature param
              // entirely on direct Anthropic API. Drop it regardless of thinkingMode so callers
              // that hardcode temperature: 0 (workers) don't hit "temperature is deprecated".
              // Opus 5 family (thinkingDefaultOn): an OMITTED thinking param means thinking
              // ON server-side — "off" must go out as an explicit disable or the dial
              // silently does nothing (and unset-thinkingMode callers would silently flip
              // from no-thinking to thinking-on cost/latency). Claude Sonnet 5.5 rejects
              // "disabled" and names its off type, "between_tools" (catalog thinkingOffType,
              // 2026-10-01); the effort cap above applies to it the same way.
              : useAdaptiveThinking
              ? (model?.thinkingDefaultOn ? { thinking: { type: model.thinkingOffType ?? "disabled" } } : {})
              : input.temperature != null ? { temperature: input.temperature } : {}),
            // Omit the effort only when it equals the model's API default ("high"
            // everywhere except Claude Opus 5.5, whose default is "medium" —
            // catalog apiDefaultEffort, 2026-09-22): explicit-default == omitted
            // per the docs and does not disturb the prompt cache, while omitting a
            // "high" dial on a medium-default model would silently run one rung
            // lower. Bridge endpoints always send it (see alwaysSendEffort).
            ...(anthropicEffort && (endpoint.alwaysSendEffort || anthropicEffort !== (model?.apiDefaultEffort ?? "high"))
              ? { output_config: { effort: anthropicEffort } }
              : {}),
            ...(fastMode ? { speed: "fast" } : {}),
            messages: mergedMessages,
            stream: true,
          };
          return reqBody;
        })()),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("anthropic", response, { secret: endpoint.apiKey });
      }
      callbacks.onStart();
      let terminalReceived = false;
      let activeBlockType: string | null = null;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let outputTruncated = false;
      let stopReason: string | null = null;
      let stopDetails: StopDetails = null;
      let servedModel: string | null = null;
      for await (const event of readSseEvents(response.body)) {
        const payload = safeJson(event.data) as {
          delta?: { text?: string; stop_reason?: string; stop_details?: { type?: string; category?: string | null; explanation?: string | null } | null; served_model?: string };
          message?: { model?: string; usage?: AnthropicWireUsage };
          usage?: AnthropicWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (event.name === "content_block_start") {
          activeBlockType = (payload as { content_block?: { type?: string } }).content_block?.type ?? null;
        }
        if (event.name === "content_block_stop") activeBlockType = null;
        if (event.name === "content_block_delta") {
          if ((payload.delta as { type?: string; thinking?: string } | undefined)?.type === "thinking_delta" || activeBlockType === "thinking") {
            const thinking = (payload.delta as { thinking?: string } | undefined)?.thinking ?? "";
            if (thinking) callbacks.onThinkingDelta(thinking);
          } else if (payload.delta?.text) {
            callbacks.onDelta(payload.delta.text);
          }
        }
        // message_delta carries stop_reason + (refusal-only) stop_details. Capture both
        // for persistence; refusal handling lives downstream in the UI.
        if (payload.delta?.stop_reason) {
          stopReason = payload.delta.stop_reason;
          if (payload.delta.stop_reason === "max_tokens") outputTruncated = true;
        }
        if (payload.delta?.stop_details) {
          const sd = payload.delta.stop_details;
          stopDetails = {
            type: sd.type ?? "refusal",
            category: sd.category ?? null,
            explanation: sd.explanation ?? null,
          };
        }
        // Serving-model report. Direct Anthropic stamps it on message_start
        // (payload.message.model); the bridge's eager message_start carries the
        // *requested* model, so its final message_delta adds served_model with
        // the model the SDK actually ran — last write wins.
        if (payload.message?.model) servedModel = payload.message.model;
        if (payload.delta?.served_model) servedModel = payload.delta.served_model;
        const nextUsage = payload.message?.usage ?? payload.usage;
        if (nextUsage) {
          const mergedInput = nextUsage.input_tokens ?? usage.inputTokens;
          const mergedOutput = nextUsage.output_tokens ?? usage.outputTokens;
          usage = {
            inputTokens: mergedInput,
            outputTokens: mergedOutput,
            // Recompute from the MERGED values — requiring one event to carry
            // both fields left total stale at input+1 when the final
            // message_delta (output-only on the wire) updated outputTokens.
            totalTokens: mergedInput != null && mergedOutput != null ? mergedInput + mergedOutput : usage.totalTokens,
            // Anthropic reports cache_read_input_tokens DISJOINT from input_tokens
            // already — no subset normalization (that's the convention the other
            // dialects are mapped ONTO).
            cacheReadTokens: nextUsage.cache_read_input_tokens ?? usage.cacheReadTokens,
            cacheWriteTokens: nextUsage.cache_creation_input_tokens ?? usage.cacheWriteTokens,
            reasoningTokens: nextUsage.output_tokens_details?.thinking_tokens ?? usage.reasoningTokens,
            // Verify which speed actually ran (we may request fast but get standard
            // on deprecated models after the rollback window).
            speed: nextUsage.speed === "fast" ? "fast" : nextUsage.speed === "standard" ? "standard" : usage.speed,
          };
        }
        // message_stop is terminal — break so the generator cancels the reader.
        if (event.name === "message_stop") { terminalReceived = true; break; }
      }
      requireStreamTerminal(terminalReceived, "Anthropic messages");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails, servedModel });
    },
  };
}

const CACHE_BOUNDARY_SENTINEL = "<<<TR_CACHE_BOUNDARY>>>\n";

type CacheTag = { type: "ephemeral"; ttl?: string } | null;

function buildCacheTag(cacheTtl: SessionCacheTtl): CacheTag {
  if (cacheTtl === "off") return null;
  if (cacheTtl === "1h") return { type: "ephemeral" as const, ttl: "1h" };
  return { type: "ephemeral" as const };
}

function buildAnthropicSystemPrompt(systemPrompt: string, cacheTag: CacheTag) {
  const sections = splitAnthropicSystemPromptSections(systemPrompt);
  const sentinelIdx = sections.findIndex(s => s.startsWith(CACHE_BOUNDARY_SENTINEL));
  const boundary = sentinelIdx >= 0 ? sentinelIdx : sections.length - 1;
  return sections.map((text, index) => ({
    type: "text",
    text: index === sentinelIdx ? text.slice(CACHE_BOUNDARY_SENTINEL.length) : text,
    ...(cacheTag && index === boundary ? { cache_control: cacheTag } : {}),
  }));
}

function addMessageCacheBreakpoints(
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
  cacheTag: CacheTag,
) {
  if (!cacheTag || messages.length < 6) return messages;
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  if (userIndices.length < 4) return messages;
  const stablePos = Math.max(0, Math.floor(userIndices.length / 10) * 10 - 10);
  const targetIdx = userIndices[stablePos];
  applyCacheControl(messages[targetIdx], cacheTag);
  return messages;
}

function applyCacheControl(
  msg: { role: string; content: string | Array<Record<string, unknown>> },
  cacheTag: CacheTag,
) {
  if (!cacheTag) return;
  if (typeof msg.content === "string") {
    msg.content = [{ type: "text", text: msg.content, cache_control: cacheTag }];
  } else if (Array.isArray(msg.content)) {
    for (let j = msg.content.length - 1; j >= 0; j--) {
      if (msg.content[j].type === "text") {
        msg.content[j] = { ...msg.content[j], cache_control: cacheTag };
        break;
      }
    }
  }
}

export function createXaiChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const model = getChatModel(input.modelId);
      // thinkingMode "off" with no explicit effort -> reasoning_effort "none":
      // grok-4.3 otherwise server-defaults to low reasoning, which the passive
      // "off" callers (workers/validators/HyDE) never asked to pay for.
      const rawEffort = model?.supportsEffort
        ? (mapXaiEffort(input.effort, model) ?? (input.thinkingMode === "off" ? "none" : undefined))
        : undefined;
      // Models without a non-reasoning mode (grok-4.5 — its catalog ladder has
      // no "minimal"/wire-"none" level) reject reasoning_effort "none" with a
      // live 400 (2026-07-12); clamp to the lowest legal effort instead.
      const effort = rawEffort === "none" && !model?.effortOptions?.includes("minimal")
        ? "low"
        : rawEffort;
      const response = await fetchImpl("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
          // Stable conversation key -> reliable prompt-cache affinity (xAI
          // docs: x-grok-conv-id on chat-completions).
          ...(input.conversationKey ? { "x-grok-conv-id": input.conversationKey } : {}),
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: "warning" }),
          })),
          max_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 4096),
          ...(input.temperature != null ? { temperature: input.temperature } : {}),
          ...(effort !== undefined ? { reasoning_effort: effort } : {}),
          stream_options: { include_usage: true },
          stream: true,
        }),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("xai", response, { secret: apiKey });
      }
      callbacks.onStart();
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
      let terminalReceived = false;
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") { terminalReceived = true; break; }
        const payload = safeJson(event.data) as {
          model?: string;
          choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string } }>;
          usage?: OpenAIChatWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (payload.model) servedModel = payload.model;
        if (payload.choices?.[0]?.finish_reason) stopReason = payload.choices[0].finish_reason ?? stopReason;
        if (payload.choices?.[0]?.finish_reason === "length") outputTruncated = true;
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        const reasoning = payload.choices?.[0]?.delta?.reasoning_content ?? "";
        if (reasoning) callbacks.onThinkingDelta(reasoning);
        if (payload.usage) usage = buildChatCompletionsUsage(payload.usage);
      }
      requireStreamTerminal(terminalReceived || stopReason != null, "Chat completions");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

export function createDeepSeekChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      // The effort ladder rides only while thinking runs; the toggle owns on and off
      // (thinking disabled plus an effort ran no reasoning, measured 2026-10-01).
      const effort = getChatModel(input.modelId)?.supportsEffort && input.thinkingMode !== "off" ? mapDeepSeekEffort(input.effort) : undefined;
      const response = await fetchImpl("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          messages: buildDeepSeekMessages(input.systemPrompt, input.messages),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 8192),
          // V4 honors temperature in non-thinking mode and ignores it (no error)
          // in thinking mode — plain passthrough either way.
          ...(input.temperature != null ? { temperature: input.temperature } : {}),
          // V4 thinking toggle: server default is ENABLED when omitted, so "off"
          // must be sent explicitly as disabled.
          ...(input.thinkingMode === "off" ? { thinking: { type: "disabled" } }
            : input.thinkingMode ? { thinking: { type: "enabled" } }
            : {}),
          ...(effort ? { reasoning_effort: effort } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("deepseek", response, { secret: apiKey });
      }
      callbacks.onStart();
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
      let terminalReceived = false;
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") { terminalReceived = true; break; }
        const payload = safeJson(event.data) as {
          model?: string;
          choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
          usage?: OpenAIChatWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (payload.model) servedModel = payload.model;
        if (payload.choices?.[0]?.finish_reason) stopReason = payload.choices[0].finish_reason ?? stopReason;
        if (payload.choices?.[0]?.finish_reason === "length" || payload.choices?.[0]?.finish_reason === "insufficient_system_resource") outputTruncated = true;
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        const reasoning = payload.choices?.[0]?.delta?.reasoning_content
          ?? payload.choices?.[0]?.delta?.reasoning?.content
          ?? "";
        if (reasoning) callbacks.onThinkingDelta(reasoning);
        if (payload.usage) usage = buildChatCompletionsUsage(payload.usage);
      }
      requireStreamTerminal(terminalReceived || stopReason != null, "Chat completions");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

// Internal: shared by the OpenAI-direct and custom `chat-completions` runtimes (no external consumer).
function createOpenAICompatibleChatCompletionsRuntime(
  endpoint: Pick<CustomEndpointSummary, "baseUrl" | "apiKey" | "authHeader">,
  options: { includeStreamUsage?: boolean; pdfMode?: "native" | "warning"; errorLabel?: string; stripUpstreamErrors?: boolean; outputCapParam?: "max_tokens" | "max_completion_tokens" } = {},
  fetchImpl: typeof fetch = fetch,
): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const response = await fetchImpl(joinEndpointUrl(endpoint.baseUrl, "chat/completions"), {
        method: "POST",
        redirect: "error",
        headers: {
          ...buildAuthHeaders(endpoint.authHeader, endpoint.apiKey),
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: options.pdfMode ?? "warning" }),
          })),
          [options.outputCapParam ?? "max_tokens"]: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 4096),
          ...(input.temperature != null ? { temperature: input.temperature } : {}),
          ...(options.includeStreamUsage ? { stream_options: { include_usage: true } } : {}),
          stream: true,
        }),
      });
      if (!response.ok || !response.body) {
        // Custom endpoint sink: drop the upstream body so it can't be used as an
        // SSRF readback channel.
        throw await providerHttpError(options.stripUpstreamErrors ? "custom endpoint" : options.errorLabel ?? "request", response, {
          secret: endpoint.apiKey,
          stripBody: options.stripUpstreamErrors,
        });
      }
      callbacks.onStart();
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
      let terminalReceived = false;
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") { terminalReceived = true; break; }
        const payload = safeJson(event.data) as {
          model?: string;
          choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
          usage?: OpenAIChatWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (payload.model) servedModel = payload.model;
        if (payload.choices?.[0]?.finish_reason) stopReason = payload.choices[0].finish_reason ?? stopReason;
        if (payload.choices?.[0]?.finish_reason === "length") outputTruncated = true;
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        const reasoning = payload.choices?.[0]?.delta?.reasoning_content
          ?? payload.choices?.[0]?.delta?.reasoning?.content
          ?? "";
        if (reasoning) callbacks.onThinkingDelta(reasoning);
        if (payload.usage) usage = buildChatCompletionsUsage(payload.usage);
      }
      requireStreamTerminal(terminalReceived || stopReason != null, "Chat completions");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

export function createZaiChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const model = getChatModel(input.modelId);
      // Hybrid reasoning (glm-5.2): the thinking:{type} toggle owns on/off; a
      // granular reasoning_effort owns depth and is sent ONLY when the model opts
      // in (supportsEffort) and thinking is on. minimal/none -> omit so the server
      // uses its default. Models without supportsEffort (the other GLMs) never
      // send it, so their wire shape is byte-for-byte unchanged.
      // GLM-5.3 family: reasoning is MANDATORY (thinking.type only accepts
      // "enabled"; disabling 400s) — alwaysOn models never send "disabled" and
      // thinking-off callers land on effort "low" (the sanctioned near-off,
      // K3 pattern). Effort levels outside the model's documented rungs fold
      // DOWN to the nearest documented one (medium -> low on GLM-5.3), and a
      // level below the lowest rung lands ON the lowest rung (low/medium -> high
      // on GLM-5.2, whose ladder is high|max since 2026-10-01 — z.ai maps
      // low/medium to high itself; omitting the effort would run its default, max).
      const zaiAlwaysOn = Boolean(model?.thinkingAlwaysOn);
      const foldToModelRungs = (e: string | undefined): string | undefined => {
        const rungs = model?.effortOptions as readonly string[] | undefined;
        if (!e || !rungs?.length || rungs.includes(e)) return e;
        const rank = ["minimal", "low", "medium", "high", "xhigh", "max"];
        for (let i = rank.indexOf(e) - 1; i >= 0; i--) {
          if (rungs.includes(rank[i])) return rank[i];
        }
        return rank.find((r) => rungs.includes(r));
      };
      // Explicit effort wins (pipeline workers pass workerEffortFor's top rung
      // alongside their thinking-off convention); "low" is
      // only the NO-effort fallback for always-on models, mirroring the K3 branch.
      const effort = model?.supportsEffort && (zaiAlwaysOn || input.thinkingMode !== "off")
        ? foldToModelRungs(mapZaiEffort(input.effort) ?? (zaiAlwaysOn && input.thinkingMode === "off" ? "low" : undefined))
        : undefined;
      const response = await fetchImpl("https://api.z.ai/api/paas/v4/chat/completions", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "accept-language": "en-US,en",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: "warning" }),
          })),
          stream: true,
          stream_options: { include_usage: true },
          // No temperature for an entry without the dial (GLM-5.3 and Flash, measured 2026-10-01: z.ai ignores it while
          // they reason); every other GLM carries the caller's, default 1.
          ...(model?.supportsTemperature === false ? {} : { temperature: input.temperature ?? 1.0 }),
          max_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 4096),
          // {type:"disabled"} is legal first-party on every GLM (live-verified
          // 2026-06-12, zero reasoning tokens) — "off" now genuinely disables.
          // Omitted/enabled/adaptive all map to enabled (the server default).
          thinking: { type: !zaiAlwaysOn && input.thinkingMode === "off" ? "disabled" : "enabled" },
          ...(effort !== undefined ? { reasoning_effort: effort } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("zai", response, { secret: apiKey });
      }
      callbacks.onStart();
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
      let terminalReceived = false;
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") { terminalReceived = true; break; }
        const payload = safeJson(event.data) as {
          model?: string;
          choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
          usage?: OpenAIChatWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (payload.model) servedModel = payload.model;
        if (payload.choices?.[0]?.finish_reason) stopReason = payload.choices[0].finish_reason ?? stopReason;
        if (payload.choices?.[0]?.finish_reason === "length") outputTruncated = true;
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        const reasoning = payload.choices?.[0]?.delta?.reasoning_content
          ?? payload.choices?.[0]?.delta?.reasoning?.content
          ?? "";
        if (reasoning) callbacks.onThinkingDelta(reasoning);
        if (payload.usage) usage = buildChatCompletionsUsage(payload.usage);
      }
      requireStreamTerminal(terminalReceived || stopReason != null, "Chat completions");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

// Xiaomi MiMo — OpenAI-compatible chat-completions with a z.ai-style
// `thinking:{type}` object. MiMo's thinking is a plain on/off toggle:
// {type:"enabled"} (also the API default when omitted) and {type:"disabled"}.
// The API also accepts "adaptive", but the catalog exposes MiMo as a simple
// toggle (supportsToggleThinking), so any on-state maps to "enabled" here.
// Reasoning streams back in delta.reasoning_content. Verified against the live
// first-party API (2026-06-12): multi-turn thinking-on works WITHOUT echoing
// prior reasoning_content back, so no reasoning replay is needed — the earlier
// "must be passed back" error was a third-party proxy quirk, not first-party.
export function createXiaomiChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const thinkingType = input.thinkingMode === "off" ? "disabled"
        : (input.thinkingMode === "enabled" || input.thinkingMode === "adaptive") ? "enabled"
        : null;
      const response = await fetchImpl("https://api.xiaomimimo.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: "warning" }),
          })),
          stream: true,
          stream_options: { include_usage: true },
          temperature: input.temperature ?? 1.0,
          max_completion_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 8192),
          ...(thinkingType ? { thinking: { type: thinkingType } } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("xiaomi", response, { secret: apiKey });
      }
      callbacks.onStart();
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
      let terminalReceived = false;
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") { terminalReceived = true; break; }
        const payload = safeJson(event.data) as {
          model?: string;
          choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
          usage?: OpenAIChatWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (payload.model) servedModel = payload.model;
        if (payload.choices?.[0]?.finish_reason) stopReason = payload.choices[0].finish_reason ?? stopReason;
        if (payload.choices?.[0]?.finish_reason === "length") outputTruncated = true;
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        const reasoning = payload.choices?.[0]?.delta?.reasoning_content
          ?? payload.choices?.[0]?.delta?.reasoning?.content
          ?? "";
        if (reasoning) callbacks.onThinkingDelta(reasoning);
        if (payload.usage) usage = buildChatCompletionsUsage(payload.usage);
      }
      requireStreamTerminal(terminalReceived || stopReason != null, "Chat completions");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

// Moonshot AI (Kimi) — OpenAI-compatible chat-completions at api.moonshot.ai/v1
// with a z.ai-style thinking:{type:"enabled"|"disabled"} toggle (server default
// enabled; live-verified on kimi-k2.6 2026-07-12). Reasoning streams
// in delta.reasoning_content; usage is the standard subset shape handled by
// buildChatCompletionsUsage. Quirks (all live-verified 2026-07-12): temperature
// is hard-capped at 1 upstream ("invalid temperature: only 1 is allowed" above
// it) so we clamp rather than 400; unset max tokens defaults to ~1024 upstream
// so max_completion_tokens is always sent; prompt_cache_key (conversationKey)
// improves automatic-context-cache affinity (1057/1057 cached on repeat).
export function createMoonshotChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      // K3 (thinkingAlwaysOn) diverges from the K2.x toggle contract — all
      // live-verified 2026-07-21: reasoning is always on and governed by the
      // reasoning_effort ladder (low|high|max; catalog-external levels fold to
      // documented rungs, thinking-off callers land on "low" — the sanctioned
      // near-off); the K2.x thinking:{type} param is disavowed for K3 and never
      // sent; temperature is OMITTED entirely (fixed at 1 upstream — any other
      // value is a live 400, so the K2.x clamp path would break sub-1 dials).
      const model = getChatModel(input.modelId);
      const alwaysOn = Boolean(model?.thinkingAlwaysOn);
      const thinkingType = alwaysOn ? null
        : input.thinkingMode === "off" ? "disabled"
        : (input.thinkingMode === "enabled" || input.thinkingMode === "adaptive") ? "enabled"
        : null;
      const effort = alwaysOn && model?.supportsEffort
        ? (mapMoonshotEffort(input.effort) ?? (input.thinkingMode === "off" ? "low" : "max"))
        : undefined;
      const response = await fetchImpl("https://api.moonshot.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: "warning" }),
          })),
          stream: true,
          stream_options: { include_usage: true },
          ...(model?.supportsTemperature === false ? {} : { temperature: Math.min(input.temperature ?? 1.0, 1) }),
          max_completion_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 8192),
          ...(effort !== undefined ? { reasoning_effort: effort } : {}),
          ...(thinkingType ? { thinking: { type: thinkingType } } : {}),
          ...(input.conversationKey ? { prompt_cache_key: input.conversationKey } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("moonshot", response, { secret: apiKey });
      }
      callbacks.onStart();
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
      let terminalReceived = false;
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") { terminalReceived = true; break; }
        const payload = safeJson(event.data) as {
          model?: string;
          choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string } }>;
          usage?: OpenAIChatWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (payload.model) servedModel = payload.model;
        if (payload.choices?.[0]?.finish_reason) stopReason = payload.choices[0].finish_reason ?? stopReason;
        if (payload.choices?.[0]?.finish_reason === "length") outputTruncated = true;
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        const reasoning = payload.choices?.[0]?.delta?.reasoning_content ?? "";
        if (reasoning) callbacks.onThinkingDelta(reasoning);
        if (payload.usage) usage = buildChatCompletionsUsage(payload.usage);
      }
      requireStreamTerminal(terminalReceived || stopReason != null, "Chat completions");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

// Fireworks AI (Kimi, Western-hosted) — OpenAI-compatible chat-completions at
// api.fireworks.ai/inference/v1. Kimi is a reasoning model exposed via a
// reasoning_effort ladder (low|medium|high; no true "off" — the catalog ladder
// has no "minimal"/none level, so a thinking-off request clamps to the lowest
// rung). Reasoning streams in delta.reasoning_content (Fireworks abstracts Kimi's
// internal <think> blocks into that field). Catalog id -> wire id lives in the
// model-catalog WIRE_MODEL_OVERRIDES (single source, shared with the client
// served-model compare) — add K3 there the moment its Fireworks id is live.
// Automatic prompt caching, no cache key.
//
// A served-model echo in the provider's own wire vocabulary (the exact wire id,
// or its repo basename — GMICloud reports "mimo-v2.5-pro" for
// "XiaomiMiMo/MiMo-V2.5-Pro") is "served exactly what was requested": normalize
// it back to the catalog id so the transparency badge only flags REAL
// substitutions. A router wire id (Fireworks kimi-k3-fast) echoes the model it
// routed to; the catalog's WIRE_SERVED_EQUIVALENTS lists those expected echoes.
// Anything else passes through untouched.
function normalizeWireServedModel(served: string | null, wireModel: string, catalogId: string): string | null {
  if (!served) return served;
  const s = served.toLowerCase();
  const w = wireModel.toLowerCase();
  if (s === w || s === (w.split("/").pop() ?? w)) return catalogId;
  if (WIRE_SERVED_EQUIVALENTS[catalogId]?.some((alias) => alias.toLowerCase() === s)) return catalogId;
  return served;
}
// Fireworks hosts two Kimi effort contracts, keyed by the catalog ladder:
// K3-class (`kimi-k3-fireworks`, low|high|max — "max" is the session default)
// shares Moonshot's documented-rung fold, so `max` reaches the wire instead of
// being silently downgraded to "high"; K2.6-class (low|medium|high) keeps the
// original fold — high|xhigh|max top out at "high", none|minimal floor at "low".
function mapFireworksEffort(effort: SessionEffort | null | undefined, model: ReturnType<typeof getChatModel>): string | undefined {
  if (!effort) return undefined;
  if (model?.effortOptions?.includes("max")) return mapMoonshotEffort(effort);
  if (effort === "none" || effort === "minimal" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}
export function createFireworksChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const model = getChatModel(input.modelId);
      const wireModel = wireChatModelId(input.modelId);
      // No true "off"/"none" rung on the Kimi effort ladder — a thinking-off
      // request with no explicit effort lands on the lowest legal level.
      const effort = model?.supportsEffort
        ? (mapFireworksEffort(input.effort, model) ?? (input.thinkingMode === "off" ? "low" : undefined))
        : undefined;
      const response = await fetchImpl("https://api.fireworks.ai/inference/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: wireModel,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: "warning" }),
          })),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 8192),
          // Kimi K3 has no dial (sampling fixed upstream; the catalog hides it): never forward a caller's value, a
          // worker's 0 included. K2.6 keeps the caller's temperature.
          ...(model?.supportsTemperature !== false && input.temperature != null ? { temperature: input.temperature } : {}),
          ...(effort !== undefined ? { reasoning_effort: effort } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("fireworks", response, { secret: apiKey });
      }
      callbacks.onStart();
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
      let terminalReceived = false;
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") { terminalReceived = true; break; }
        const payload = safeJson(event.data) as {
          model?: string;
          choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string } }>;
          usage?: OpenAIChatWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (payload.model) servedModel = payload.model;
        if (payload.choices?.[0]?.finish_reason) stopReason = payload.choices[0].finish_reason ?? stopReason;
        if (payload.choices?.[0]?.finish_reason === "length") outputTruncated = true;
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        const reasoning = payload.choices?.[0]?.delta?.reasoning_content ?? "";
        if (reasoning) callbacks.onThinkingDelta(reasoning);
        if (payload.usage) usage = buildChatCompletionsUsage(payload.usage);
      }
      requireStreamTerminal(terminalReceived || stopReason != null, "Chat completions");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel: normalizeWireServedModel(servedModel, wireModel, input.modelId) });
    },
  };
}

// GMICloud (Xiaomi MiMo, Western-hosted) — OpenAI-compatible chat-completions at
// api.gmi-serving.com/v1. MiMo reasons by DEFAULT and streams it in
// delta.reasoning_content. Thinking control is the vLLM/SGLang chat-template
// kwarg (enable_thinking), NOT MiMo's native thinking:{type} param — the gateway
// rejects the latter with a 422 "cursor_claude" misroute (live-verified
// 2026-07-19), so we only send chat_template_kwargs.enable_thinking:false to turn
// reasoning OFF and leave the default (on) as a plain request. Catalog id -> wire
// id is an explicit map (GMICloud uses the HuggingFace repo form); requests use
// max_tokens.
export function createGMICloudChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const wireModel = wireChatModelId(input.modelId);
      const response = await fetchImpl("https://api.gmi-serving.com/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, input.streamTimeoutMs ?? CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: wireModel,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: "warning" }),
          })),
          stream: true,
          stream_options: { include_usage: true },
          temperature: input.temperature ?? 1.0,
          max_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 8192),
          ...(input.thinkingMode === "off" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        throw await providerHttpError("gmicloud", response, { secret: apiKey });
      }
      callbacks.onStart();
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
      let terminalReceived = false;
      for await (const event of readSseEvents(response.body)) {
        if (event.data === "[DONE]") { terminalReceived = true; break; }
        const payload = safeJson(event.data) as {
          model?: string;
          choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
          usage?: OpenAIChatWireUsage;
          error?: { message?: string };
        };
        if (payload.error?.message) throw new Error(payload.error.message);
        if (payload.model) servedModel = payload.model;
        if (payload.choices?.[0]?.finish_reason) stopReason = payload.choices[0].finish_reason ?? stopReason;
        if (payload.choices?.[0]?.finish_reason === "length") outputTruncated = true;
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) callbacks.onDelta(delta);
        const reasoning = payload.choices?.[0]?.delta?.reasoning_content
          ?? payload.choices?.[0]?.delta?.reasoning?.content
          ?? "";
        if (reasoning) callbacks.onThinkingDelta(reasoning);
        if (payload.usage) usage = buildChatCompletionsUsage(payload.usage);
      }
      requireStreamTerminal(terminalReceived || stopReason != null, "Chat completions");
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel: normalizeWireServedModel(servedModel, wireModel, input.modelId) });
    },
  };
}

// Internal: reached through createChatRuntimeWithCustomEndpoints (no external consumer).
function createCustomEndpointRuntime(endpoint: Pick<CustomEndpointSummary, "baseUrl" | "apiKey" | "apiFormat" | "authHeader">, fetchImpl: typeof fetch = fetch) {
  // Custom endpoints get error-body stripping -- upstream bodies are untrusted and could be used
  // as an SSRF readback channel against internal services that pass the URL gate but return sensitive
  // error text.
  return endpoint.apiFormat === "responses"
    ? createOpenAICompatibleResponsesRuntime(endpoint, fetchImpl, { stripUpstreamErrors: true })
    : createOpenAICompatibleChatCompletionsRuntime(endpoint, { stripUpstreamErrors: true }, fetchImpl);
}

/**
 * The `-bridge` models through the subscription runner: the same Anthropic
 * Messages dialect the earlier external bridge spoke, now addressed to the runner with the
 * user's id so the turn runs under that user's own Claude sign-in.
 */
export function createClaudeSubscriptionRuntime(input: { runnerUrl: string; runnerSecret: string; userId: string }, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return createAnthropicMessagesRuntimeWithEndpoint({
    url: input.runnerUrl.replace(/\/$/, "") + "/v1/messages",
    authMode: "Bearer",
    apiKey: input.runnerSecret,
    forceCacheTtl1h: true,
    alwaysSendEffort: true,
    mapModelId: (id) => id.endsWith("-bridge") ? id.slice(0, -"-bridge".length) : id,
    extraHeaders: { "x-rp-user-id": input.userId },
  }, fetchImpl);
}

// Shown as sent by the web and the Android app, whose menus differ (Options on the web, Settings in
// the app), so the message names only the Providers section both have.
export const SUBSCRIPTION_NOT_CONNECTED_MESSAGES = {
  "claude-code": "Claude subscription is not connected. Connect it under Providers.",
  "codex-bridge": "ChatGPT subscription is not connected. Connect it under Providers.",
} as const;

export function createRegistryChatRuntime(input: {
  anthropicApiKey?: string;
  claudeCodeRuntime?: ChatRuntime | null;
  codexBridgeRuntime?: ChatRuntime | null;
  deepseekApiKey?: string;
  fireworksApiKey?: string;
  gmicloudApiKey?: string;
  googleApiKey?: string;
  moonshotApiKey?: string;
  openaiApiKey?: string;
  xaiApiKey?: string;
  xiaomiApiKey?: string;
  zaiApiKey?: string;
  fetchImpl?: typeof fetch;
}): ChatRuntime | null {
  const openaiResponses = input.openaiApiKey ? createOpenAIResponsesRuntime(input.openaiApiKey, input.fetchImpl) : null;
  const openaiChatCompletions = input.openaiApiKey ? createOpenAIChatCompletionsRuntime(input.openaiApiKey, input.fetchImpl) : null;
  const claudeCodeRuntime = input.claudeCodeRuntime ?? null;
  const runtimes = {
    anthropic: input.anthropicApiKey ? createAnthropicMessagesRuntime(input.anthropicApiKey, input.fetchImpl) : null,
    "claude-code": claudeCodeRuntime,
    "codex-bridge": input.codexBridgeRuntime ?? null,
    deepseek: input.deepseekApiKey ? createDeepSeekChatCompletionsRuntime(input.deepseekApiKey, input.fetchImpl) : null,
    fireworks: input.fireworksApiKey ? createFireworksChatCompletionsRuntime(input.fireworksApiKey, input.fetchImpl) : null,
    gmicloud: input.gmicloudApiKey ? createGMICloudChatCompletionsRuntime(input.gmicloudApiKey, input.fetchImpl) : null,
    google: input.googleApiKey ? createGoogleGeminiRuntime(input.googleApiKey, input.fetchImpl) : null,
    moonshot: input.moonshotApiKey ? createMoonshotChatCompletionsRuntime(input.moonshotApiKey, input.fetchImpl) : null,
    xai: input.xaiApiKey ? createXaiChatCompletionsRuntime(input.xaiApiKey, input.fetchImpl) : null,
    xiaomi: input.xiaomiApiKey ? createXiaomiChatCompletionsRuntime(input.xiaomiApiKey, input.fetchImpl) : null,
    zai: input.zaiApiKey ? createZaiChatCompletionsRuntime(input.zaiApiKey, input.fetchImpl) : null,
  } as const;
  if (!runtimes.anthropic && !runtimes["claude-code"] && !runtimes["codex-bridge"] && !runtimes.deepseek && !runtimes.fireworks && !runtimes.gmicloud && !runtimes.google && !runtimes.moonshot && !openaiResponses && !openaiChatCompletions && !runtimes.xai && !runtimes.xiaomi && !runtimes.zai) return null;
  return {
    async streamChat(payload, callbacks) {
      const model = getChatModel(payload.modelId);
      if (!model) throw new Error("unsupported model");
      const runtime = model.provider === "openai"
        ? (model.supportsEffort ? openaiResponses : openaiChatCompletions)
        : runtimes[model.provider];
      if (!runtime) {
        if (model.provider === "claude-code" || model.provider === "codex-bridge") throw new Error(SUBSCRIPTION_NOT_CONNECTED_MESSAGES[model.provider]);
        throw new Error(`${model.provider} runtime is not configured`);
      }
      await runtime.streamChat(payload, callbacks);
    },
  };
}

export function createChatRuntimeWithCustomEndpoints(
  runtime: ChatRuntime | null,
  endpoints: CustomEndpointSummary[],
  fetchImpl: typeof fetch = fetch,
): ChatRuntime | null {
  if (!runtime && endpoints.length === 0) return null;
  return {
    async streamChat(payload, callbacks) {
      const builtInModel = getChatModel(payload.modelId);
      if (builtInModel) {
        if (!runtime) throw new Error(`${builtInModel.provider} runtime is not configured`);
        await runtime.streamChat(payload, callbacks);
        return;
      }
      const parsed = parseCustomChatModelId(payload.modelId);
      if (!parsed) throw new Error("unsupported model");
      const endpoint = endpoints.find((entry) => entry.id === parsed.endpointId);
      if (!endpoint) throw new Error("custom endpoint not found");
      const model = buildCustomChatModels([endpoint]).find((entry) => entry.id === payload.modelId);
      if (!model) throw new Error("custom endpoint model not found");
      const customRuntime = createCustomEndpointRuntime(endpoint, fetchImpl);
      await customRuntime.streamChat({ ...payload, modelId: model.actualModelId, maxOutputTokens: model.maxOut }, callbacks);
    },
  };
}

// The four image factories below are internal — callers go through
// createRegistryImageRuntime (no external consumer imports them by name).
function createOpenAIImageGenerationRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ImageGenerationRuntime {
  return {
    async generateImage(input) {
      const response = await fetchImpl("https://api.openai.com/v1/images/generations", {
        method: "POST",
        signal: withTimeout(input.signal, IMAGE_TIMEOUT_MS),
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          size: "1536x1024",
          // The catalog names a model's own setting (GPT Image 2.5: "max"); "high" is
          // GPT Image 2's top.
          quality: getImageModel(input.modelId)?.quality ?? "high",
        }),
      });
      if (!response.ok) {
        throw await providerHttpError("openai image", response, { secret: apiKey });
      }
      const payload = await response.json() as { data?: Array<{ b64_json?: string }> };
      const b64 = payload.data?.[0]?.b64_json;
      if (!b64) throw new Error("openai image response missing image payload");
      return {
        mimeType: "image/png",
        bytes: base64ToBytes(b64),
      };
    },
  };
}

/**
 * Read an upstream error response body capped at `maxBytes` so a misbehaving
 * upstream can't pin RAM with a multi-MB error page. Cancels the reader on the
 * way out either way.
 */
async function readBoundedErrorBody(response: Response, maxBytes = 16_384): Promise<string> {
  if (!response.body) {
    try { return (await response.text()).slice(0, maxBytes); } catch { return ""; }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        parts.push(decoder.decode(value, { stream: true }));
        total += value.length;
      }
    }
    parts.push(decoder.decode());
  } catch { /* whatever we have is fine */ }
  try { await reader.cancel(); } catch { /* already closed */ }
  return parts.join("").slice(0, maxBytes);
}

/**
 * Non-OK upstream response. Carries the HTTP status STRUCTURALLY (`status`) so
 * the worker retry/resume classifier (retryHelper.isTransientApiError /
 * isResumableError) can key on 429/5xx instead of on body wording — before this,
 * the status only reached the message when the body was EMPTY, so an OpenAI 500
 * ("The server had an error…"), a 502 gateway page, or a 429 whose body said
 * only "Too many concurrent requests" all read as terminal. The message keeps
 * the upstream body (the UI's inline error card shows it) behind a
 * `<provider> request failed with <status>` prefix.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly body: string;
  constructor(provider: string, status: number, body: string) {
    super(body ? `${provider} request failed with ${status}: ${body}` : `${provider} request failed with ${status}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.provider = provider;
    this.body = body;
  }
}

/** The upstream HTTP status behind an error thrown by a runtime, or null when
 *  the error is not a non-OK upstream response (network failure, abort, an
 *  in-band SSE error payload, …). The classification hook for retryHelper. */
export function getProviderHttpStatus(error: unknown): number | null {
  return error instanceof ProviderHttpError ? error.status : null;
}

// Build the ProviderHttpError for a non-OK response: read the (bounded) body,
// drop it entirely for custom endpoints (`stripBody` — untrusted upstreams must
// not get an SSRF readback channel), and redact the API key should a proxy
// echo the request headers back in its error page (keys travel in headers
// only, so this is defense in depth, not a known leak).
async function providerHttpError(
  provider: string,
  response: Response,
  options: { secret?: string; stripBody?: boolean } = {},
): Promise<ProviderHttpError> {
  const raw = await readBoundedErrorBody(response);
  const body = options.stripBody ? "" : redactSecret(raw, options.secret).trim();
  return new ProviderHttpError(provider, response.status, body);
}

function redactSecret(text: string, secret: string | undefined): string {
  const needle = secret?.trim();
  if (!needle || needle.length < 8 || !text.includes(needle)) return text;
  return text.split(needle).join("[redacted]");
}

function abortError() {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}

function joinEndpointUrl(baseUrl: string, suffix: string) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/${suffix}`;
}

function buildAuthHeaders(authHeader: CustomEndpointSummary["authHeader"], apiKey: string) {
  const headers: Record<string, string> = {};
  if (authHeader === "Bearer" && apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  if (authHeader === "api-key" && apiKey.trim()) headers["api-key"] = apiKey.trim();
  return headers;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function splitAnthropicSystemPromptSections(systemPrompt: string) {
  const SECTION_DELIMITER = "\n\n<<<TR_SEC>>>\n\n";
  return systemPrompt.includes(SECTION_DELIMITER)
    ? systemPrompt.split(SECTION_DELIMITER).filter(Boolean)
    : systemPrompt.includes("\n\n---\n\n")
      ? systemPrompt.split("\n\n---\n\n").filter(Boolean)
      : [systemPrompt];
}

// Session effort -> the model's catalog ladder. Shared by the OpenAI-Responses,
// Gemini and xAI mappers (z.ai / Moonshot carry their own documented-rung
// folds). An exact rung passes through; a level ABOVE the ladder folds DOWN to
// the nearest rung the model lists (max -> xhigh on gpt-5.5, -> high on Gemini
// 3.x); a level BELOW the floor folds UP to the floor (minimal -> low on 3.7
// Flash / 3.1 Pro where minimal is a live 400; none -> minimal on 3.5 Flash;
// minimal -> none on gpt-5.1+, whose no-reasoning tier is spelled "none"). A
// stale session value (effort saved under a previous model, an Android PATCH)
// therefore never reaches the wire as an illegal level. No ladder = pass-through.
const EFFORT_LADDER: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
// Exported for the API-owned CodexBridge runtime, which used to fold an
// out-of-ladder session effort UP to the catalog default.
export function foldEffortToLadder(effort: SessionEffort, rungs: readonly string[] | undefined): string {
  if (!rungs?.length || rungs.includes(effort)) return effort;
  const rank = EFFORT_LADDER.indexOf(effort);
  for (let i = rank - 1; i >= 0; i--) if (rungs.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
  for (let i = rank + 1; i < EFFORT_LADDER.length; i++) if (rungs.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
  return effort;
}

function mapOpenaiEffort(effort: SessionEffort, model?: ReturnType<typeof getChatModel>) {
  // Fold onto the catalog ladder: "max" exists upstream only on the GPT-5.6
  // family (-> xhigh elsewhere), "minimal" is the v1-era GPT-5 spelling of the
  // no-reasoning tier that 5.1+ call "none". Without a ladder keep the one
  // guard that was always here (max -> high).
  if (!model?.effortOptions?.length) return effort === "max" ? "high" : effort;
  return foldEffortToLadder(effort, model.effortOptions);
}

// Responses-API effort resolution: explicit session effort wins; otherwise
// thinkingMode "off" maps to "none" on models that support it (5.5/5.4/5.1) so
// passive "off" callers get true non-reasoning; else the API default "high".
function resolveOpenAIResponsesEffort(
  model: ReturnType<typeof getChatModel>,
  effort: SessionEffort | null | undefined,
  thinkingMode: SessionThinkingMode | null | undefined,
) {
  if (effort) return mapOpenaiEffort(effort, model);
  // Thinking-off with no explicit effort: "none" where the ladder has it
  // (5.6/5.5/5.4/5.1); on an always-reasoning ladder (gpt-6-astra — "none" is
  // a live 400) fold to the model's FLOOR, the same convention as Gemini 3.x's
  // thinking-off — the old "high" fallback silently maxed out reasoning for a
  // caller that asked for none (2026-09-05).
  if (thinkingMode === "off") {
    if (model?.effortOptions?.includes("none")) return "none";
    if (model?.effortOptions?.length) return foldEffortToLadder("none", model.effortOptions);
  }
  return "high";
}

type OpenAIResponsesWireUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

type OpenAIResponsesRefusalPart = { type?: string; refusal?: string };
type OpenAIResponsesTerminalPayload = {
  response?: {
    usage?: OpenAIResponsesWireUsage;
    incomplete_details?: { reason?: string };
    service_tier?: string;
    model?: string;
    // The completed response echoes its output items; a refused turn carries a
    // `refusal` content part here even when the adapter skipped the
    // `response.refusal.*` events.
    output?: Array<{ type?: string; content?: OpenAIResponsesRefusalPart[] }>;
  };
  usage?: OpenAIResponsesWireUsage;
  service_tier?: string;
  model?: string;
};

// The `refusal` text of a Responses output item's content, if any.
function findResponsesRefusalPart(content: OpenAIResponsesRefusalPart[] | undefined): string | null {
  const part = content?.find((entry) => entry?.type === "refusal" && typeof entry.refusal === "string" && entry.refusal.length > 0);
  return part?.refusal ?? null;
}

function buildOpenAIResponsesUsage(u: OpenAIResponsesWireUsage | undefined): ChatUsage {
  const cached = u?.input_tokens_details?.cached_tokens ?? null;
  const prompt = u?.input_tokens ?? null;
  const { inputTokens, cacheReadTokens } = normalizeSubsetCacheUsage(prompt, cached);
  // GPT-5.6+ bills cache writes at 1.25x input and reports them in
  // input_tokens_details.cache_write_tokens (live-verified 2026-07-12).
  // Treated as a subset of input_tokens like cached_tokens — carved out so the
  // disjoint-usage invariant holds (inputTokens = uncached, unwritten prompt).
  const written = u?.input_tokens_details?.cache_write_tokens ?? null;
  const cacheWriteTokens = written != null && written > 0 ? written : null;
  return {
    inputTokens: inputTokens != null && cacheWriteTokens != null
      ? Math.max(0, inputTokens - cacheWriteTokens)
      : inputTokens,
    outputTokens: u?.output_tokens ?? null,
    totalTokens: u?.total_tokens ?? null,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? null,
    speed: null,
  };
}

// OpenAI / Gemini / xAI / DeepSeek / z.ai / Xiaomi all report cached
// tokens as a SUBSET of prompt_tokens (cached_tokens ⊆ prompt_tokens), whereas
// Anthropic reports cache_read_input_tokens DISJOINT from input_tokens. The
// downstream cost calc assumes the Anthropic (disjoint) convention everywhere —
// inputTokens billed at full rate + cacheReadTokens billed at the cache rate —
// so feeding it subset-semantics usage double-bills the cached portion. Subtract
// the cached portion out of inputTokens here so the runtime boundary always
// emits Anthropic-style DISJOINT usage: inputTokens = UNCACHED prompt tokens,
// cacheReadTokens = the cached portion. The ChatUsage invariant downstream is
// therefore: inputTokens and cacheReadTokens are non-overlapping, always.
function normalizeSubsetCacheUsage(
  promptTokens: number | null,
  cachedTokens: number | null,
): { inputTokens: number | null; cacheReadTokens: number | null } {
  if (cachedTokens == null) return { inputTokens: promptTokens, cacheReadTokens: null };
  if (promptTokens == null) return { inputTokens: null, cacheReadTokens: cachedTokens };
  // Clamp defensively: never let a malformed cached>prompt produce a negative.
  const cached = Math.min(cachedTokens, promptTokens);
  return { inputTokens: promptTokens - cached, cacheReadTokens: cached };
}

type OpenAIChatWireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

// Shared OpenAI-compatible chat-completions usage normalizer for xAI / DeepSeek /
// z.ai / Xiaomi / OpenAI / custom endpoints. All of them report cached tokens as
// a SUBSET of prompt_tokens, so the subset→disjoint normalization applies
// uniformly. DeepSeek additionally exposes prompt_cache_hit_tokens as an alias.
function buildChatCompletionsUsage(u: OpenAIChatWireUsage | undefined): ChatUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? null;
  const { inputTokens, cacheReadTokens } = normalizeSubsetCacheUsage(u?.prompt_tokens ?? null, cached);
  return {
    inputTokens,
    outputTokens: u?.completion_tokens ?? null,
    totalTokens: u?.total_tokens ?? null,
    cacheReadTokens,
    cacheWriteTokens: null,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? null,
    speed: null,
  };
}

type AnthropicWireUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  speed?: string;
};

// Kimi K3 reasoning_effort: the documented ladder is low|high|max (no medium —
// the wire ACCEPTS "medium" but its semantics are undocumented and it behaved
// ≈low in the 2026-07-21 probe, so catalog-external levels fold to documented
// rungs instead: none/minimal→low, medium→high, xhigh→max).
function mapMoonshotEffort(effort: SessionEffort | null | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === "none" || effort === "minimal" || effort === "low") return "low";
  if (effort === "medium" || effort === "high") return "high";
  return "max";
}

// DeepSeek reasoning_effort (V4 Pro, V4.1 Flash): the documented ladder is low|high|max.
// DeepSeek folds other levels itself (minimal->low, medium->high, xhigh->high, per its
// thinking-mode guide); this sends the rung it would run, so the Effort select can name it.
// "none" would turn thinking off, which is the toggle's job, so it folds up to low.
function mapDeepSeekEffort(effort: SessionEffort | null | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === "none" || effort === "minimal" || effort === "low") return "low";
  return effort === "max" ? "max" : "high";
}

// xAI reasoning_effort. The catalog spells xAI's non-reasoning tier "minimal"
// (wire value "none" — grok-4.3 only); everything else is the wire vocabulary.
// Fold onto the model's ladder FIRST so grok-4.6's xhigh (its catalog default)
// reaches the wire — the old unconditional xhigh|max -> high fold silently
// downgraded every 4.6 turn — while max still lands on each model's top rung
// and none/minimal on its floor (low on 4.5/4.6, which 400 on wire "none").
function mapXaiEffort(effort: SessionEffort | null | undefined, model?: ReturnType<typeof getChatModel>): string | undefined {
  if (!effort) return undefined;
  const folded = model?.effortOptions?.length
    ? foldEffortToLadder(effort, model.effortOptions)
    : effort === "xhigh" || effort === "max" ? "high" : effort;
  return folded === "minimal" ? "none" : folded;
}

// GLM-5.2 reasoning_effort. z.ai accepts minimal|low|medium|high|max (live-verified
// 2026-06-18). We never surface "minimal" (it produces zero reasoning even with
// thinking enabled), and "xhigh" is not a z.ai level, so fold it to "high". "none"
// is omitted so the server uses its default. low/medium/high/max pass through.
function mapZaiEffort(effort: SessionEffort | null | undefined): string | undefined {
  if (!effort || effort === "none") return undefined;
  if (effort === "xhigh") return "high";
  return effort;
}

function mapAnthropicEffort(effort: SessionEffort) {
  return effort;
}

// Ladder order for the thinking-off clamp below. Matches the EffortLevel union;
// unknown values rank 0 (never clamped upward).
const ANTHROPIC_EFFORT_RANK: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

// Opus 5 family: {type:"disabled"} thinking is rejected above thinkingOffMaxEffort
// ("high" — disabled + xhigh/max is a live 400). Clamp rather than error so a
// session that saved effort "max" and then flips thinking Off still sends a legal
// request; the composer mirrors the same cap in the effort picker.
function clampEffortForDisabledThinking(
  effort: ReturnType<typeof resolveAnthropicEffort>,
  model: ReturnType<typeof getChatModel>,
  thinkingOff: boolean,
) {
  const cap = model?.thinkingOffMaxEffort;
  if (!thinkingOff || !cap || !effort) return effort;
  return (ANTHROPIC_EFFORT_RANK[effort] ?? 0) > (ANTHROPIC_EFFORT_RANK[cap] ?? 0) ? cap : effort;
}

function resolveAnthropicEffort(model: ReturnType<typeof getChatModel>, effort: SessionEffort | null | undefined) {
  if (!effort) return null;
  // A catalog entry WITHOUT effort support (claude-haiku-4-5 direct and bridge:
  // budget thinking, no effort) never puts
  // output_config.effort on the wire — bridge (alwaysSendEffort) and direct
  // alike. After 2026-09-22 the workers' "max" fallback on a
  // Haiku-bridge run reached the bridge as {effort:"high"}; the chain ignores
  // it, but the contract says it is never sent. An UNKNOWN model (no entry)
  // keeps the pass-through below.
  if (model && !model.supportsEffort) return null;
  const mapped = mapAnthropicEffort(effort);
  // NB: effortOptions is the UI-exposed set, NOT the full API-accepted set —
  // Anthropic still accepts e.g. "minimal" even on models that don't surface it
  // in the picker (see the "preserves minimal effort" test). So we only guard
  // the one level that genuinely 400s where unsupported ("max"); clamping the
  // rest against effortOptions would wrongly downgrade valid values. The LOW-tail
  // effort-clamp idea was dropped here for that reason.
  if (mapped === "max" && !model?.effortOptions?.includes("max")) return "high";
  return mapped;
}

// Gemini 3.x thinkingLevel accepts only minimal|low|medium|high (and minimal
// is a live 400 on 3.1 Pro / 3.7 Flash) — fold onto the model's ladder so
// xhigh/max land on "high" and none/minimal on the model's legal floor.
function mapGeminiThinkingLevel(effort: SessionEffort | null | undefined, model: ReturnType<typeof getChatModel>) {
  if (!effort) return "high";
  return foldEffortToLadder(effort, model?.effortOptions?.length ? model.effortOptions : ["low", "medium", "high"]);
}

function buildGeminiGenerationConfig(
  model: ReturnType<typeof getChatModel>,
  input: {
    modelId: string;
    maxOutputTokens?: number | null;
    temperature?: number | null;
    thinkingMode?: SessionThinkingMode | null;
    thinkingBudget?: number | null;
    effort?: SessionEffort | null;
  },
) {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 65536),
  };
  // Always-on models (2.5 Pro): thinking cannot be disabled — request dynamic
  // thinking with visible thoughts regardless of mode, honor the temperature.
  if (model?.thinkingAlwaysOn) {
    generationConfig.thinkingConfig = { includeThoughts: true };
    if (input.temperature != null) generationConfig.temperature = input.temperature;
    return generationConfig;
  }
  if (model?.supportsEffort) {
    // No temperature at all for a 3.x entry without the dial (the five 3.x Flash
    // models: measured 2026-10-01 to ignore it even at the lowest level; Google
    // deprecated it for 3.x and recommends the default 1.0). 3.1 Pro keeps both
    // branches below.
    const sendsTemperature = model.supportsTemperature !== false;
    if (input.thinkingMode !== "off") {
      generationConfig.thinkingConfig = { thinkingLevel: mapGeminiThinkingLevel(input.effort, model), includeThoughts: true };
      if (sendsTemperature) generationConfig.temperature = 1;
    } else {
      // 3.x cannot disable thinking; omitting thinkingConfig silently bills
      // invisible thoughts. "off" = the lowest legal level, thoughts visible,
      // caller temperature honored (workers pass temperature 0 here).
      generationConfig.thinkingConfig = { thinkingLevel: lowestGeminiThinkingLevel(model), includeThoughts: true };
      if (sendsTemperature && input.temperature != null) generationConfig.temperature = input.temperature;
    }
    return generationConfig;
  }
  if (model?.supportsThinkingBudget) {
    const maxBudget = model.maxThinkingBudget ?? 24576;
    if (input.thinkingMode !== "off") {
      generationConfig.thinkingConfig = { thinkingBudget: clamp(input.thinkingBudget ?? maxBudget, 128, maxBudget), includeThoughts: true };
      generationConfig.temperature = 1;
    } else {
      // Real disable (2.5 Flash / Flash-Lite accept budget 0).
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
      if (input.temperature != null) generationConfig.temperature = input.temperature;
    }
    return generationConfig;
  }
  return generationConfig;
}

function lowestGeminiThinkingLevel(model: NonNullable<ReturnType<typeof getChatModel>>) {
  return model.effortOptions?.includes("minimal") ? "minimal" : "low";
}

function buildMockWizardReply(prompt: string) {
  const campaignName = extractMockWizardName(prompt);
  return [
    `Collected enough detail to prepare ${campaignName}.`,
    "",
    `## Campaign Brief: ${campaignName}`,
    "### Universe",
    "A grim city of ash with haunted bloodlines and dangerous court politics.",
    "### Main Character",
    "A haunted heir returning to claim a place in the court.",
    "### NPCs",
    "Courtiers, rivals, and uneasy allies with strong personal agendas.",
    "### Setting",
    "A soot-choked capital where every alliance feels temporary.",
    "### Premise",
    "The heir returns home and must survive the first court encounter.",
    "### Tone & Style",
    "Dark intrigue, emotional pressure, and close-character roleplay.",
    "### Character Control",
    "The AI should not write actions or dialogue for the main character unless invited.",
    "### Special Rules",
    "None specified.",
    "",
    "Your campaign brief is ready! The **Generate Campaign** button should now be available - click it when you're satisfied, or keep chatting to adjust anything.",
    "",
    "[WIZARD_READY]",
  ].join("\n");
}

function extractMockWizardName(prompt: string) {
  const patterns = [
    /call (?:the )?(?:campaign )?(?:it )?[\"']?([^.\"'\n]+)[\"']?/i,
    /campaign name[:\s]+[\"']?([^.\"'\n]+)[\"']?/i,
    /named [\"']?([^.\"'\n]+)[\"']?/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "Wizard Campaign";
}

function createXaiImageGenerationRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ImageGenerationRuntime {
  return {
    async generateImage(input) {
      // Grok Imagine 2.0 takes a quality and an aspect ratio from its catalog entry; 1.0 is
      // sent neither, as before.
      const settings = getImageModel(input.modelId);
      const response = await fetchImpl("https://api.x.ai/v1/images/generations", {
        method: "POST",
        signal: withTimeout(input.signal, IMAGE_TIMEOUT_MS),
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          resolution: "2k",
          ...(settings?.quality ? { quality: settings.quality } : {}),
          ...(settings?.aspectRatio ? { aspect_ratio: settings.aspectRatio } : {}),
        }),
      });
      if (!response.ok) {
        throw await providerHttpError("xai image", response, { secret: apiKey });
      }
      const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
      const item = payload.data?.[0];
      if (!item) throw new Error("xai image response missing image payload");
      if (item.b64_json) {
        return {
          mimeType: "image/jpeg",
          bytes: base64ToBytes(item.b64_json),
        };
      }
      if (item.url) {
        const imageResponse = await fetchImpl(item.url, { signal: withTimeout(input.signal, IMAGE_TIMEOUT_MS) });
        if (!imageResponse.ok) throw new Error(`xai image download failed with ${imageResponse.status}`);
        return {
          mimeType: imageResponse.headers.get("content-type") || "image/jpeg",
          bytes: new Uint8Array(await imageResponse.arrayBuffer()),
        };
      }
      throw new Error("xai image response missing image payload");
    },
  };
}

function createGoogleImageGenerationRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ImageGenerationRuntime {
  return {
    async generateImage(input) {
      const imageSize = getImageModel(input.modelId)?.imageSize;
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${input.modelId}:generateContent`, {
        method: "POST",
        signal: withTimeout(input.signal, IMAGE_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
          "x-client-request-id": input.requestId,
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: input.prompt }],
          }],
          generationConfig: {
            imageConfig: {
              aspectRatio: "16:9",
              ...(imageSize ? { imageSize } : {}),
            },
          },
        }),
      });
      if (!response.ok) {
        throw await providerHttpError("google image", response, { secret: apiKey });
      }
      const payload = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              thought?: boolean;
              inlineData?: { data?: string; mimeType?: string };
              inline_data?: { data?: string; mime_type?: string };
            }>;
          };
        }>;
      };
      // Gemini 3 Pro Image thinks before it draws, and Google documents interim images
      // inside that thinking (parts marked `thought`). They are drafts, never the answer.
      const part = payload.candidates?.[0]?.content?.parts?.find((item) => !item.thought && (item.inlineData?.data || item.inline_data?.data));
      const inlineData = part?.inlineData ?? part?.inline_data;
      if (!inlineData?.data) throw new Error("google image response missing image payload");
      const mimeType = "mimeType" in inlineData ? inlineData.mimeType : "mime_type" in inlineData ? inlineData.mime_type : undefined;
      return {
        mimeType: mimeType ?? "image/png",
        bytes: base64ToBytes(inlineData.data),
      };
    },
  };
}

function createZaiImageGenerationRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ImageGenerationRuntime {
  return {
    async generateImage(input) {
      const response = await fetchImpl("https://api.z.ai/api/paas/v4/images/generations", {
        method: "POST",
        signal: withTimeout(input.signal, IMAGE_TIMEOUT_MS),
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          size: "1280x1280",
        }),
      });
      if (!response.ok) {
        throw await providerHttpError("zai image", response, { secret: apiKey });
      }
      const payload = await response.json() as { data?: Array<{ url?: string }> };
      const url = payload.data?.[0]?.url;
      if (!url) throw new Error("zai image response missing image payload");
      const imageResponse = await fetchImpl(url, { signal: withTimeout(input.signal, IMAGE_TIMEOUT_MS) });
      if (!imageResponse.ok) throw new Error(`zai image download failed with ${imageResponse.status}`);
      return {
        mimeType: imageResponse.headers.get("content-type") || "image/png",
        bytes: new Uint8Array(await imageResponse.arrayBuffer()),
      };
    },
  };
}

export function createRegistryImageRuntime(input: {
  googleApiKey?: string;
  openaiApiKey?: string;
  xaiApiKey?: string;
  zaiApiKey?: string;
  fetchImpl?: typeof fetch;
}): ImageGenerationRuntime | null {
  const google = input.googleApiKey ? createGoogleImageGenerationRuntime(input.googleApiKey, input.fetchImpl) : null;
  const openai = input.openaiApiKey ? createOpenAIImageGenerationRuntime(input.openaiApiKey, input.fetchImpl) : null;
  const xai = input.xaiApiKey ? createXaiImageGenerationRuntime(input.xaiApiKey, input.fetchImpl) : null;
  const zai = input.zaiApiKey ? createZaiImageGenerationRuntime(input.zaiApiKey, input.fetchImpl) : null;
  if (!google && !openai && !xai && !zai) return null;
  return {
    async generateImage(payload) {
      const model = getImageModel(payload.modelId);
      if (!model) throw new Error("unsupported image model");
      const runtime = model.provider === "google" ? google : model.provider === "openai" ? openai : model.provider === "xai" ? xai : model.provider === "zai" ? zai : null;
      if (!runtime) throw new Error(`${model.provider} image runtime is not configured`);
      return runtime.generateImage(payload);
    },
  };
}

function parseSseChunk(raw: string, currentEventName: string, currentDataLines: string[]) {
  let nextEventName = currentEventName;
  let nextDataLines = currentDataLines;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("event:")) {
      nextEventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      nextDataLines = [...nextDataLines, line.slice(5).trimStart()];
    }
  }
  if (!nextDataLines.length) {
    // Per SSE spec, a blank-line boundary terminates the event record even when
    // no data field was present. Reset the event-name buffer so the next record
    // doesn't inherit a stale name from a prior `event: foo` line with no data.
    return { nextEventName: "message", nextDataLines: [], event: null };
  }
  const event = {
    name: nextEventName,
    data: nextDataLines.join("\n"),
  };
  return { nextEventName: "message", nextDataLines: [], event };
}

// A clean HTTP close is not proof that generation completed. Throwing keeps
// already streamed text in the caller's interrupted-response path and avoids
// successful-turn effects such as canon ingestion.
function requireStreamTerminal(received: boolean, dialect: string): void {
  if (!received) throw new Error(`${dialect} stream ended before its terminal event (premature EOF)`);
}

export type SseEvent = { name: string; data: string };

/**
 * Shared SSE reader. Reads `body`, normalizes CRLF → LF at the BUFFER level
 * (after concatenation, not per-chunk), splits on the blank-line boundary, and
 * yields one `{name, data}` event per record — including the synthetic `[DONE]`
 * sentinel record so each dialect's own terminal handling stays intact.
 *
 * Why this exists: every per-dialect loop used to run
 * `buffer += decoder.decode(...).replace(/\r\n/g, "\n")`, normalizing each read
 * chunk BEFORE concatenation. A `\r\n` straddling a read boundary (the `\r`
 * ends one chunk, the `\n` starts the next) then never collapsed to `\n`, so a
 * record terminator `\r\n\r\n` split across chunks left a literal `\r` in the
 * buffer, the `indexOf("\n\n")` boundary scan missed it, and two SSE records
 * merged into one — both then lost to `safeJson` → `{}`. Gemini streams CRLF,
 * so it was the live victim. Normalizing post-concat (here) is boundary-safe.
 *
 * The `stream: !done` flag on `TextDecoder.decode` already buffers partial
 * multi-byte UTF-8 sequences across reads; the CRLF bug was purely the
 * normalize-before-concat ordering, fixed by normalizing the whole buffer.
 */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  try {
    while (true) {
      // LOW tail: per-read inactivity timeout. The 35-min total ceiling
      // (CHAT_STREAM_TIMEOUT_MS on the fetch signal) bounds the whole turn, but a
      // stream that connects then goes silent mid-body wouldn't trip it until the
      // full ceiling. Bound each individual read so a stalled (bytes-stopped)
      // upstream surfaces in minutes, not the full 35. Generous enough for slow
      // first-token models (Fable cold-cache ingestion) since it resets per read.
      const { done, value } = await raceInactivity(reader.read(), SSE_INACTIVITY_TIMEOUT_MS);
      // Normalize at the buffer level (post-concat) so a CRLF split across read
      // boundaries still collapses correctly.
      buffer = (buffer + decoder.decode(value ?? new Uint8Array(), { stream: !done })).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseChunk(raw, eventName, dataLines);
        eventName = parsed.nextEventName;
        dataLines = parsed.nextDataLines;
        if (parsed.event) yield parsed.event;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        // Flush a residual unterminated event (clean close without a trailing
        // blank line) so its data isn't silently dropped.
        if (buffer.trim()) {
          const tail = parseSseChunk(buffer, eventName, dataLines);
          if (tail.event) yield tail.event;
        }
        break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

// No provider fetch had ANY timeout: a hung (not failing) upstream pinned a
// turn — and, via per-campaign serialization, a whole pipeline queue —
// indefinitely. The ceiling is generous (Fable 5 cold-cache ingestion alone
// can run 6+ minutes before the first byte) but finite.
// 35 min: the hard per-turn total ceiling. Raised 20→35 (2026-07-04) so it sits
// ABOVE the worker LLM deadline (30 min, retryHelper.WORKER_LLM_DEADLINE_MS) — the
// worker deadline must fire first so a hung worker call surfaces as a clean
// failure rather than this fetch abort (which a worker catch reads as a cancel).
// Interactive impact is negligible: real chat turns finish in minutes, a silent
// hang is caught far sooner by SSE_INACTIVITY_TIMEOUT_MS (10 min), and the user
// can Stop at any time — this is only the last-resort backstop.
const CHAT_STREAM_TIMEOUT_MS = 35 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
// Per-read (bytes-stalled) inactivity ceiling — resets on every chunk, so it
// bounds gaps BETWEEN bytes, not the total turn. Kept generous (well above the
// slowest known first-token latency) so it only fires on a genuinely dead
// stream, not a slow-but-alive one.
const SSE_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

// Race a read against an inactivity timer; reject if no bytes arrive in time.
// The timer is always cleared so a settled read never leaks a pending timeout.
function raceInactivity<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`stream inactive for ${ms}ms`)), ms);
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  // ms <= 0 = no total ceiling (wizard calls): the caller's own signal is the
  // only abort source; a genuinely dead stream still trips the SSE inactivity
  // gate. The never-aborting fallback keeps the return type non-optional.
  if (ms <= 0) return signal ?? new AbortController().signal;
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// A record that parses to a non-object (`data: null`, a bare string or number)
// is treated like an unparseable one: every dialect reads object fields off the
// result, and `null.error` surfaced as a TypeError in the error card instead
// of the partial-stream path (custom endpoints are untrusted upstreams).
function safeJson(data: string) {
  try {
    const parsed = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function withSystemPrompt(systemPrompt: string | null | undefined, messages: ChatPromptMessage[]) {
  if (!systemPrompt?.trim()) return messages;
  return [{ role: "system" as ChatRole, content: stripCacheSentinels(systemPrompt).trim() }, ...messages];
}

// The cache-control sentinels (`<<<TR_SEC>>>` section delimiter and the
// `<<<TR_CACHE_BOUNDARY>>>` prefix) are Anthropic-only markers — the Anthropic
// runtime splits on them to place cache_control breakpoints. chatService emits
// them for EVERY provider, so every other dialect must strip them or the literal
// sentinel tokens leak into the wire system prompt. The chat-completions
// dialects (xAI / DeepSeek / z.ai / Xiaomi / Moonshot / Fireworks / GMICloud /
// OpenAI chat / custom chat-completions) get it via withSystemPrompt; the two
// dialects with a dedicated system field — OpenAI Responses `instructions` and
// Gemini `systemInstruction` — call this directly (they bypassed it until
// 2026-09-02 and leaked on every campaign turn), as does the CodexBridge
// runtime in apps/api. Strip both: split on the section sentinel, drop the
// cache-boundary prefix from whichever section carries it, and rejoin with the
// section's plain separator.
export function stripCacheSentinels(systemPrompt: string): string {
  const SECTION_DELIMITER = "\n\n<<<TR_SEC>>>\n\n";
  const sections = systemPrompt.includes(SECTION_DELIMITER)
    ? systemPrompt.split(SECTION_DELIMITER)
    : [systemPrompt];
  return sections
    .map((section) => section.startsWith(CACHE_BOUNDARY_SENTINEL) ? section.slice(CACHE_BOUNDARY_SENTINEL.length) : section)
    .join("\n\n");
}

function buildDeepSeekMessages(systemPrompt: string | null | undefined, messages: ChatPromptMessage[]) {
  return withSystemPrompt(systemPrompt, messages).reduce<Array<{ role: ChatRole; content: string }>>((merged, message) => {
    const content = buildDeepSeekMessageContent(message);
    const previous = merged[merged.length - 1];
    if (previous?.role === message.role) {
      previous.content = `${previous.content}\n\n${content}`;
      return merged;
    }
    merged.push({ role: message.role, content });
    return merged;
  }, []);
}

function buildAnthropicMessages(messages: ChatPromptMessage[]) {
  const merged: Array<{ role: ChatRole; content: string | Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    const content = buildAnthropicMessageContent(message);
    const previous = merged[merged.length - 1];
    if (!previous || previous.role !== message.role) {
      merged.push({ role: message.role, content });
      continue;
    }
    if (typeof previous.content === "string" && typeof content === "string") {
      previous.content = `${previous.content}\n\n${content}`;
      continue;
    }
    const previousContent = typeof previous.content === "string"
      ? [{ type: "text", text: previous.content }]
      : previous.content;
    const nextContent = typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
    previous.content = [...previousContent, ...nextContent];
  }
  return merged;
}

function buildAnthropicMessageContent(message: ChatPromptMessage) {
  const attachments = message.attachments ?? [];
  if (!attachments.length) return message.content;
  if (!hasStructuredAttachments(attachments)) return buildTextAttachmentMessage(message);
  const content: Array<Record<string, unknown>> = [];
  for (const attachment of attachments) {
    if (attachment.contentMode === "text") {
      content.push({ type: "text", text: formatTextAttachment(attachment) });
      continue;
    }
    if (attachment.mimeType.startsWith("image/")) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: attachment.content,
        },
      });
      continue;
    }
    if (attachment.mimeType === "application/pdf") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: attachment.content,
        },
      });
      continue;
    }
    content.push({ type: "text", text: formatUnsupportedAttachmentWarning(attachment, "this model") });
  }
  if (message.content.trim()) content.push({ type: "text", text: message.content });
  return content;
}

function buildOpenAIResponsesMessageContent(message: ChatPromptMessage) {
  const attachments = message.attachments ?? [];
  if (!attachments.length) return message.content;
  if (!hasStructuredAttachments(attachments)) return buildTextAttachmentMessage(message);
  const content: Array<Record<string, unknown>> = [];
  for (const attachment of attachments) {
    if (attachment.contentMode === "text") {
      content.push({ type: "input_text", text: formatTextAttachment(attachment) });
      continue;
    }
    if (attachment.mimeType.startsWith("image/")) {
      content.push({ type: "input_image", image_url: `data:${attachment.mimeType};base64,${attachment.content}` });
      continue;
    }
    if (attachment.mimeType === "application/pdf") {
      content.push({
        type: "input_file",
        filename: attachment.filename,
        file_data: `data:application/pdf;base64,${attachment.content}`,
      });
      continue;
    }
    content.push({ type: "input_text", text: formatUnsupportedAttachmentWarning(attachment, "this model") });
  }
  if (message.content.trim()) content.push({ type: "input_text", text: message.content });
  return content;
}

function buildGeminiMessageParts(message: ChatPromptMessage) {
  const attachments = message.attachments ?? [];
  if (!attachments.length) return [{ text: message.content }];
  if (!hasStructuredAttachments(attachments)) return [{ text: buildTextAttachmentMessage(message) }];
  const parts: Array<Record<string, unknown>> = [];
  for (const attachment of attachments) {
    if (attachment.contentMode === "text") {
      parts.push({ text: formatTextAttachment(attachment) });
      continue;
    }
    if (attachment.mimeType.startsWith("image/") || attachment.mimeType === "application/pdf") {
      parts.push({
        inlineData: {
          mimeType: attachment.mimeType,
          data: attachment.content,
        },
      });
      continue;
    }
    parts.push({ text: formatUnsupportedAttachmentWarning(attachment, "this model") });
  }
  if (message.content.trim()) parts.push({ text: message.content });
  return parts;
}

function buildGeminiContents(messages: ChatPromptMessage[]) {
  const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = buildGeminiMessageParts(message);
    const previous = contents[contents.length - 1];
    if (previous?.role === role) {
      previous.parts.push(...parts);
      continue;
    }
    contents.push({ role, parts });
  }
  return contents;
}

function buildChatCompletionsMessageContent(message: ChatPromptMessage, options: { pdfMode: "native" | "warning" }) {
  const attachments = message.attachments ?? [];
  if (!attachments.length) return message.content;
  if (!hasStructuredAttachments(attachments)) return buildTextAttachmentMessage(message);
  const content: Array<Record<string, unknown>> = [];
  for (const attachment of attachments) {
    if (attachment.contentMode === "text") {
      content.push({ type: "text", text: formatTextAttachment(attachment) });
      continue;
    }
    if (attachment.mimeType.startsWith("image/")) {
      content.push({ type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${attachment.content}` } });
      continue;
    }
    if (attachment.mimeType === "application/pdf" && options.pdfMode === "native") {
      content.push({
        type: "file",
        file: {
          filename: attachment.filename,
          file_data: `data:application/pdf;base64,${attachment.content}`,
        },
      });
      continue;
    }
    content.push({ type: "text", text: formatUnsupportedAttachmentWarning(attachment, "this model") });
  }
  if (message.content.trim()) content.push({ type: "text", text: message.content });
  return content;
}

function buildDeepSeekMessageContent(message: ChatPromptMessage) {
  // DeepSeek is text-only on the wire. Keep text attachments inline and, like
  // the xAI / z.ai warning paths, replace each dropped image/PDF with a visible
  // marker so the model knows an attachment existed instead of the user
  // silently losing it.
  const attachments = message.attachments ?? [];
  const warnings = attachments
    .filter((attachment) => attachment.contentMode !== "text")
    .map((attachment) => formatUnsupportedAttachmentWarning(attachment, "DeepSeek"));
  const text = buildTextAttachmentMessage({
    ...message,
    attachments: attachments.filter((attachment) => attachment.contentMode === "text"),
  });
  if (!warnings.length) return text;
  return [...warnings, text].filter(Boolean).join("\n\n");
}

function formatTextAttachment(attachment: ChatPromptAttachment) {
  return `<attached_file name="${attachment.filename}">\n${attachment.content}\n</attached_file>`;
}

function hasStructuredAttachments(attachments: ChatPromptAttachment[]) {
  return attachments.some((attachment) => attachment.contentMode !== "text");
}

function buildTextAttachmentMessage(message: ChatPromptMessage) {
  const parts = (message.attachments ?? [])
    .filter((attachment) => attachment.contentMode === "text")
    .map(formatTextAttachment);
  if (message.content) parts.push(message.content);
  return parts.join("\n\n");
}

function formatUnsupportedAttachmentWarning(attachment: ChatPromptAttachment, modelLabel: string) {
  if (attachment.mimeType === "application/pdf") {
    return `[PDF "${attachment.filename}" attached but not supported by ${modelLabel} — use Anthropic or OpenAI for PDF input]`;
  }
  if (attachment.mimeType.startsWith("image/")) {
    return `[Image "${attachment.filename}" attached but not supported by ${modelLabel}]`;
  }
  return `[Binary attachment "${attachment.filename}" (${attachment.mimeType}) attached but not supported by ${modelLabel}]`;
}

function resolveMaxOutputTokens(modelId: string, explicit: number | null | undefined, fallback: number) {
  const cap = getChatModel(modelId)?.maxOutputTokens;
  if (explicit != null && Number.isFinite(explicit) && explicit > 0) {
    // Clamp explicit values to the model's cap — several providers hard-400 on
    // oversized max-token params instead of clamping server-side.
    return cap != null ? Math.min(explicit, cap) : explicit;
  }
  return cap ?? fallback;
}

function base64ToBytes(value: string) {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export { parseFirstJson } from "./extractJson";
