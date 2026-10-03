import type { ClaudeCodeMessage } from "@tracyhill-rp/contracts";

// ─── Turn grouping ───────────────────────────────────────────────────────────

export type AssistantBlock =
  | { kind: "thinking"; content: string; live?: boolean }
  // model = serving model the SDK reported for this response (stamped by the
  // agent service). Used to badge turns served by a different model than requested.
  | { kind: "text"; content: string; model?: string; live?: boolean }
  | { kind: "tool"; tool: string; input: unknown; id: string; result?: string; live?: boolean; elapsed?: number; children?: AssistantBlock[] };

export type AnsweredQuestion = { question: string; answer: string };

export type Turn =
  | { role: "user"; content: string; userMessageId?: string }
  // userMessageId = the uuid of the user message that opened this turn, so each
  // turn's Revert chip rewinds to ITS OWN checkpoint (not the last turn's).
  | { role: "assistant"; blocks: AssistantBlock[]; userMessageId?: string }
  | { role: "error"; message: string }
  | { role: "system"; content: string }
  | { role: "compact"; trigger?: string; preTokens?: number; postTokens?: number }
  | { role: "fallback"; category?: string | null; explanation?: string | null }
  | { role: "answered"; questions: AnsweredQuestion[] }
  | { role: "result"; sessionId?: string; turns?: number; cost?: number; duration?: number; stopReason?: string | null; category?: string | null; explanation?: string | null };

