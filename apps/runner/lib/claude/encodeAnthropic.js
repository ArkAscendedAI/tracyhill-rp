import { randomUUID } from "node:crypto";

// Ported from an earlier standalone bridge. Streams NormEvents
// as native Anthropic Messages SSE with SEPARATE thinking and text content blocks,
// the shape TracyHill RP's provider-runtime reads from the direct API.
//
// One deliberate change from the bridge: message_start is no longer written
// eagerly. A failure BEFORE any content (no login, a refused model, a dead CLI)
// is sent as an Anthropic `error` event, which the RP runtime throws as the
// turn's error — loud, never a completed reply whose text says "[error: …]".
// A failure after content has started still lands in-band, because the reply
// cannot be un-started. Comment pings keep the connection alive meanwhile.
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function streamAnthropic(res, normGen, { model }) {
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store",
    "X-Accel-Buffering": "no",
    "Transfer-Encoding": "chunked",
  });

  const pingTimer = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 10000);

  let started = false;
  let blockIndex = -1;
  let blockOpen = false;
  let hadTextBlock = false;
  let hadThinkingBlock = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let stopReason = "end_turn";
  let servedModel = null;
  let failedBeforeStart = false;

  function start() {
    if (started) return;
    started = true;
    sse(res, "message_start", {
      type: "message_start",
      message: {
        id: messageId, type: "message", role: "assistant", content: [], model: model || "claude-opus-4-6",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }
  function openBlock(type) {
    start();
    blockIndex += 1;
    blockOpen = true;
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    });
  }
  function closeBlock() {
    if (!blockOpen) return;
    sse(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
    blockOpen = false;
  }
  function failBeforeStart(message) {
    failedBeforeStart = true;
    sse(res, "error", { type: "error", error: { type: "api_error", message } });
  }

  try {
    for await (const ev of normGen) {
      switch (ev.type) {
        case "thinking_start":
          hadThinkingBlock = true;
          if (blockOpen) closeBlock();
          openBlock("thinking");
          break;
        case "thinking_delta":
          if (!blockOpen) openBlock("thinking");
          sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: ev.text } });
          break;
        case "text_start":
          hadTextBlock = true;
          if (blockOpen) closeBlock();
          openBlock("text");
          break;
        case "text_delta":
          hadTextBlock = true;
          if (!blockOpen) openBlock("text");
          sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: ev.text } });
          break;
        case "block_stop":
          closeBlock();
          break;
        case "done":
          start();
          if (ev.usage) {
            inputTokens = ev.usage.input_tokens ?? 0;
            outputTokens = ev.usage.output_tokens ?? 0;
            cacheCreationTokens = ev.usage.cache_creation_input_tokens ?? 0;
            cacheReadTokens = ev.usage.cache_read_input_tokens ?? 0;
          }
          if (ev.model) servedModel = ev.model;
          break;
        case "error":
          if (!started) { failBeforeStart(ev.message); break; }
          if (blockOpen) closeBlock();
          openBlock("text");
          sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: `\n\n*[error: ${ev.message}]*\n` } });
          stopReason = "end_turn";
          break;
      }
      if (failedBeforeStart) break;
    }
  } catch (err) {
    const message = err?.message || String(err);
    if (!started) failBeforeStart(message);
    else {
      if (!blockOpen) openBlock("text");
      sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: `\n\n*[stream error: ${message}]*\n` } });
    }
  } finally {
    clearInterval(pingTimer);
  }

  if (failedBeforeStart) { res.end(); return; }
  start();

  if (hadThinkingBlock && !hadTextBlock) {
    closeBlock();
    openBlock("text");
    sse(res, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: "\n\n*[Response was interrupted — only thinking was produced. Please retry.]*\n" } });
  }
  closeBlock();

  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null, ...(servedModel ? { served_model: servedModel } : {}) },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: cacheCreationTokens, cache_read_input_tokens: cacheReadTokens },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

export async function bufferAnthropic(normGen, { model }) {
  let servedModel = null;
  const blocks = [];
  let cur = null;
  let inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0;
  let error = null;
  function flush() { if (cur) { blocks.push(cur); cur = null; } }
  for await (const ev of normGen) {
    switch (ev.type) {
      case "thinking_start": flush(); cur = { type: "thinking", thinking: "" }; break;
      case "thinking_delta": if (!cur || cur.type !== "thinking") { flush(); cur = { type: "thinking", thinking: "" }; } cur.thinking += ev.text; break;
      case "text_start": flush(); cur = { type: "text", text: "" }; break;
      case "text_delta": if (!cur || cur.type !== "text") { flush(); cur = { type: "text", text: "" }; } cur.text += ev.text; break;
      case "block_stop": flush(); break;
      case "done":
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens ?? 0; outputTokens = ev.usage.output_tokens ?? 0;
          cacheCreationTokens = ev.usage.cache_creation_input_tokens ?? 0; cacheReadTokens = ev.usage.cache_read_input_tokens ?? 0;
        }
        if (ev.model) servedModel = ev.model;
        break;
      case "error":
        if (!blocks.length && !cur) { error = ev.message; break; }
        if (!cur || cur.type !== "text") { flush(); cur = { type: "text", text: "" }; }
        cur.text += `\n\n*[error: ${ev.message}]*\n`;
        break;
    }
    if (error) break;
  }
  flush();
  if (error) { const failure = new Error(error); failure.statusCode = 502; throw failure; }
  return {
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message", role: "assistant", content: blocks,
    model: servedModel || model || "claude-opus-4-6", stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: cacheCreationTokens, cache_read_input_tokens: cacheReadTokens },
  };
}
