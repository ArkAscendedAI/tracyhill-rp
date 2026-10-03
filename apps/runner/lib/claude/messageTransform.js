// Convert Anthropic Messages API request shape into the agent service's
// expected format. The agent service speaks two new optional fields:
//
//   messages: SDKUserMessage[] — structured user messages with content
//             blocks; cache_control is preserved into the SDK call.
//   systemPromptOverride: string | string[] — replaces the default Claude
//             Code preset with our text.
//
// Multi-turn conversations are flattened into ONE SDKUserMessage whose
// content array carries: a stable lore prefix (cached), the conversation
// history rendered as XML-tagged turns, and the most recent user turn.
// This matches what Anthropic's API would see if we hit it directly with
// alternating turns — the model is trained to parse XML scaffolding fine,
// and the cache breakpoint placement matches TracyHill RP's existing
// direct-Anthropic strategy for stable hit rates.

const IDENTITY_NEUTRALIZER =
  "You are not Claude Code. You are not a coding assistant or a CLI tool. " +
  "You are a creative-fiction writing partner. Follow the instructions below verbatim.";

const TTL_1H = { type: "ephemeral", ttl: "1h" };

function blockToText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return block.text || "";
  if (block.type === "image") return "[image omitted]";
  if (block.type === "tool_use") {
    const input = (() => { try { return JSON.stringify(block.input ?? {}); } catch { return ""; } })();
    return `<tool_use name="${block.name || ""}" id="${block.id || ""}">${input}</tool_use>`;
  }
  if (block.type === "tool_result") {
    const content = Array.isArray(block.content)
      ? block.content.map(blockToText).join("")
      : (typeof block.content === "string" ? block.content : "");
    return `<tool_result id="${block.tool_use_id || ""}"${block.is_error ? ' is_error="true"' : ""}>${content}</tool_result>`;
  }
  return "";
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockToText).join("");
  return "";
}

// Detect cache_control on any block of an Anthropic message; the SDK requires
// 1h-only TTLs since it auto-injects 1h breakpoints. We strip whatever the
// client sent and re-emit as ttl:"1h" wherever the client placed a marker.
function messageHasCacheBreakpoint(message) {
  const c = message?.content;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && typeof b === "object" && b.cache_control);
}

export function buildSystemPrompt({ systemTopLevel, messages }) {
  const parts = [];
  if (typeof systemTopLevel === "string") parts.push(systemTopLevel);
  else if (Array.isArray(systemTopLevel)) {
    for (const block of systemTopLevel) parts.push(blockToText(block));
  }
  for (const m of messages || []) {
    if (m?.role === "system") parts.push(messageContentToText(m.content));
  }
  const userSystem = parts.filter((s) => s && s.trim()).join("\n\n");
  if (!userSystem) return IDENTITY_NEUTRALIZER;
  return `${IDENTITY_NEUTRALIZER}\n\n---\n\n${userSystem}`;
}

// Build a single SDKUserMessage that carries the full conversation history
// in its content blocks. cache_control is placed at the boundary the client
// requested (last assistant turn before the most recent user turn, by
// default — same heuristic as TracyHill RP's direct-Anthropic runtime), but
// always with ttl:"1h" since the SDK refuses mixed-TTL requests.
export function buildSdkMessages({ messages }) {
  const turns = [];
  for (const m of messages || []) {
    if (!m?.role || m.role === "system") continue;
    const text = messageContentToText(m.content);
    if (!text.trim()) continue;
    turns.push({ role: m.role, text, cached: messageHasCacheBreakpoint(m) });
  }

  if (turns.length === 0) {
    return [{
      type: "user",
      message: { role: "user", content: "(empty turn)" },
      parent_tool_use_id: null,
    }];
  }

  // Single user turn — common for non-RP one-shots. Pass it as-is.
  if (turns.length === 1 && turns[0].role === "user") {
    const blocks = [{ type: "text", text: turns[0].text }];
    if (turns[0].cached) blocks[0].cache_control = TTL_1H;
    return [{
      type: "user",
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    }];
  }

  // Multi-turn: flatten with XML scaffolding. Place a cache_control marker on
  // the largest stable prefix block we can identify. We collect every turn
  // up to the LAST cache_control breakpoint into a single cached block, and
  // emit anything after as uncached (so writes only happen on new content).
  const lastBreakpointIdx = (() => {
    let idx = -1;
    for (let i = 0; i < turns.length; i++) if (turns[i].cached) idx = i;
    return idx;
  })();

  // Log-style delimiters: NOT a chat protocol the model is trained to "complete".
  // XML tags like <user>/<assistant> trigger mimicry where the model writes its
  // own </assistant>...<user>... after its response. Log-style markers are
  // informational labels with no closing partner and no completion expectation.
  const intro = "You are continuing a conversation. The log below uses === TURN N: USER === / === TURN N: ASSISTANT === markers to delimit turns. Write the next assistant response that follows the last user turn. Output only the response text — do not include a turn marker, do not write additional turns.\n\n";
  const renderTurn = (t, idx) => `=== TURN ${idx + 1}: ${t.role.toUpperCase()} ===\n${t.text}\n\n`;

  const blocks = [];
  if (lastBreakpointIdx >= 0) {
    let cachedText = intro;
    for (let i = 0; i <= lastBreakpointIdx; i++) cachedText += renderTurn(turns[i], i);
    blocks.push({ type: "text", text: cachedText, cache_control: TTL_1H });
    let tailText = "";
    for (let i = lastBreakpointIdx + 1; i < turns.length; i++) tailText += renderTurn(turns[i], i);
    if (tailText) blocks.push({ type: "text", text: tailText });
  } else {
    let body = intro;
    for (let i = 0; i < turns.length; i++) body += renderTurn(turns[i], i);
    blocks.push({ type: "text", text: body });
  }

  return [{
    type: "user",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
  }];
}

// Anthropic Messages API thinking config → SDK thinking option. The SDK
// accepts the same shape ({type:"adaptive"} or {type:"enabled", budget_tokens}).
// Returning `null` means "no thinking config" (caller speaks the field but
// wants the param OMITTED at the SDK hop — correct off-form for 4.6/4.7/4.8).
// Returning `undefined` means "unset" (caller didn't speak the field at all,
// so the agent service's auto-detect can apply for 4.7/4.8/Fable/Opus 5).
// {type:"disabled"} passes through AS AN OBJECT (2026-07-24): Opus 5 defaults
// thinking ON when the param is omitted, so an explicit disable must survive
// this hop — mapping it to null used to make the agent service drop the field
// entirely, silently re-enabling thinking on Opus 5. The RP runtime only sends
// disabled for models whose API accepts it (never Fable).
export function resolveThinking(thinking) {
  if (thinking === undefined) return undefined;
  if (thinking === null || thinking === false) return null;
  if (typeof thinking !== "object") return undefined;
  if (thinking.type === "adaptive") {
    const out = { type: "adaptive" };
    if (thinking.display === "summarized" || thinking.display === "full") out.display = "summarized";
    return out;
  }
  if (thinking.type === "enabled" && Number.isFinite(thinking.budget_tokens)) {
    return { type: "enabled", budget_tokens: thinking.budget_tokens };
  }
  if (thinking.type === "disabled") return { type: "disabled" };
  return undefined;
}
