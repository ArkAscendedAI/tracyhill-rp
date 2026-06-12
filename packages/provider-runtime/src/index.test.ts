import { describe, expect, it } from "vitest";

import {
  createAnthropicMessagesRuntime,
  createChatRuntimeWithCustomEndpoints,
  createDeepSeekChatCompletionsRuntime,
  createGoogleGeminiRuntime,
  createOpenAIChatCompletionsRuntime,
  createOpenAIResponsesRuntime,
  createXaiChatCompletionsRuntime,
  createXiaomiChatCompletionsRuntime,
  createZaiChatCompletionsRuntime,
  type ChatRuntime,
} from "./index";

describe("provider runtime attachment payloads", () => {
  it("builds anthropic native image and pdf blocks", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-sonnet-4-6");

    const body = calls[0];
    expect(body.max_tokens).toBe(64000);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } },
      { type: "text", text: "Use the sealed letter." },
    ]);
  });

  it("keeps text-only anthropic attachment turns on the plain-text path", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await streamTextOnly(runtime, "claude-sonnet-4-6");

    expect(calls[0].messages[0].content).toBe("<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>\n\nUse the sealed letter.");
  });

  it("merges consecutive same-role multimodal turns on the anthropic path like v1", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await runtime.streamChat({
      modelId: "claude-sonnet-4-6",
      systemPrompt: "Keep the fiction coherent.",
      requestId: "req_anthropic_merge",
      messages: [
        {
          role: "user",
          content: "First move",
          attachments: [{ filename: "seal.png", mimeType: "image/png", contentMode: "base64", content: "ZmFrZQ==" }],
        },
        {
          role: "user",
          content: "Second move",
          attachments: [],
        },
      ],
    }, {
      onStart() {},
      onDelta() {},
      onThinkingDelta() {},
      onComplete() {},
    });

    expect(calls[0].messages).toEqual([{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
        { type: "text", text: "First move" },
        { type: "text", text: "Second move" },
      ],
    }]);
  });

  it("honors adaptive thinking on dual-mode models (opus 4.6) instead of downgrading to budget", async () => {
    // The session explicitly asks for adaptive; the old runtime silently sent
    // {type:"enabled", budget_tokens} on any model that ALSO supports budget.
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-opus-4-6", {
      thinkingMode: "adaptive",
      thinkingBudget: 127999,
      effort: "max",
    });

    const body = calls[0];
    expect(body.max_tokens).toBe(128000);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "max" });
  });

  it("still sends budget thinking on dual-mode models when the session asks for enabled", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-opus-4-6", {
      thinkingMode: "enabled",
      thinkingBudget: 127999,
      effort: "max",
    });

    const body = calls[0];
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 127999 });
    expect(body.temperature).toBe(1);
  });

  it("omits anthropic output_config when the resolved effort is high", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-sonnet-4-6", {
      thinkingMode: "adaptive",
      thinkingBudget: 63999,
      effort: "high",
    });

    const body = calls[0];
    expect(body.max_tokens).toBe(64000);
    expect(body.output_config).toBeUndefined();
  });

  it("builds openai responses native image and pdf blocks", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl));
    await stream(runtime, "gpt-5.4");

    const body = calls[0];
    expect(body.max_output_tokens).toBe(128000);
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>" },
      { type: "input_image", image_url: "data:image/png;base64,ZmFrZQ==" },
      { type: "input_file", filename: "brief.pdf", file_data: "data:application/pdf;base64,cGRm" },
      { type: "input_text", text: "Use the sealed letter." },
    ]);
  });

  it("keeps plain-text openai responses turns as raw strings", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl));
    await runtime.streamChat({
      modelId: "gpt-5.4",
      systemPrompt: "Keep the fiction coherent.",
      requestId: "req_text_only",
      messages: [{
        role: "user",
        content: "Use the sealed letter.",
        attachments: [],
      }],
    }, {
      onStart() {},
      onDelta() {},
      onThinkingDelta() {},
      onComplete() {},
    });

    expect(calls[0].input[0].content).toBe("Use the sealed letter.");
  });

  it("keeps text-only openai responses attachment turns as raw strings", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl));
    await streamTextOnly(runtime, "gpt-5.4");

    expect(calls[0].input[0].content).toBe("<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>\n\nUse the sealed letter.");
  });

  it("keeps the default openai responses reasoning payload when no explicit effort is set", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl));
    await runtime.streamChat({
      modelId: "gpt-5.4",
      systemPrompt: "Keep the fiction coherent.",
      requestId: "req_reasoning_default",
      messages: [{
        role: "user",
        content: "Use the sealed letter.",
        attachments: [],
      }],
    }, {
      onStart() {},
      onDelta() {},
      onThinkingDelta() {},
      onComplete() {},
    });

    expect(calls[0].reasoning).toEqual({ effort: "high", summary: "detailed" });
  });

  it("preserves minimal openai responses effort instead of downgrading it to low", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl));
    await runtime.streamChat({
      modelId: "gpt-5.4",
      systemPrompt: "Keep the fiction coherent.",
      requestId: "req_reasoning_minimal",
      effort: "minimal",
      messages: [{
        role: "user",
        content: "Use the sealed letter.",
        attachments: [],
      }],
    }, {
      onStart() {},
      onDelta() {},
      onThinkingDelta() {},
      onComplete() {},
    });

    expect(calls[0].reasoning).toEqual({ effort: "minimal", summary: "detailed" });
  });

  it("reports output truncation for openai responses incomplete events", async () => {
    const result = await captureCompletionResult(
      (fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl),
      "gpt-5.4",
      [
        "event: response.output_text.delta\ndata: {\"delta\":\"Cut short\"}\n\n",
        "event: response.incomplete\ndata: {\"response\":{\"status\":\"incomplete\"}}\n\n",
        "event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":128000,\"total_tokens\":128010}}}\n\n",
        "data: [DONE]\n\n",
      ],
    );

    expect(result).toEqual({
      usage: {
        inputTokens: 10,
        outputTokens: 128000,
        totalTokens: 128010,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        speed: null,
      },
      outputTruncated: true,
      stopReason: "incomplete",
      stopDetails: null,
      servedModel: null,
    });
  });

  it("treats openai responses done events as terminal completion events like v1", async () => {
    const result = await captureCompletionResult(
      (fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl),
      "gpt-5.4",
      [
        "event: response.output_text.delta\ndata: {\"delta\":\"Complete\"}\n\n",
        "event: response.done\ndata: {\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":34,\"total_tokens\":46}}}\n\n",
        "data: [DONE]\n\n",
      ],
    );

    expect(result).toEqual({
      usage: {
        inputTokens: 12,
        outputTokens: 34,
        totalTokens: 46,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        speed: null,
      },
      outputTruncated: false,
      stopReason: null,
      stopDetails: null,
      servedModel: null,
    });
  });

  it("captures the serving model from anthropic message_start and bridge served_model", async () => {
    // Direct Anthropic stamps the serving model on message_start; the bridge's
    // eager message_start carries the *requested* model and corrects it via
    // served_model on the final message_delta (last write wins). A Fable 5
    // safeguard fallback surfaces here as a model mismatch.
    const result = await captureCompletionResult(
      (fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl),
      "claude-fable-5",
      [
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-fable-5\",\"usage\":{\"input_tokens\":10}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"served_model\":\"claude-opus-4-8\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":4}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      ],
    );

    expect((result as { servedModel?: string | null }).servedModel).toBe("claude-opus-4-8");
    expect((result as { stopReason?: string | null }).stopReason).toBe("end_turn");
  });

  it("builds openai chat-completions native image and pdf blocks for gpt-4.1", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createOpenAIChatCompletionsRuntime("openai-key", fetchImpl));
    await stream(runtime, "gpt-4.1");

    const body = calls[0];
    expect(body.max_tokens).toBe(32768);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>" },
      { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
      { type: "file", file: { filename: "brief.pdf", file_data: "data:application/pdf;base64,cGRm" } },
      { type: "text", text: "Use the sealed letter." },
    ]);
  });

  it("keeps text-only chat-completions attachment turns as plain strings", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createOpenAIChatCompletionsRuntime("openai-key", fetchImpl));
    await streamTextOnly(runtime, "gpt-4.1");

    expect(calls[0].messages[1].content).toBe("<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>\n\nUse the sealed letter.");
  });

  it("forwards explicit temperature on chat-completions runtimes", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createOpenAIChatCompletionsRuntime("openai-key", fetchImpl));
    await stream(runtime, "gpt-4.1", { temperature: 0.45 });

    expect(calls[0].temperature).toBe(0.45);
  });

  it("reports output truncation for chat-completions length finish reasons", async () => {
    const result = await captureCompletionResult(
      (fetchImpl) => createOpenAIChatCompletionsRuntime("openai-key", fetchImpl),
      "gpt-4.1",
      [
        "data: {\"choices\":[{\"delta\":{\"content\":\"Cut short\"}}]}\n\n",
        "data: {\"choices\":[{\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":14,\"completion_tokens\":32768,\"total_tokens\":32782}}\n\n",
        "data: [DONE]\n\n",
      ],
    );

    expect(result).toEqual({
      usage: {
        inputTokens: 14,
        outputTokens: 32768,
        totalTokens: 32782,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        speed: null,
      },
      outputTruncated: true,
      stopReason: "length",
      stopDetails: null,
      servedModel: null,
    });
  });

  it("forwards explicit temperature on anthropic when thinking is off", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-haiku-4-5-20251001", { temperature: 0.7 });

    expect(calls[0].thinking).toBeUndefined();
    expect(calls[0].temperature).toBe(0.7);
  });

  it("drops temperature on opus-4-7 even when caller passes one (adaptive-thinking-only models reject it)", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-opus-4-7", { temperature: 0, thinkingMode: "off" });

    expect(calls[0].thinking).toBeUndefined();
    expect(calls[0].temperature).toBeUndefined();
  });

  it("drops temperature on opus-4-7 with adaptive thinking on", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-opus-4-7", { temperature: 0.5, thinkingMode: "adaptive" });

    expect(calls[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(calls[0].temperature).toBeUndefined();
  });

  it("always sends adaptive thinking on fable-5 even when thinkingMode is off (always-on model)", async () => {
    // Fable 5 thinks regardless of the request — omitting the param would run
    // thinking invisibly (display defaults to omitted upstream) while still billing
    // for it. The runtime pins adaptive+summarized so it stays visible.
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-fable-5", { temperature: 0, thinkingMode: "off" });

    expect(calls[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(calls[0].temperature).toBeUndefined();
  });

  it("sends adaptive thinking on fable-5 with thinkingMode adaptive and drops temperature", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-fable-5", { temperature: 0.5, thinkingMode: "adaptive" });

    expect(calls[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(calls[0].temperature).toBeUndefined();
  });

  it("restores separate anthropic system blocks for v1-style campaign prompt shaping", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-sonnet-4-6", {
      systemPrompt: "Keep the fiction coherent.\n\n---\n\nAsh storms bury the old roads.",
      cacheTtl: "1h",
    });

    expect(calls[0].system).toEqual([
      {
        type: "text",
        text: "Keep the fiction coherent.",
      },
      {
        type: "text",
        text: "Ash storms bury the old roads.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("preserves minimal anthropic effort instead of downgrading it to low", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl));
    await stream(runtime, "claude-opus-4-6", {
      thinkingMode: "off",
      effort: "minimal",
    });

    expect(calls[0].output_config).toEqual({ effort: "minimal" });
  });

  it("forwards abort signals to anthropic, google, and z.ai runtimes", async () => {
    const anthropicSignal = await captureSignal((fetchImpl) => createAnthropicMessagesRuntime("anthropic-key", fetchImpl), "claude-sonnet-4-6");
    const googleSignal = await captureSignal((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl), "gemini-2.5-flash");
    const zaiSignal = await captureSignal((fetchImpl) => createZaiChatCompletionsRuntime("zai-key", fetchImpl), "glm-4.5");

    expect(anthropicSignal).toBeInstanceOf(AbortSignal);
    expect(googleSignal).toBeInstanceOf(AbortSignal);
    expect(zaiSignal).toBeInstanceOf(AbortSignal);
  });

  it("builds google native inlineData parts for image and pdf attachments", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await stream(runtime, "gemini-2.5-flash");

    const body = calls[0];
    expect(body.generationConfig.maxOutputTokens).toBe(65536);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 24576, includeThoughts: true });
    expect(body.generationConfig.temperature).toBe(1);
    expect(body.contents[0].parts).toEqual([
      { text: "<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>" },
      { inlineData: { mimeType: "image/png", data: "ZmFrZQ==" } },
      { inlineData: { mimeType: "application/pdf", data: "cGRm" } },
      { text: "Use the sealed letter." },
    ]);
  });

  it("keeps text-only google attachment turns as single text parts", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await streamTextOnly(runtime, "gemini-2.5-flash");

    expect(calls[0].contents[0].parts).toEqual([
      { text: "<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>\n\nUse the sealed letter." },
    ]);
  });

  it("merges consecutive same-role multimodal turns on the google path like v1", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await runtime.streamChat({
      modelId: "gemini-2.5-flash",
      systemPrompt: "Keep the fiction coherent.",
      requestId: "req_google_merge",
      messages: [
        {
          role: "user",
          content: "First move",
          attachments: [{ filename: "seal.png", mimeType: "image/png", contentMode: "base64", content: "ZmFrZQ==" }],
        },
        {
          role: "user",
          content: "Second move",
          attachments: [],
        },
      ],
    }, {
      onStart() {},
      onDelta() {},
      onThinkingDelta() {},
      onComplete() {},
    });

    expect(calls[0].contents).toEqual([{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: "ZmFrZQ==" } },
        { text: "First move" },
        { text: "Second move" },
      ],
    }]);
  });

  it("builds google gemini 3.x thinking-level payloads", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await stream(runtime, "gemini-3.1-pro-preview", {
      thinkingMode: "enabled",
      effort: "high",
    });

    const body = calls[0];
    expect(body.generationConfig.maxOutputTokens).toBe(65536);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true });
    expect(body.generationConfig.temperature).toBe(1);
  });

  it("builds google gemini 3.5 flash thinking-level payloads", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await stream(runtime, "gemini-3.5-flash", {
      thinkingMode: "enabled",
      effort: "high",
    });

    const body = calls[0];
    expect(body.generationConfig.maxOutputTokens).toBe(65536);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true });
    expect(body.generationConfig.temperature).toBe(1);
  });

  it("forwards explicit temperature on google when thinking is off", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await stream(runtime, "gemini-2.5-flash", {
      thinkingMode: "off",
      temperature: 0.6,
    });

    // "off" now sends a REAL disable (budget 0) instead of omitting the config
    // (omission = dynamic thinking, silently billed).
    expect(calls[0].generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(calls[0].generationConfig.temperature).toBe(0.6);
  });

  it("builds xAI image blocks and v1-style pdf warnings", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createXaiChatCompletionsRuntime("xai-key", fetchImpl));
    await stream(runtime, "grok-4.3");

    const body = calls[0];
    expect(body.max_tokens).toBe(131072);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>" },
      { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
      { type: "text", text: "[PDF \"brief.pdf\" attached but not supported by this model — use Anthropic or OpenAI for PDF input]" },
      { type: "text", text: "Use the sealed letter." },
    ]);
  });

  it("builds z.ai image blocks and v1-style pdf warnings", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createZaiChatCompletionsRuntime("zai-key", fetchImpl));
    await stream(runtime, "glm-4.5");

    const body = calls[0];
    expect(body.max_tokens).toBe(96000);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>" },
      { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
      { type: "text", text: "[PDF \"brief.pdf\" attached but not supported by this model — use Anthropic or OpenAI for PDF input]" },
      { type: "text", text: "Use the sealed letter." },
    ]);
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.temperature).toBe(1);
  });

  it("maps Xiaomi MiMo thinking mode to the enabled/disabled toggle", async () => {
    // MiMo exposes thinking as a simple on/off toggle. The API also accepts
    // "adaptive", but the catalog models it as a toggle, so any on-state
    // (legacy "adaptive" or "enabled") maps to "enabled" on the wire.
    const adaptive = captureRuntime((fetchImpl) => createXiaomiChatCompletionsRuntime("mimo-key", fetchImpl));
    await stream(adaptive.runtime, "mimo-v2.5-pro", { thinkingMode: "adaptive" });
    expect(adaptive.calls[0].thinking).toEqual({ type: "enabled" });
    expect(adaptive.calls[0].max_completion_tokens).toBe(131072);
    expect(adaptive.calls[0].stream_options).toEqual({ include_usage: true });

    const off = captureRuntime((fetchImpl) => createXiaomiChatCompletionsRuntime("mimo-key", fetchImpl));
    await stream(off.runtime, "mimo-v2.5-pro", { thinkingMode: "off" });
    expect(off.calls[0].thinking).toEqual({ type: "disabled" });

    const enabled = captureRuntime((fetchImpl) => createXiaomiChatCompletionsRuntime("mimo-key", fetchImpl));
    await stream(enabled.runtime, "mimo-v2.5-pro", { thinkingMode: "enabled" });
    expect(enabled.calls[0].thinking).toEqual({ type: "enabled" });
  });

  it("builds deepseek text-only message payloads with passthrough temperature", async () => {
    // V4 dropped the old V3/R1 forced temperature=1: temperature passes through
    // when given and is omitted otherwise (thinking ignores it server-side).
    const { calls, runtime } = captureRuntime((fetchImpl) => createDeepSeekChatCompletionsRuntime("deepseek-key", fetchImpl));
    await stream(runtime, "deepseek-v4-flash");

    const body = calls[0];
    expect(body.max_tokens).toBe(384000);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "Keep the fiction coherent." },
      {
        role: "user",
        content: "<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>\n\nUse the sealed letter.",
      },
    ]);
  });

  it("merges consecutive same-role deepseek turns only on the text path like v1", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createDeepSeekChatCompletionsRuntime("deepseek-key", fetchImpl));
    await runtime.streamChat({
      modelId: "deepseek-v4-flash",
      systemPrompt: "Keep the fiction coherent.",
      requestId: "req_deepseek_merge",
      messages: [
        {
          role: "user",
          content: "First move",
          attachments: [{ filename: "seal.png", mimeType: "image/png", contentMode: "base64", content: "ZmFrZQ==" }],
        },
        {
          role: "user",
          content: "Second move",
          attachments: [{ filename: "notes.txt", mimeType: "text/plain", contentMode: "text", content: "Anchor detail" }],
        },
      ],
    }, {
      onStart() {},
      onDelta() {},
      onThinkingDelta() {},
      onComplete() {},
    });

    expect(calls[0].temperature).toBeUndefined();
    expect(calls[0].messages).toEqual([
      { role: "system", content: "Keep the fiction coherent." },
      {
        role: "user",
        content: "First move\n\n<attached_file name=\"notes.txt\">\nAnchor detail\n</attached_file>\n\nSecond move",
      },
    ]);
  });

  it("forwards configured max output tokens for custom response endpoints", async () => {
    const calls: any[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const runtime = createChatRuntimeWithCustomEndpoints(null, [{
      id: "ep_custom01",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiFormat: "responses",
      authHeader: "Bearer",
      apiKey: "secret",
      hasKey: true,
      updatedAt: null,
      createdAt: null,
      models: [{
        id: "openrouter/sonnet",
        label: "OpenRouter Sonnet",
        maxOut: 8192,
        ctx: 200000,
      }],
    }], fetchImpl);
    if (!runtime) throw new Error("expected custom runtime");

    await runtime.streamChat({
      modelId: "custom:ep_custom01:openrouter/sonnet",
      systemPrompt: "Keep the fiction coherent.",
      requestId: "req_custom",
      messages: [{
        role: "user",
        content: "Use the sealed letter.",
      }],
    }, {
      onStart() {},
      onDelta() {},
      onThinkingDelta() {},
      onComplete() {},
    });

    expect(calls[0].model).toBe("openrouter/sonnet");
    expect(calls[0].max_output_tokens).toBe(8192);
  });

  // ── 2026-06-12 audit additions: passive-shape matrix, captures, clamp ──

  it("z.ai thinking off sends {type:disabled} (Shape-1 passive callers)", async () => {
    const off = captureRuntime((fetchImpl) => createZaiChatCompletionsRuntime("zai-key", fetchImpl));
    await stream(off.runtime, "glm-5.1", { thinkingMode: "off", temperature: 0 });
    expect(off.calls[0].thinking).toEqual({ type: "disabled" });
    expect(off.calls[0].temperature).toBe(0);

    const adaptive = captureRuntime((fetchImpl) => createZaiChatCompletionsRuntime("zai-key", fetchImpl));
    await stream(adaptive.runtime, "glm-5.1", { thinkingMode: "adaptive" });
    expect(adaptive.calls[0].thinking).toEqual({ type: "enabled" });
  });

  it("deepseek V4 thinking toggle: off->disabled, enabled->enabled, unset->omitted", async () => {
    const off = captureRuntime((fetchImpl) => createDeepSeekChatCompletionsRuntime("deepseek-key", fetchImpl));
    await stream(off.runtime, "deepseek-v4-flash", { thinkingMode: "off", temperature: 0 });
    expect(off.calls[0].thinking).toEqual({ type: "disabled" });
    expect(off.calls[0].temperature).toBe(0);

    const on = captureRuntime((fetchImpl) => createDeepSeekChatCompletionsRuntime("deepseek-key", fetchImpl));
    await stream(on.runtime, "deepseek-v4-pro", { thinkingMode: "enabled" });
    expect(on.calls[0].thinking).toEqual({ type: "enabled" });

    const unset = captureRuntime((fetchImpl) => createDeepSeekChatCompletionsRuntime("deepseek-key", fetchImpl));
    await stream(unset.runtime, "deepseek-v4-flash");
    expect(unset.calls[0].thinking).toBeUndefined();
  });

  it("gemini 3.x off maps to the lowest legal thinkingLevel with caller temperature", async () => {
    // 3.5 Flash supports minimal; 3.1 Pro does not (live 400) -> low.
    const flash = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await stream(flash.runtime, "gemini-3.5-flash", { thinkingMode: "off", temperature: 0 });
    expect(flash.calls[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal", includeThoughts: true });
    expect(flash.calls[0].generationConfig.temperature).toBe(0);

    const pro = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await stream(pro.runtime, "gemini-3.1-pro-preview", { thinkingMode: "off", temperature: 0 });
    expect(pro.calls[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("gemini 2.5 Pro (thinkingAlwaysOn) always requests visible dynamic thinking", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl));
    await stream(runtime, "gemini-2.5-pro", { thinkingMode: "off", temperature: 0.3 });
    expect(calls[0].generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    expect(calls[0].generationConfig.temperature).toBe(0.3);
  });

  it("xai thinking off with no explicit effort sends reasoning_effort none", async () => {
    const off = captureRuntime((fetchImpl) => createXaiChatCompletionsRuntime("xai-key", fetchImpl));
    await stream(off.runtime, "grok-4.3", { thinkingMode: "off", temperature: 0 });
    expect(off.calls[0].reasoning_effort).toBe("none");

    // explicit effort still wins (chat sessions: off+low keeps reasoning on)
    const low = captureRuntime((fetchImpl) => createXaiChatCompletionsRuntime("xai-key", fetchImpl));
    await stream(low.runtime, "grok-4.3", { thinkingMode: "off", effort: "low" });
    expect(low.calls[0].reasoning_effort).toBe("low");
  });

  it("openai responses thinking off maps to effort none on models that support it", async () => {
    const off = captureRuntime((fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl));
    await stream(off.runtime, "gpt-5.4", { thinkingMode: "off" });
    expect(off.calls[0].reasoning).toEqual({ effort: "none", summary: "detailed" });

    // gpt-5 has no "none" -> default high preserved
    const legacy = captureRuntime((fetchImpl) => createOpenAIResponsesRuntime("openai-key", fetchImpl));
    await stream(legacy.runtime, "gpt-5", { thinkingMode: "off" });
    expect(legacy.calls[0].reasoning).toEqual({ effort: "high", summary: "detailed" });
  });

  it("captures cached + reasoning tokens and served model on chat-completions dialects", async () => {
    const result = await captureCompletionResult(
      (fetchImpl) => createZaiChatCompletionsRuntime("zai-key", fetchImpl),
      "glm-5.1",
      [
        "data: {\"model\":\"glm-5.1\",\"choices\":[{\"delta\":{\"reasoning_content\":\"hm\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":30,\"total_tokens\":50,\"prompt_tokens_details\":{\"cached_tokens\":8},\"completion_tokens_details\":{\"reasoning_tokens\":12}}}\n\n",
        "data: [DONE]\n\n",
      ],
    );
    expect(result).toEqual({
      usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50, cacheReadTokens: 8, cacheWriteTokens: null, reasoningTokens: 12, speed: null },
      outputTruncated: false,
      stopReason: "stop",
      stopDetails: null,
      servedModel: "glm-5.1",
    });
  });

  it("captures gemini thoughts as billed output + cached tokens + model version", async () => {
    const result = await captureCompletionResult(
      (fetchImpl) => createGoogleGeminiRuntime("google-key", fetchImpl),
      "gemini-3.5-flash",
      [
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"plan\",\"thought\":true},{\"text\":\"Done\"}]},\"finishReason\":\"STOP\"}],\"modelVersion\":\"gemini-3.5-flash\",\"usageMetadata\":{\"promptTokenCount\":17,\"candidatesTokenCount\":12,\"totalTokenCount\":215,\"thoughtsTokenCount\":186,\"cachedContentTokenCount\":4}}\n\n",
      ],
    );
    expect(result).toEqual({
      // outputTokens = candidates (12) + thoughts (186): Google bills thoughts as output.
      usage: { inputTokens: 17, outputTokens: 198, totalTokens: 215, cacheReadTokens: 4, cacheWriteTokens: null, reasoningTokens: 186, speed: null },
      outputTruncated: false,
      stopReason: "STOP",
      stopDetails: null,
      servedModel: "gemini-3.5-flash",
    });
  });

  it("clamps explicit maxOutputTokens to the catalog cap", async () => {
    const { calls, runtime } = captureRuntime((fetchImpl) => createXiaomiChatCompletionsRuntime("mimo-key", fetchImpl));
    await runtime.streamChat({
      modelId: "mimo-v2.5",
      systemPrompt: null,
      requestId: "req_clamp",
      maxOutputTokens: 999999,
      messages: [{ role: "user", content: "hi" }],
    }, { onStart() {}, onDelta() {}, onThinkingDelta() {}, onComplete() {} });
    expect(calls[0].max_completion_tokens).toBe(131072);
  });
});

function captureRuntime(build: (fetchImpl: typeof fetch) => ChatRuntime) {
  const calls: any[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(new ReadableStream({
      start(controller) {
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { calls, runtime: build(fetchImpl) };
}

async function stream(
  runtime: ChatRuntime,
  modelId: string,
  overrides: {
    systemPrompt?: string;
    temperature?: number | null;
    thinkingMode?: "off" | "enabled" | "adaptive";
    thinkingBudget?: number | null;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
    cacheTtl?: "off" | "5m" | "1h" | null;
  } = {},
) {
  await runtime.streamChat({
    modelId,
    systemPrompt: overrides.systemPrompt ?? "Keep the fiction coherent.",
    requestId: "req_test",
    ...overrides,
    messages: [{
      role: "user",
      content: "Use the sealed letter.",
      attachments: [
        { filename: "notes.txt", mimeType: "text/plain", contentMode: "text", content: "Anchor detail" },
        { filename: "seal.png", mimeType: "image/png", contentMode: "base64", content: "ZmFrZQ==" },
        { filename: "brief.pdf", mimeType: "application/pdf", contentMode: "base64", content: "cGRm" },
      ],
    }],
  }, {
    onStart() {},
    onDelta() {},
    onThinkingDelta() {},
    onComplete() {},
  });
}

async function streamTextOnly(
  runtime: ChatRuntime,
  modelId: string,
  overrides: {
    systemPrompt?: string;
    temperature?: number | null;
    thinkingMode?: "off" | "enabled" | "adaptive";
    thinkingBudget?: number | null;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
    cacheTtl?: "off" | "5m" | "1h" | null;
  } = {},
) {
  await runtime.streamChat({
    modelId,
    systemPrompt: overrides.systemPrompt ?? "Keep the fiction coherent.",
    requestId: "req_text_only_attachment",
    ...overrides,
    messages: [{
      role: "user",
      content: "Use the sealed letter.",
      attachments: [
        { filename: "notes.txt", mimeType: "text/plain", contentMode: "text", content: "Anchor detail" },
      ],
    }],
  }, {
    onStart() {},
    onDelta() {},
    onThinkingDelta() {},
    onComplete() {},
  });
}

async function captureSignal(build: (fetchImpl: typeof fetch) => ChatRuntime, modelId: string) {
  let seenSignal: AbortSignal | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const runtime = build(fetchImpl);
  const abortController = new AbortController();
  await runtime.streamChat({
    modelId,
    systemPrompt: "Keep the fiction coherent.",
    requestId: `req_signal_${modelId}`,
    signal: abortController.signal,
    messages: [{
      role: "user",
      content: "Use the sealed letter.",
      attachments: [],
    }],
  }, {
    onStart() {},
    onDelta() {},
    onThinkingDelta() {},
    onComplete() {},
  });
  return seenSignal;
}

async function captureCompletionResult(
  build: (fetchImpl: typeof fetch) => ChatRuntime,
  modelId: string,
  events: string[],
) {
  let result: { usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null }; outputTruncated: boolean } | null = null;
  const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const runtime = build(fetchImpl);
  await runtime.streamChat({
    modelId,
    systemPrompt: "Keep the fiction coherent.",
    requestId: `req_completion_${modelId}`,
    messages: [{
      role: "user",
      content: "Use the sealed letter.",
      attachments: [],
    }],
  }, {
    onStart() {},
    onDelta() {},
    onThinkingDelta() {},
    onComplete(nextResult) {
      result = nextResult;
    },
  });
  if (!result) throw new Error("expected completion result");
  return result;
}
