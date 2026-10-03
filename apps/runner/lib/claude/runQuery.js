import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

// Ported from an earlier standalone bridge and agent service
// (buildSessionOpts + the SDK message loop), collapsed into one hop: the Agent SDK runs
// the unmodified Claude Code binary directly, under the calling user's own home.
//
// NormEvent shapes yielded:
//   {type:"text_delta", text} · {type:"thinking_delta", text} · {type:"thinking_start"}
//   {type:"text_start"} · {type:"block_stop"} · {type:"done", usage, model, sessionId, cost, duration}
//   {type:"error", message}

// The bridge flattens history into one user message with log-style turn markers;
// the model sometimes mimics the scaffolding and continues past its own turn.
// Anything at or after the first stop token is discarded.
const STOP_LITERALS = ["</assistant>", "<user>", "<assistant>"];
const STOP_REGEX = /=== TURN \d+: (USER|ASSISTANT) ===/;
const HOLDBACK = 32;
// No real model output for this long means a zombie query (the v1 service's stall
// watchdog, 2026-07-10): interrupt so callers fail in minutes, not tens of minutes.
// Known-legit silence (a huge adaptive-thinking prompt ingesting) tops out ~4-5 min.
export const STALL_MS = 8 * 60_000;
const ADAPTIVE_DEFAULT = /^claude-(opus-4-7|opus-4-8|opus-5|sonnet-5|fable)/;