export function messagesToTurns(messages: ClaudeCodeMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  // Every tool block by id (top-level AND nested) so tool_result and
  // parent_tool_use_id lookups route to the right block. Never cleared: ids are
  // unique per session and a result can arrive after the next user turn.
  const allTools = new Map<string, AssistantBlock & { kind: "tool" }>();
  const openQuestions = new Map<string, Array<{ question: string }>>();
  // The uuid of the most-recent user message — assistant turns inherit it as
  // their per-turn Revert checkpoint.
  let currentUserMessageId: string | undefined;

  const openAssistant = () => {
    if (!cur || cur.role !== "assistant") {
      if (cur) turns.push(cur);
      cur = { role: "assistant", blocks: [], userMessageId: currentUserMessageId };
    }
    return cur as Turn & { role: "assistant"; blocks: AssistantBlock[] };
  };
  // Where does a block belong — a parent Task tool's children, or top level?
  const sink = (parentId: string | null | undefined): AssistantBlock[] => {
    if (parentId) {
      const parent = allTools.get(parentId);
      if (parent) { parent.children ??= []; return parent.children; }
    }
    return openAssistant().blocks;
  };

  for (const msg of messages) {
    const parentId = (msg.parentToolUseId as string | null | undefined) ?? null;
    if (msg.type === "user") {
      if (cur) turns.push(cur);
      currentUserMessageId = msg.uuid;
      turns.push({ role: "user", content: msg.content ?? "", userMessageId: msg.uuid });
      cur = null;
    } else if (msg.type === "thinking") {
      sink(parentId).push({ kind: "thinking", content: msg.content ?? "" });
    } else if (msg.type === "text") {
      sink(parentId).push({ kind: "text", content: msg.content ?? "", model: msg.model });
    } else if (msg.type === "tool_use") {
      // Its `userMessageId` is NOT a checkpoint: the agent service stamps its
      // last tool-result uuid there, which the CLI's rewind refuses (see
      // revert.ts). The turn keeps the user message's own uuid.
      const block: AssistantBlock & { kind: "tool" } = { kind: "tool", tool: msg.tool ?? "unknown", input: msg.input ?? {}, id: msg.id ?? "" };
      sink(parentId).push(block);
      allTools.set(msg.id ?? "", block);
    } else if (msg.type === "tool_result") {
      const block = allTools.get(msg.id ?? "");
      if (block) block.result = msg.output ?? "";
    } else if (msg.type === "question") {
      if (msg.id) openQuestions.set(msg.id, (msg.questions as Array<{ question: string }>) ?? []);
    } else if (msg.type === "question_answered") {
      const qs = msg.id ? openQuestions.get(msg.id) : null;
      const ans = (msg.answers as Record<string, string> | null) ?? null;
      if (qs && ans) {
        if (cur) { turns.push(cur); cur = null; }
        turns.push({ role: "answered", questions: qs.map((q) => ({ question: q.question, answer: ans[q.question] ?? "—" })) });
      }
    } else if (msg.type === "model_fallback") {
      if (cur) { turns.push(cur); cur = null; }
      turns.push({ role: "fallback", category: (msg.category as string | null) ?? null, explanation: (msg.explanation as string | null) ?? null });
    } else if (msg.type === "compact_boundary") {
      if (cur) { turns.push(cur); cur = null; }
      turns.push({ role: "compact", trigger: msg.trigger as string | undefined, preTokens: msg.preTokens as number | undefined, postTokens: msg.postTokens as number | undefined });
    } else if (msg.type === "error") {
      if (cur) { turns.push(cur); cur = null; }
      turns.push({ role: "error", message: msg.message ?? msg.content ?? "Error" });
    } else if (msg.type === "mode_change" && typeof msg.mode === "string") {
      // Permission-mode transitions are transcript notices:
      // the footer pill shows the CURRENT mode, this shows WHEN and
      // WHY it changed — a Claude-initiated switch (plan approval → execute)
      // is otherwise invisible in the scrollback.
      if (cur) { turns.push(cur); cur = null; }
      turns.push({ role: "system", content: modeChangeNotice(msg.mode, msg.reason as string | undefined, msg.model_initiated as boolean | undefined) });
    } else if (msg.type === "system" && msg.content) {
      // System notes with content (rewind summaries etc.). Init events carry
      // no content and are handled at the stream layer — skipped here.
      if (cur) { turns.push(cur); cur = null; }
      turns.push({ role: "system", content: msg.content });
    } else if (msg.type === "result") {
      if (cur) { turns.push(cur); cur = null; }
      turns.push({
        role: "result", sessionId: msg.sessionId, turns: msg.turns, cost: msg.cost, duration: msg.duration,
        stopReason: msg.stopReason ?? null, category: (msg.category as string | null) ?? null, explanation: (msg.explanation as string | null) ?? null,
      });
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

export function modeChangeNotice(mode: string, reason?: string, modelInitiated?: boolean): string {
  const icon = mode === "plan" || mode === "research" ? "🔎"
    : mode === "execute" || mode === "acceptEdits" || mode === "bypassPermissions" ? "⚡"
    : mode === "auto" ? "🤖" : "⚙";
  const who = modelInitiated ? "Claude switched to" : "Switched to";
  const label = mode === "research" || mode === "plan" ? "Research & Planning" : mode === "execute" || mode === "bypassPermissions" ? "Full Execution" : mode;
  return `${icon} ${who} ${label}${reason ? ` — ${reason}` : ""}`;
}

// ─── Live-buffer merge ───────────────────────────────────────────────────────

export type LiveBuffers = {
  streamText: string;
  streamThinking: string;
  streamTools: Array<{ id?: string; tool?: string; input?: string; elapsed?: number }>;
};

/**
 * Append the in-flight stream buffers as live blocks INTO the trailing
 * assistant turn (opening one if needed), so live and persisted content render
 * through one uniform component tree. When a block consolidates (the server
 * sends the completed `text`/`thinking`/`tool_use` message and clears the
 * buffer), the same content re-renders at the same position — no separate
 * "live turn" swap, no flicker.
 */
export function mergeLive(turns: Turn[], live: LiveBuffers): Turn[] {
  const hasLive = live.streamText || live.streamThinking || live.streamTools.length > 0;
  if (!hasLive) return turns;
  const merged = turns.slice();
  const last = merged[merged.length - 1];
  let blocks: AssistantBlock[];
  if (last && last.role === "assistant") {
    blocks = [...last.blocks];
    merged[merged.length - 1] = { role: "assistant", blocks, userMessageId: last.userMessageId };
  } else {
    blocks = [];
    // Inherit the trailing user turn's checkpoint so the live turn's Revert
    // targets its own user message.
    const lastUser = last && last.role === "user" ? last.userMessageId : undefined;
    merged.push({ role: "assistant", blocks, userMessageId: lastUser });
  }
  if (live.streamThinking) blocks.push({ kind: "thinking", content: live.streamThinking, live: true });
  if (live.streamText) blocks.push({ kind: "text", content: live.streamText, live: true });
  for (const t of live.streamTools) {
    blocks.push({ kind: "tool", tool: t.tool ?? "tool", input: t.input ?? "", id: t.id ?? "", live: true, elapsed: t.elapsed });
  }
  return merged;
}
