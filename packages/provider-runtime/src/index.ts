import { buildCustomChatModels, parseCustomChatModelId, type AttachmentContentMode, type ChatRole, type ChatUsage, type CustomEndpointSummary, type SessionCacheTtl, type SessionEffort, type SessionThinkingMode, type StopDetails } from "@tracyhill-rp/contracts";
import { getChatModel, getImageModel } from "@tracyhill-rp/model-catalog";

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
  }, callbacks: ChatStreamCallbacks) => Promise<void>;
};

export type ImageGenerationRuntime = {
  generateImage: (input: {
    modelId: string;
    prompt: string;
    requestId: string;
  }) => Promise<{
    mimeType: string;
    bytes: Uint8Array;
  }>;
};

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
  }, fetchImpl);
}

export function createOpenAICompatibleResponsesRuntime(
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
        signal: withTimeout(input.signal, CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          instructions: input.systemPrompt || undefined,
          input: input.messages.map((message) => ({
            role: message.role,
            content: buildOpenAIResponsesMessageContent(message),
          })),
          max_output_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 100000),
          reasoning: { effort: resolveOpenAIResponsesEffort(model, input.effort, input.thinkingMode), summary: "detailed" },
          stream: true,
        }),
      });
      if (!response.ok || !response.body) {
        if (options.stripUpstreamErrors) {
          // Custom endpoint sink: drop upstream body so it can't be used as an SSRF readback channel.
          await readBoundedErrorBody(response);
          throw new Error(`custom endpoint request failed with status ${response.status}`);
        }
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `${options.errorLabel ?? "openai"} request failed with ${response.status}`);
      }
      callbacks.onStart();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];
      let sawDone = false;
      let outputTruncated = false;
      let completed = false;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      try {
        while (!sawDone) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const parsed = parseSseChunk(raw, eventName, dataLines);
            eventName = parsed.nextEventName;
            dataLines = parsed.nextDataLines;
            if (parsed.event) {
              if (parsed.event.data === "[DONE]") {
                sawDone = true;
                break;
              }
              if (parsed.event.name === "response.output_text.delta") {
                const payload = safeJson(parsed.event.data) as { delta?: string };
                if (payload.delta) callbacks.onDelta(payload.delta);
              }
              if (parsed.event.name === "response.created") {
                const payload = safeJson(parsed.event.data) as { response?: { model?: string } };
                if (payload.response?.model) servedModel = payload.response.model;
              }
              if (parsed.event.name === "response.reasoning_summary_text.delta" || parsed.event.name === "response.reasoning_text.delta") {
                const payload = safeJson(parsed.event.data) as { delta?: string };
                if (payload.delta) callbacks.onThinkingDelta(payload.delta);
              }
              if (parsed.event.name === "response.completed" || parsed.event.name === "response.done") {
                const payload = safeJson(parsed.event.data) as OpenAIResponsesTerminalPayload;
                const u = payload.response?.usage ?? payload.usage;
                usage = buildOpenAIResponsesUsage(u);
                if (!completed) {
                  callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
                  completed = true;
                }
              }
              if (parsed.event.name === "response.incomplete") {
                // Terminal on the real Responses API (response.completed does
                // NOT follow) — capture usage here or truncated turns persist
                // with all-null usage.
                outputTruncated = true;
                const payload = safeJson(parsed.event.data) as OpenAIResponsesTerminalPayload;
                stopReason = payload.response?.incomplete_details?.reason ? `incomplete:${payload.response.incomplete_details.reason}` : "incomplete";
                const u = payload.response?.usage ?? payload.usage;
                if (u) usage = buildOpenAIResponsesUsage(u);
              }
              if (parsed.event.name === "response.failed") {
                const payload = safeJson(parsed.event.data) as { response?: { error?: { message?: string } }; error?: { message?: string }; message?: string };
                throw new Error(payload.response?.error?.message ?? payload.error?.message ?? payload.message ?? "openai streaming error");
              }
              if (parsed.event.name === "error") {
                const payload = safeJson(parsed.event.data) as { error?: { message?: string }; message?: string };
                throw new Error(payload.error?.message ?? payload.message ?? "openai streaming error");
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
          if (done) {
            // End-of-stream buffer flush: parse any residual unterminated event.
            if (buffer.trim()) {
              const tail = parseSseChunk(buffer, eventName, dataLines);
              if (tail.event && tail.event.data !== "[DONE]") {
                if (tail.event.name === "response.output_text.delta") {
                  const payload = safeJson(tail.event.data) as { delta?: string };
                  if (payload.delta) callbacks.onDelta(payload.delta);
                }
                if (tail.event.name === "response.completed" || tail.event.name === "response.done" || tail.event.name === "response.incomplete") {
                  const payload = safeJson(tail.event.data) as OpenAIResponsesTerminalPayload;
                  const u = payload.response?.usage ?? payload.usage;
                  if (tail.event.name === "response.incomplete") outputTruncated = true;
                  if (u) usage = buildOpenAIResponsesUsage(u);
                }
              }
              buffer = "";
            }
            break;
          }
        }
        // If the upstream closed without emitting response.completed, fire
        // onComplete from here so the consumer doesn't hang.
        if (!completed) callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
      } finally {
        try { await reader.cancel(); } catch { /* already closed */ }
      }
    },
  };
}

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
        signal: withTimeout(input.signal, CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          ...(input.systemPrompt ? {
            systemInstruction: {
              parts: [{ text: input.systemPrompt }],
            },
          } : {}),
          contents: buildGeminiContents(input.messages),
          generationConfig: buildGeminiGenerationConfig(model, input),
        }),
      });
      if (!response.ok || !response.body) {
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `google request failed with ${response.status}`);
      }
      callbacks.onStart();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let outputTruncated = false;
     try {
      while (true) {
        const { done, value } = await reader.read();
        // Normalize CRLF to LF — Gemini's SSE stream uses \r\n line endings
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseChunk(raw, eventName, dataLines);
          eventName = parsed.nextEventName;
          dataLines = parsed.nextDataLines;
          if (parsed.event) {
            const payload = safeJson(parsed.event.data) as {
              candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
              usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
              modelVersion?: string;
              error?: { message?: string };
            };
            if (payload.error?.message) throw new Error(payload.error.message);
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
              usage = {
                inputTokens: payload.usageMetadata.promptTokenCount ?? null,
                outputTokens: candidates != null || thoughts > 0 ? (candidates ?? 0) + thoughts : null,
                totalTokens: payload.usageMetadata.totalTokenCount ?? null,
                cacheReadTokens: payload.usageMetadata.cachedContentTokenCount ?? null,
                cacheWriteTokens: null,
                reasoningTokens: payload.usageMetadata.thoughtsTokenCount ?? null,
                speed: null,
              };
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
     } finally {
       try { await reader.cancel(); } catch { /* already closed */ }
     }
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
  endpoint: { url: string; authMode: "x-api-key" | "Bearer"; apiKey: string; forceCacheTtl1h?: boolean; mapModelId?: (id: string) => string },
  fetchImpl: typeof fetch = fetch,
): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const wireModelId = endpoint.mapModelId ? endpoint.mapModelId(input.modelId) : input.modelId;
      const model = getChatModel(input.modelId);
      const anthropicEffort = resolveAnthropicEffort(model, input.effort);
      const anthropicMaxThinkingBudget = model?.maxThinkingBudget ?? 4095;
      // Adaptive-only models always use adaptive; dual-mode models (Opus 4.6 /
      // Sonnet 4.6) honor the session's explicit thinkingMode — the old
      // !supportsThinkingBudget condition made the UI's "Adaptive" silently
      // send budget thinking on them.
      const useAdaptiveThinking = Boolean(model?.supportsAdaptiveThinking)
        && (!model?.supportsThinkingBudget || input.thinkingMode === "adaptive");
      // Fast mode: only forward to upstream if caller asked AND not on the bridge route
      // (Claude Code SDK doesn't accept the speed param — chatService should already gate
      // this, but defense in depth at the runtime level too).
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
      const response = await fetchImpl(endpoint.url, {
        method: "POST",
        headers,
        signal: withTimeout(input.signal, CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify((() => {
          const requestedTtl = endpoint.forceCacheTtl1h ? "1h" : (input.cacheTtl ?? "off");
          const cacheTag = buildCacheTag(requestedTtl);
          const mergedMessages = buildAnthropicMessages(input.messages);
          addMessageCacheBreakpoints(mergedMessages, cacheTag);
          const reqBody = {
            model: wireModelId,
            ...(input.systemPrompt ? { system: buildAnthropicSystemPrompt(input.systemPrompt, cacheTag) } : {}),
            max_tokens: resolveMaxOutputTokens(wireModelId, input.maxOutputTokens, 4096),
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
              : useAdaptiveThinking ? {}
              : input.temperature != null ? { temperature: input.temperature } : {}),
            ...(anthropicEffort && anthropicEffort !== "high" ? { output_config: { effort: anthropicEffort } } : {}),
            ...(fastMode ? { speed: "fast" } : {}),
            messages: mergedMessages,
            stream: true,
          };
          return reqBody;
        })()),
      });
      if (!response.ok || !response.body) {
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `anthropic request failed with ${response.status}`);
      }
      callbacks.onStart();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];
      let activeBlockType: string | null = null;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let outputTruncated = false;
      let messageStopSeen = false;
      let stopReason: string | null = null;
      let stopDetails: StopDetails = null;
      let servedModel: string | null = null;
     try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseChunk(raw, eventName, dataLines);
          eventName = parsed.nextEventName;
          dataLines = parsed.nextDataLines;
          if (parsed.event) {
            const payload = safeJson(parsed.event.data) as {
              delta?: { text?: string; stop_reason?: string; stop_details?: { type?: string; category?: string | null; explanation?: string | null } | null; served_model?: string };
              message?: { model?: string; usage?: AnthropicWireUsage };
              usage?: AnthropicWireUsage;
              error?: { message?: string };
            };
            if (payload.error?.message) throw new Error(payload.error.message);
            if (parsed.event.name === "content_block_start") {
              activeBlockType = (payload as { content_block?: { type?: string } }).content_block?.type ?? null;
            }
            if (parsed.event.name === "content_block_stop") activeBlockType = null;
            if (parsed.event.name === "content_block_delta") {
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
            if (parsed.event.name === "message_stop") messageStopSeen = true;
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
                cacheReadTokens: nextUsage.cache_read_input_tokens ?? usage.cacheReadTokens,
                cacheWriteTokens: nextUsage.cache_creation_input_tokens ?? usage.cacheWriteTokens,
                reasoningTokens: nextUsage.output_tokens_details?.thinking_tokens ?? usage.reasoningTokens,
                // Verify which speed actually ran (we may request fast but get standard
                // on deprecated models after the rollback window).
                speed: nextUsage.speed === "fast" ? "fast" : nextUsage.speed === "standard" ? "standard" : usage.speed,
              };
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done || messageStopSeen) break;
      }
     } finally {
       try { await reader.cancel(); } catch { /* already closed */ }
     }
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
      const effort = model?.supportsEffort
        ? (mapXaiEffort(input.effort) ?? (input.thinkingMode === "off" ? "none" : undefined))
        : undefined;
      const response = await fetchImpl("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, CHAT_STREAM_TIMEOUT_MS),
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
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `xai request failed with ${response.status}`);
      }
      callbacks.onStart();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];
      let sawDone = false;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
     try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseChunk(raw, eventName, dataLines);
          eventName = parsed.nextEventName;
          dataLines = parsed.nextDataLines;
          if (parsed.event) {
            if (parsed.event.data === "[DONE]") { sawDone = true; break; }
            const payload = safeJson(parsed.event.data) as {
              model?: string;
              choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
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
            if (payload.usage) {
              usage = {
                inputTokens: payload.usage.prompt_tokens ?? null,
                outputTokens: payload.usage.completion_tokens ?? null,
                totalTokens: payload.usage.total_tokens ?? null,
                cacheReadTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? null,
                cacheWriteTokens: null,
                reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens ?? null,
                speed: null,
              };
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
     } finally {
       try { await reader.cancel(); } catch { /* already closed */ }
     }
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

export function createDeepSeekChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const response = await fetchImpl("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, CHAT_STREAM_TIMEOUT_MS),
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
        }),
      });
      if (!response.ok || !response.body) {
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `deepseek request failed with ${response.status}`);
      }
      callbacks.onStart();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];
      let sawDone = false;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
     try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseChunk(raw, eventName, dataLines);
          eventName = parsed.nextEventName;
          dataLines = parsed.nextDataLines;
          if (parsed.event) {
            if (parsed.event.data === "[DONE]") {
              sawDone = true;
              break;
            }
            const payload = safeJson(parsed.event.data) as {
              model?: string;
              choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
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
            if (payload.usage) {
              usage = {
                inputTokens: payload.usage.prompt_tokens ?? null,
                outputTokens: payload.usage.completion_tokens ?? null,
                totalTokens: payload.usage.total_tokens ?? null,
                cacheReadTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? payload.usage.prompt_cache_hit_tokens ?? null,
                cacheWriteTokens: null,
                reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens ?? null,
                speed: null,
              };
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
     } finally {
       try { await reader.cancel(); } catch { /* already closed */ }
     }
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

export function createOpenAICompatibleChatCompletionsRuntime(
  endpoint: Pick<CustomEndpointSummary, "baseUrl" | "apiKey" | "authHeader">,
  options: { includeStreamUsage?: boolean; pdfMode?: "native" | "warning"; errorLabel?: string; stripUpstreamErrors?: boolean } = {},
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
        signal: withTimeout(input.signal, CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: options.pdfMode ?? "warning" }),
          })),
          max_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 4096),
          ...(input.temperature != null ? { temperature: input.temperature } : {}),
          ...(options.includeStreamUsage ? { stream_options: { include_usage: true } } : {}),
          stream: true,
        }),
      });
      if (!response.ok || !response.body) {
        if (options.stripUpstreamErrors) {
          // Custom endpoint sink: drop upstream body so it can't be used as an SSRF readback channel.
          await readBoundedErrorBody(response);
          throw new Error(`custom endpoint request failed with status ${response.status}`);
        }
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `${options.errorLabel ?? "request"} request failed with ${response.status}`);
      }
      callbacks.onStart();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];
      let sawDone = false;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
     try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseChunk(raw, eventName, dataLines);
          eventName = parsed.nextEventName;
          dataLines = parsed.nextDataLines;
          if (parsed.event) {
            if (parsed.event.data === "[DONE]") {
              sawDone = true;
              break;
            }
            const payload = safeJson(parsed.event.data) as {
              model?: string;
              choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
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
            if (payload.usage) {
              usage = {
                inputTokens: payload.usage.prompt_tokens ?? null,
                outputTokens: payload.usage.completion_tokens ?? null,
                totalTokens: payload.usage.total_tokens ?? null,
                cacheReadTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? null,
                cacheWriteTokens: null,
                reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens ?? null,
                speed: null,
              };
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
     } finally {
       try { await reader.cancel(); } catch { /* already closed */ }
     }
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

export function createZaiChatCompletionsRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ChatRuntime {
  return {
    async streamChat(input, callbacks) {
      const response = await fetchImpl("https://api.z.ai/api/paas/v4/chat/completions", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "accept-language": "en-US,en",
          "x-client-request-id": input.requestId,
        },
        signal: withTimeout(input.signal, CHAT_STREAM_TIMEOUT_MS),
        body: JSON.stringify({
          model: input.modelId,
          messages: withSystemPrompt(input.systemPrompt, input.messages).map((message) => ({
            role: message.role,
            content: buildChatCompletionsMessageContent(message, { pdfMode: "warning" }),
          })),
          stream: true,
          stream_options: { include_usage: true },
          temperature: input.temperature ?? 1.0,
          max_tokens: resolveMaxOutputTokens(input.modelId, input.maxOutputTokens, 4096),
          // {type:"disabled"} is legal first-party on every GLM (live-verified
          // 2026-06-12, zero reasoning tokens) — "off" now genuinely disables.
          // Omitted/enabled/adaptive all map to enabled (the server default).
          thinking: { type: input.thinkingMode === "off" ? "disabled" : "enabled" },
        }),
      });
      if (!response.ok || !response.body) {
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `zai request failed with ${response.status}`);
      }
      callbacks.onStart();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];
      let sawDone = false;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
     try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseChunk(raw, eventName, dataLines);
          eventName = parsed.nextEventName;
          dataLines = parsed.nextDataLines;
          if (parsed.event) {
            if (parsed.event.data === "[DONE]") {
              sawDone = true;
              break;
            }
            const payload = safeJson(parsed.event.data) as {
              model?: string;
              choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
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
            if (payload.usage) {
              usage = {
                inputTokens: payload.usage.prompt_tokens ?? null,
                outputTokens: payload.usage.completion_tokens ?? null,
                totalTokens: payload.usage.total_tokens ?? null,
                cacheReadTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? null,
                cacheWriteTokens: null,
                reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens ?? null,
                speed: null,
              };
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
     } finally {
       try { await reader.cancel(); } catch { /* already closed */ }
     }
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
        signal: withTimeout(input.signal, CHAT_STREAM_TIMEOUT_MS),
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
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `xiaomi request failed with ${response.status}`);
      }
      callbacks.onStart();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];
      let sawDone = false;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
      let stopReason: string | null = null;
      let servedModel: string | null = null;
      let outputTruncated = false;
     try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseChunk(raw, eventName, dataLines);
          eventName = parsed.nextEventName;
          dataLines = parsed.nextDataLines;
          if (parsed.event) {
            if (parsed.event.data === "[DONE]") {
              sawDone = true;
              break;
            }
            const payload = safeJson(parsed.event.data) as {
              model?: string;
              choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; reasoning_content?: string; reasoning?: { content?: string } } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
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
            if (payload.usage) {
              usage = {
                inputTokens: payload.usage.prompt_tokens ?? null,
                outputTokens: payload.usage.completion_tokens ?? null,
                totalTokens: payload.usage.total_tokens ?? null,
                cacheReadTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? null,
                cacheWriteTokens: null,
                reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens ?? null,
                speed: null,
              };
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
     } finally {
       try { await reader.cancel(); } catch { /* already closed */ }
     }
      callbacks.onComplete({ usage, outputTruncated, stopReason, stopDetails: null, servedModel });
    },
  };
}