export function findEarliestStopToken(buf) {
  let earliest = -1;
  for (const tok of STOP_LITERALS) {
    const idx = buf.indexOf(tok);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  const m = buf.match(STOP_REGEX);
  if (m && m.index !== undefined && (earliest === -1 || m.index < earliest)) earliest = m.index;
  return earliest;
}

/** The v1 service's bridge session options, plus SDK isolation (no settings, no tools, no transcript on disk). */
export function buildQueryOptions({ cwd, env, wrapperPath, systemPromptOverride, model, effort, thinking, stderr }) {
  const opts = {
    cwd,
    includePartialMessages: true,
    persistSession: false,
    systemPrompt: systemPromptOverride,
    allowedTools: [],
    tools: [],
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 1,
    env,
    pathToClaudeCodeExecutable: wrapperPath,
    executable: wrapperPath,
    stderr,
  };
  if (model) opts.model = model;
  if (effort) opts.effort = effort;
  // Thinking: when the caller speaks the field, take it verbatim (an object enables
  // it; null means omit). When absent, adaptive+summarized for the models whose
  // thinking is otherwise invisible (4.7/4.8 off, Opus 5 / Fable always on).
  if (thinking !== undefined) {
    if (thinking && typeof thinking === "object") opts.thinking = thinking;
  } else if (model && ADAPTIVE_DEFAULT.test(model)) {
    opts.thinking = { type: "adaptive", display: "summarized" };
  }
  return opts;
}

export function messagesToAsyncIterable(messages) {
  return (async function* () {
    for (const m of messages) {
      if (!m || m.type !== "user" || !m.message || m.message.role !== "user") continue;
      yield { type: "user", message: m.message, parent_tool_use_id: m.parent_tool_use_id ?? null };
    }
  })();
}

/** SDK message → the agent-service event vocabulary the bridge logic below consumes. */
export function translateSdkMessage(msg) {
  const out = [];
  if (!msg || typeof msg !== "object") return out;
  if (msg.type === "stream_event" && msg.event) {
    const evt = msg.event;
    if (evt.type === "content_block_start" && evt.content_block?.type === "thinking") out.push(["thinking_start", {}]);
    else if (evt.type === "content_block_delta" && evt.delta) {
      if (evt.delta.type === "thinking_delta") out.push(["thinking_delta", { text: evt.delta.thinking }]);
      else if (evt.delta.type === "text_delta") out.push(["text_delta", { text: evt.delta.text }]);
    } else if (evt.type === "content_block_stop") out.push(["block_stop", {}]);
  } else if (msg.type === "assistant" && msg.message?.content) {
    const servedModel = msg.message.model || null;
    for (const block of msg.message.content) {
      if (block.type === "text") out.push(["text", { content: block.text, model: servedModel }]);
      else if (block.type === "thinking") out.push(["thinking", { content: block.thinking, model: servedModel }]);
    }
  } else if (msg.type === "result") {
    out.push(["result", {
      subtype: msg.subtype, usage: msg.usage, cost: msg.total_cost_usd, duration: msg.duration_ms,
      sessionId: msg.session_id, errors: Array.isArray(msg.errors) ? msg.errors : null, result: msg.result,
    }]);
  } else if (msg.type === "system" && msg.subtype === "init") {
    out.push(["system", { model: msg.model, sessionId: msg.session_id }]);
  }
  return out;
}

export async function* runQuery({ messages, systemPromptOverride, thinking, model, effort, cwd, env, wrapperPath, signal, log = (line) => console.error(line), queryImpl = sdkQuery }) {
  let handle = null;
  let abortRequested = false;
  let stalled = false;
  let errored = false;
  const interrupt = () => { try { const p = handle?.interrupt?.(); if (p && typeof p.catch === "function") p.catch(() => {}); } catch {} };
  const closeHandle = () => { try { handle?.close?.(); } catch {} };
  const onAbort = () => { abortRequested = true; interrupt(); closeHandle(); };
  if (signal?.aborted) return;
  signal?.addEventListener("abort", onAbort, { once: true });

  const opts = buildQueryOptions({
    cwd, env, wrapperPath, systemPromptOverride, model, effort, thinking,
    stderr: (line) => { const text = String(line).trim(); if (text) log(`[claude:stderr] ${text}`); },
  });

  let resultEmitted = false;
  let inBlock = null; // "text" | "thinking" | null
  let textBuf = "";
  let assistantClosed = false;
  let hasText = false;
  let hasThinking = false;
  let streamedThinking = false;
  let servedModel = null;
  let lastRealAt = Date.now();
  const stallTimer = setInterval(() => {
    if (Date.now() - lastRealAt <= STALL_MS) return;
    stalled = true;
    clearInterval(stallTimer);
    log(`[claude] no model output for ${Math.round(STALL_MS / 60000)} min — interrupting the stalled query`);
    interrupt();
    closeHandle();
  }, 30_000);

  function* emitText(text) {
    if (!text) return;
    if (inBlock !== "text") {
      if (inBlock) yield { type: "block_stop" };
      inBlock = "text";
      yield { type: "text_start" };
    }
    yield { type: "text_delta", text };
  }
  function* flushText() {
    if (!textBuf) return;
    const out = textBuf;
    textBuf = "";
    yield* emitText(out);
  }
  function* openThinking() {
    yield* flushText();
    if (inBlock !== "thinking") {
      if (inBlock) yield { type: "block_stop" };
      inBlock = "thinking";
      yield { type: "thinking_start" };
    }
  }

  try {
    handle = queryImpl({ prompt: messagesToAsyncIterable(messages), options: opts });
    outer: for await (const msg of handle) {
      lastRealAt = Date.now();
      if (abortRequested) break;
      for (const [event, data] of translateSdkMessage(msg)) {
        switch (event) {
          case "thinking_start":
            if (assistantClosed) break;
            yield* openThinking();
            break;
          case "thinking_delta":
            if (assistantClosed || !data?.text) break;
            hasThinking = true;
            streamedThinking = true;
            yield* openThinking();
            yield { type: "thinking_delta", text: data.text };
            break;
          case "thinking":
            // The final assistant message echoes the whole thinking block; it is the
            // only carrier when no thinking deltas streamed (never a duplicate).
            if (assistantClosed || !data?.content || streamedThinking) break;
            hasThinking = true;
            yield* openThinking();
            yield { type: "thinking_delta", text: data.content };
            break;
          case "text_delta": {
            if (assistantClosed || !data?.text) break;
            hasText = true;
            textBuf += data.text;
            const tagIdx = findEarliestStopToken(textBuf);
            if (tagIdx !== -1) {
              const before = textBuf.slice(0, tagIdx).replace(/\s+$/, "");
              textBuf = "";
              assistantClosed = true;
              yield* emitText(before);
              if (inBlock) { yield { type: "block_stop" }; inBlock = null; }
              interrupt();
              // Yield `done` now instead of waiting seconds for the SDK's result:
              // the user has already seen every byte they will see. Usage stays
              // null — the accepted trade-off for a fast composer unlock.
              resultEmitted = true;
              yield { type: "done", usage: null, model: servedModel || model || null, sessionId: null, cost: null, duration: null };
            } else if (textBuf.length > HOLDBACK) {
              const release = textBuf.slice(0, -HOLDBACK);
              textBuf = textBuf.slice(-HOLDBACK);
              yield* emitText(release);
            }
            break;
          }
          case "block_stop":
            if (!assistantClosed) yield* flushText();
            if (inBlock) { yield { type: "block_stop" }; inBlock = null; }
            break;
          case "text":
          case "system":
            if (data?.model) servedModel = data.model;
            break;
          case "result": {
            resultEmitted = true;
            if (!assistantClosed) yield* flushText();
            if (inBlock) { yield { type: "block_stop" }; inBlock = null; }
            const failed = data?.subtype && data.subtype !== "success";
            if (failed && !hasText) {
              // e.g. error_during_execution with no content: say so instead of
              // completing an empty reply as success.
              errored = true;
              const detail = data.errors?.length ? data.errors.join("; ") : (typeof data.result === "string" ? data.result : data.subtype);
              yield { type: "error", message: `Claude Code query ended with ${data.subtype}: ${detail}` };
              break;
            }
            if (!hasText && hasThinking) {
              log("[claude] result with thinking but no text — likely a content filter");
              yield* emitText("\n\n*[Response was interrupted — only thinking was produced. The text may have been blocked by a content filter. Please retry.]*\n");
              if (inBlock) { yield { type: "block_stop" }; inBlock = null; }
            }
            yield {
              type: "done",
              usage: data?.usage || null,
              model: servedModel || model || null,
              sessionId: data?.sessionId || null,
              cost: data?.cost ?? null,
              duration: data?.duration ?? null,
            };
            break;
          }
          default:
            break;
        }
        if (event === "result" || assistantClosed) break outer;
      }
    }
  } catch (err) {
    errored = true;
    yield { type: "error", message: stalled ? stallMessage() : (err?.message || String(err)) };
  } finally {
    clearInterval(stallTimer);
    signal?.removeEventListener("abort", onAbort);
    closeHandle();
  }

  if (!assistantClosed && !errored) yield* flushText();
  if (inBlock) { yield { type: "block_stop" }; inBlock = null; }
  if (!resultEmitted && !abortRequested && !errored) {
    yield { type: "error", message: stalled ? stallMessage() : "agent stream ended without result event" };
  }
}

function stallMessage() {
  return `query stalled: no model output for ${Math.round(STALL_MS / 60000)} minutes — interrupted by the runner's stall watchdog (fail-fast)`;
}