export function createCustomEndpointRuntime(endpoint: Pick<CustomEndpointSummary, "baseUrl" | "apiKey" | "apiFormat" | "authHeader">, fetchImpl: typeof fetch = fetch) {
  // Custom endpoints get error-body stripping -- upstream bodies are untrusted and could be used
  // as an SSRF readback channel against internal services that pass the URL gate but return sensitive
  // error text.
  return endpoint.apiFormat === "responses"
    ? createOpenAICompatibleResponsesRuntime(endpoint, fetchImpl, { stripUpstreamErrors: true })
    : createOpenAICompatibleChatCompletionsRuntime(endpoint, { stripUpstreamErrors: true }, fetchImpl);
}

export function createRegistryChatRuntime(input: {
  anthropicApiKey?: string;
  claudeCodeBridgeUrl?: string;
  claudeCodeBridgeSecret?: string;
  deepseekApiKey?: string;
  googleApiKey?: string;
  openaiApiKey?: string;
  xaiApiKey?: string;
  xiaomiApiKey?: string;
  zaiApiKey?: string;
  fetchImpl?: typeof fetch;
}): ChatRuntime | null {
  const openaiResponses = input.openaiApiKey ? createOpenAIResponsesRuntime(input.openaiApiKey, input.fetchImpl) : null;
  const openaiChatCompletions = input.openaiApiKey ? createOpenAIChatCompletionsRuntime(input.openaiApiKey, input.fetchImpl) : null;
  const claudeCodeRuntime = input.claudeCodeBridgeUrl && input.claudeCodeBridgeSecret
    ? createAnthropicMessagesRuntimeWithEndpoint({
        url: input.claudeCodeBridgeUrl.replace(/\/$/, "") + "/v1/messages",
        authMode: "Bearer",
        apiKey: input.claudeCodeBridgeSecret,
        forceCacheTtl1h: true,
        mapModelId: (id) => id.endsWith("-bridge") ? id.slice(0, -"-bridge".length) : id,
      }, input.fetchImpl)
    : null;
  const runtimes = {
    anthropic: input.anthropicApiKey ? createAnthropicMessagesRuntime(input.anthropicApiKey, input.fetchImpl) : null,
    "claude-code": claudeCodeRuntime,
    deepseek: input.deepseekApiKey ? createDeepSeekChatCompletionsRuntime(input.deepseekApiKey, input.fetchImpl) : null,
    google: input.googleApiKey ? createGoogleGeminiRuntime(input.googleApiKey, input.fetchImpl) : null,
    xai: input.xaiApiKey ? createXaiChatCompletionsRuntime(input.xaiApiKey, input.fetchImpl) : null,
    xiaomi: input.xiaomiApiKey ? createXiaomiChatCompletionsRuntime(input.xiaomiApiKey, input.fetchImpl) : null,
    zai: input.zaiApiKey ? createZaiChatCompletionsRuntime(input.zaiApiKey, input.fetchImpl) : null,
  } as const;
  if (!runtimes.anthropic && !runtimes["claude-code"] && !runtimes.deepseek && !runtimes.google && !openaiResponses && !openaiChatCompletions && !runtimes.xai && !runtimes.xiaomi && !runtimes.zai) return null;
  return {
    async streamChat(payload, callbacks) {
      const model = getChatModel(payload.modelId);
      if (!model) throw new Error("unsupported model");
      const runtime = model.provider === "openai"
        ? (model.supportsEffort ? openaiResponses : openaiChatCompletions)
        : runtimes[model.provider];
      if (!runtime) throw new Error(`${model.provider} runtime is not configured`);
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

export function createOpenAIImageGenerationRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ImageGenerationRuntime {
  return {
    async generateImage(input) {
      const response = await fetchImpl("https://api.openai.com/v1/images/generations", {
        method: "POST",
        signal: withTimeout(undefined, IMAGE_TIMEOUT_MS),
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          size: "1536x1024",
          quality: "high",
        }),
      });
      if (!response.ok) {
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `openai image request failed with ${response.status}`);
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

function mapOpenaiEffort(effort: SessionEffort) {
  if (effort === "max") return "high";
  return effort;
}

// Responses-API effort resolution: explicit session effort wins; otherwise
// thinkingMode "off" maps to "none" on models that support it (5.5/5.4/5.1) so
// passive "off" callers get true non-reasoning; else the API default "high".
function resolveOpenAIResponsesEffort(
  model: ReturnType<typeof getChatModel>,
  effort: SessionEffort | null | undefined,
  thinkingMode: SessionThinkingMode | null | undefined,
) {
  if (effort) return mapOpenaiEffort(effort);
  if (thinkingMode === "off" && model?.effortOptions?.includes("none")) return "none";
  return "high";
}

type OpenAIResponsesWireUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

type OpenAIResponsesTerminalPayload = {
  response?: { usage?: OpenAIResponsesWireUsage; incomplete_details?: { reason?: string } };
  usage?: OpenAIResponsesWireUsage;
};

function buildOpenAIResponsesUsage(u: OpenAIResponsesWireUsage | undefined): ChatUsage {
  return {
    inputTokens: u?.input_tokens ?? null,
    outputTokens: u?.output_tokens ?? null,
    totalTokens: u?.total_tokens ?? null,
    cacheReadTokens: u?.input_tokens_details?.cached_tokens ?? null,
    cacheWriteTokens: null,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? null,
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

function mapXaiEffort(effort: SessionEffort | null | undefined): string | undefined {
  if (!effort) return undefined;
  if (effort === "minimal") return "none";
  if (effort === "xhigh" || effort === "max") return "high";
  return effort;
}

function mapAnthropicEffort(effort: SessionEffort) {
  return effort;
}

function resolveAnthropicEffort(model: ReturnType<typeof getChatModel>, effort: SessionEffort | null | undefined) {
  if (!effort) return null;
  const mapped = mapAnthropicEffort(effort);
  if (mapped === "max" && !model?.effortOptions?.includes("max")) return "high";
  return mapped;
}

function mapGeminiThinkingLevel(effort: SessionEffort | null | undefined) {
  if (!effort || effort === "max") return "high";
  return effort;
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
    if (input.thinkingMode !== "off") {
      generationConfig.thinkingConfig = { thinkingLevel: mapGeminiThinkingLevel(input.effort), includeThoughts: true };
      generationConfig.temperature = 1;
    } else {
      // 3.x cannot disable thinking; omitting thinkingConfig silently bills
      // invisible thoughts. "off" = the lowest legal level, thoughts visible,
      // caller temperature honored (workers pass temperature 0 here).
      generationConfig.thinkingConfig = { thinkingLevel: lowestGeminiThinkingLevel(model), includeThoughts: true };
      if (input.temperature != null) generationConfig.temperature = input.temperature;
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

export function createXaiImageGenerationRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ImageGenerationRuntime {
  return {
    async generateImage(input) {
      const response = await fetchImpl("https://api.x.ai/v1/images/generations", {
        method: "POST",
        signal: withTimeout(undefined, IMAGE_TIMEOUT_MS),
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-client-request-id": input.requestId,
        },
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          resolution: "2k",
        }),
      });
      if (!response.ok) {
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `xai image request failed with ${response.status}`);
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
        const imageResponse = await fetchImpl(item.url, { signal: withTimeout(undefined, IMAGE_TIMEOUT_MS) });
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

export function createGoogleImageGenerationRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ImageGenerationRuntime {
  return {
    async generateImage(input) {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${input.modelId}:generateContent`, {
        method: "POST",
        signal: withTimeout(undefined, IMAGE_TIMEOUT_MS),
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
            },
          },
        }),
      });
      if (!response.ok) {
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `google image request failed with ${response.status}`);
      }
      const payload = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { data?: string; mimeType?: string };
              inline_data?: { data?: string; mime_type?: string };
            }>;
          };
        }>;
      };
      const part = payload.candidates?.[0]?.content?.parts?.find((item) => item.inlineData?.data || item.inline_data?.data);
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

export function createZaiImageGenerationRuntime(apiKey: string, fetchImpl: typeof fetch = fetch): ImageGenerationRuntime {
  return {
    async generateImage(input) {
      const response = await fetchImpl("https://api.z.ai/api/paas/v4/images/generations", {
        method: "POST",
        signal: withTimeout(undefined, IMAGE_TIMEOUT_MS),
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
        const text = await readBoundedErrorBody(response);
        throw new Error(text || `zai image request failed with ${response.status}`);
      }
      const payload = await response.json() as { data?: Array<{ url?: string }> };
      const url = payload.data?.[0]?.url;
      if (!url) throw new Error("zai image response missing image payload");
      const imageResponse = await fetchImpl(url, { signal: withTimeout(undefined, IMAGE_TIMEOUT_MS) });
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

// No provider fetch had ANY timeout: a hung (not failing) upstream pinned a
// turn — and, via per-campaign serialization, a whole pipeline queue —
// indefinitely. The ceiling is generous (Fable 5 cold-cache ingestion alone
// can run 6+ minutes before the first byte) but finite.
const CHAT_STREAM_TIMEOUT_MS = 20 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safeJson(data: string) {
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function withSystemPrompt(systemPrompt: string | null | undefined, messages: ChatPromptMessage[]) {
  if (!systemPrompt?.trim()) return messages;
  return [{ role: "system" as ChatRole, content: systemPrompt.trim() }, ...messages];
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
  return buildTextAttachmentMessage({
    ...message,
    attachments: (message.attachments ?? []).filter((attachment) => attachment.contentMode === "text"),
  });
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
