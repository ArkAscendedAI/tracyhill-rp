import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ClaudeCodeMessage } from "@tracyhill-rp/contracts";

import { getClaudeCodeMessages, getClaudeCodeStatus, streamClaudeCodeSession } from "./claudeCodeApi";

export type StreamToolState = {
  id?: string;
  tool?: string;
  input?: string;
  elapsed?: number;
};

export type PendingQuestion = {
  id: string;
  questions: Array<{ question: string; options?: Array<{ label: string }> }>;
};

export type ModeTransition = {
  at: number;
  mode: string;
  reason?: string;
  modelInitiated?: boolean;
};

export type TaskItem = {
  taskId: string;
  description?: string;
  subagentType?: string;
  status: string; // running | completed | failed | stopped
  toolUseId?: string;
};

export type PendingPlan = {
  id: string;
  plan: string | null;
  allowedPrompts: unknown[] | null;
};

export type PromptSuggestion = string;

export type ClaudeCodeContext = {
  totalTokens: number;
  maxTokens: number;
  percentage?: number;
  model?: string;
  categories: Array<{ name: string; tokens: number; color?: string }>;
};

export type ClaudeCodeStreamState = {
  messages: ClaudeCodeMessage[];
  streaming: boolean;
  streamText: string;
  streamThinking: string;
  streamTools: StreamToolState[];
  activeToolId: string | null;
  connHealth: "connected" | "reconnecting" | "stale" | null;
  queryKey: string | null;
  error: string | null;
  sessionMeta: { model?: string; cwd?: string; sessionId?: string; mode?: string; slashCommands?: string[]; skills?: string[]; researchBash?: boolean } | null;
  pendingQuestion: PendingQuestion | null;
  modeTransitions: ModeTransition[];
  currentMode: string;
  // v2 additions
  tasks: TaskItem[];
  suggestions: PromptSuggestion[];
  pendingPlan: PendingPlan | null;
  context: ClaudeCodeContext | null;
  streamTick: number;
};

const INITIAL: ClaudeCodeStreamState = {
  messages: [],
  streaming: false,
  streamText: "",
  streamThinking: "",
  streamTools: [],
  activeToolId: null,
  connHealth: null,
  queryKey: null,
  error: null,
  sessionMeta: null,
  pendingQuestion: null,
  modeTransitions: [],
  // Empty so consumers' `state.currentMode || pickerMode` fallback works —
  // "normal" here masked the user's plan/research selection until the first
  // server system event.
  currentMode: "",
  tasks: [],
  suggestions: [],
  pendingPlan: null,
  context: null,
  streamTick: 0,
};

export function useClaudeCodeStream(sessionId: string | null) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ClaudeCodeStreamState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const healthTimerRef = useRef<number | null>(null);
  const lastEventIdxRef = useRef(-1);
  const staleReconnectRef = useRef<(() => void) | null>(null);

  const patch = useCallback((p: Partial<ClaudeCodeStreamState>) => setState((c) => ({ ...c, ...p })), []);

  // SSE deltas arrive far faster than the display refreshes. Buffer
  // text/thinking/input deltas in refs and apply them in ONE setState per
  // animation frame — ≤1 React render per frame regardless of chunk rate.
  // Non-delta events flush the buffer synchronously first so ordering between
  // deltas and structural events (tool_start, consolidated blocks…) is exact.
  const pendingDeltasRef = useRef({ text: "", thinking: "", input: "" });
  const rafRef = useRef<number | null>(null);

  const applyPendingDeltas = useCallback(() => {
    rafRef.current = null;
    const p = pendingDeltasRef.current;
    if (!p.text && !p.thinking && !p.input) return;
    pendingDeltasRef.current = { text: "", thinking: "", input: "" };
    setState((c) => ({
      ...c,
      streamTick: c.streamTick + 1,
      streamText: p.text ? c.streamText + p.text : c.streamText,
      streamThinking: p.thinking ? c.streamThinking + p.thinking : c.streamThinking,
      streamTools: p.input
        ? c.streamTools.map((t) => (t.id === c.activeToolId ? { ...t, input: (t.input ?? "") + p.input } : t))
        : c.streamTools,
    }));
  }, []);

  const scheduleDeltaFlush = useCallback(() => {
    if (rafRef.current == null) rafRef.current = window.requestAnimationFrame(applyPendingDeltas);
  }, [applyPendingDeltas]);

  const flushDeltasNow = useCallback(() => {
    if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    applyPendingDeltas();
  }, [applyPendingDeltas]);

  const disconnect = useCallback(() => {
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
    if (reconnectTimerRef.current) { window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (healthTimerRef.current) { window.clearTimeout(healthTimerRef.current); healthTimerRef.current = null; }
    if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    pendingDeltasRef.current = { text: "", thinking: "", input: "" };
  }, []);

  const resetHealthTimer = useCallback(() => {
    if (healthTimerRef.current) window.clearTimeout(healthTimerRef.current);
    healthTimerRef.current = window.setTimeout(() => {
      // Only act if this connection is still live. A cleanly-closed stream (a
      // completed/idle session) nulls abortRef in the .then — without this gate
      // the timer kept firing and reconnecting a done session every 30s, and
      // since the reconnect replays from -1 it re-appended the whole transcript
      // each cycle (endless message duplication).
      if (!abortRef.current) return;
      patch({ connHealth: "stale" });
      staleReconnectRef.current?.();
    }, 30_000);
  }, [patch]);

  const connectToStream = useCallback((key: string, after: number) => {
    disconnect();
    // A full replay (after === -1) rebuilds the transcript from the start, so
    // clear the message + live buffers first. Without this, any -1 reconnect
    // (next turn, stale recovery) APPENDS a second copy of every event onto the
    // existing array. Mid-stream reconnects (after >= 0) keep the array intact.
    if (after === -1) {
      setState((c) => ({
        ...c,
        messages: [], streamText: "", streamThinking: "", streamTools: [],
        activeToolId: null, pendingQuestion: null, pendingPlan: null,
        tasks: [], suggestions: [],
      }));
    }
    patch({ connHealth: "connected", streaming: true, queryKey: key });
    const abort = new AbortController();
    abortRef.current = abort;
    resetHealthTimer();

    // Per-connection cursor: each query's _idx restarts at 0 server-side, so a
    // stale ref clamped upward by Math.max made mid-stream reconnects ask for
    // after=<old query's count> and permanently skip the new transcript.
    lastEventIdxRef.current = after;
    staleReconnectRef.current = () => connectToStream(key, lastEventIdxRef.current);

    void streamClaudeCodeSession(key, after, (event) => {
      resetHealthTimer();
      if (event._idx !== undefined) lastEventIdxRef.current = event._idx;

      // Delta events: buffer + schedule one flush per animation frame.
      if (event.type === "text_delta") { pendingDeltasRef.current.text += event.text || ""; scheduleDeltaFlush(); return; }
      if (event.type === "thinking_delta") { pendingDeltasRef.current.thinking += event.text || ""; scheduleDeltaFlush(); return; }
      if (event.type === "input_delta") { pendingDeltasRef.current.input += event.text || ""; scheduleDeltaFlush(); return; }
      // Everything else is structural: apply buffered deltas first so order holds.
      flushDeltasNow();

      if (event.type === "system" && event.sessionId) {
        setState((c) => ({
          ...c,
          sessionMeta: {
            model: event.model, cwd: event.cwd, sessionId: event.sessionId, mode: event.mode,
            slashCommands: event.slashCommands, skills: event.skills,
          },
          currentMode: event.mode ?? c.currentMode,
        }));
        void queryClient.invalidateQueries({ queryKey: ["claude-code-sessions"] });
        return;
      }
      if (event.type === "question" && event.id) {
        setState((c) => ({
          ...c,
          pendingQuestion: { id: event.id!, questions: (event.questions as PendingQuestion["questions"]) ?? [] },
        }));
        return;
      }
      if (event.type === "question_answered" && event.id) {
        // Clear the live card when answered, and append the answered record so
        // replay (and the timeline) shows the resolved Q→A inline.
        setState((c) => ({
          ...c,
          pendingQuestion: c.pendingQuestion?.id === event.id ? null : c.pendingQuestion,
          messages: [...c.messages, event as ClaudeCodeMessage],
        }));
        return;
      }
      if (event.type === "mode_change" && event.mode) {
        setState((c) => ({
          ...c,
          currentMode: event.mode!,
          sessionMeta: c.sessionMeta ? { ...c.sessionMeta, mode: event.mode, ...(event.researchBash !== undefined ? { researchBash: event.researchBash } : {}) } : c.sessionMeta,
          modeTransitions: [...c.modeTransitions, { at: Date.now(), mode: event.mode!, reason: event.reason, modelInitiated: event.model_initiated }],
        }));
        return;
      }
      if (event.type === "model_change" && event.model) {
        setState((c) => ({ ...c, sessionMeta: c.sessionMeta ? { ...c.sessionMeta, model: event.model } : c.sessionMeta }));
        return;
      }
      if (event.type === "plan_ready" && event.id) {
        setState((c) => ({ ...c, pendingPlan: { id: event.id!, plan: event.plan ?? null, allowedPrompts: (event.allowedPrompts as unknown[]) ?? null } }));
        return;
      }
      if (event.type === "plan_approved" || event.type === "plan_rejected") {
        setState((c) => ({ ...c, pendingPlan: null }));
        return;
      }
      if (event.type === "task_started" || event.type === "task_progress" || event.type === "task_updated") {
        setState((c) => {
          const tasks = c.tasks.slice();
          const i = tasks.findIndex((t) => t.taskId === event.taskId);
          const next: TaskItem = { taskId: event.taskId!, description: event.description, subagentType: event.subagentType, toolUseId: event.toolUseId, status: "running" };
          if (i >= 0) tasks[i] = { ...tasks[i], ...next, status: tasks[i]!.status === "running" ? "running" : tasks[i]!.status };
          else tasks.push(next);
          return { ...c, tasks };
        });
        return;
      }
      if (event.type === "task_notification" && event.taskId) {
        setState((c) => ({ ...c, tasks: c.tasks.map((t) => (t.taskId === event.taskId ? { ...t, status: event.status ?? "completed" } : t)) }));
        return;
      }
      if (event.type === "compact_boundary") {
        setState((c) => ({ ...c, messages: [...c.messages, { ...event, type: "compact_boundary" } as ClaudeCodeMessage] }));
        return;
      }
      if (event.type === "context_usage") {
        setState((c) => ({ ...c, context: { totalTokens: event.totalTokens ?? 0, maxTokens: event.maxTokens ?? 0, percentage: event.percentage, model: event.model, categories: (event.categories as ClaudeCodeContext["categories"]) ?? [] } }));
        return;
      }
      if (event.type === "suggestion" && event.text) {
        setState((c) => ({ ...c, suggestions: [...c.suggestions, event.text!] }));
        return;
      }
      if (event.type === "model_fallback") {
        setState((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage] }));
        return;
      }
      if (event.type === "rewind") {
        // Surface as a transient toast via messages
        const summary = `↶ Rewind ${event.dryRun ? "(dry run) " : ""}— ${event.filesChanged?.length ?? 0} files, +${event.insertions ?? 0}/−${event.deletions ?? 0}`;
        setState((c) => ({ ...c, messages: [...c.messages, { type: "system", content: summary } as ClaudeCodeMessage] }));
        return;
      }
      if (event.type === "thinking_start") { setState((c) => ({ ...c, streamThinking: "" })); return; }
      if (event.type === "tool_start") {
        setState((c) => ({
          ...c,
          streamTools: [...c.streamTools, { id: event.id, tool: event.tool, input: "" }],
          activeToolId: event.id ?? null,
        }));
        return;
      }
      if (event.type === "tool_progress") {
        setState((c) => ({
          ...c,
          streamTools: c.streamTools.map((t) =>
            t.id === event.id ? { ...t, elapsed: event.elapsed, tool: event.tool ?? t.tool } : t,
          ),
        }));
        return;
      }
      if (event.type === "done") {
        // v2: messages already hold the canonical transcript from streamed
        // consolidated events (text/thinking/tool_use/tool_result/result) PLUS
        // panel-only events (question_answered, compact_boundary). We no longer
        // reload from getClaudeCodeMessages — that SDK projection would drop the
        // panel-only events. The JSONL replay (after=-1) is the source of truth
        // when an old session is reopened.
        setState((c) => ({
          ...c,
          streaming: false,
          streamText: "",
          streamThinking: "",
          streamTools: [],
          activeToolId: null,
          connHealth: null,
          queryKey: null,
          pendingPlan: null,
        }));
        lastEventIdxRef.current = -1;
        void queryClient.invalidateQueries({ queryKey: ["claude-code-sessions"] });
        return;
      }
      if (event.type === "error") {
        setState((c) => ({ ...c, error: event.message ?? "Claude Code error" }));
        return;
      }
      if (event.type === "result") {
        // Without this branch /cost was always empty, the context meter stuck
        // at 0, ResultTurn never rendered, and plan-mode approve/execute was
        // unreachable (planReady requires a trailing result turn).
        setState((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage] }));
        return;
      }
      // Consolidated block events arrive when each assistant message completes;
      // PRUNE the matching live-delta buffers or completed blocks render twice
      // (live + persisted) for the rest of an agentic turn.
      if (event.type === "text") {
        setState((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage], streamText: "" }));
        return;
      }
      if (event.type === "thinking") {
        setState((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage], streamThinking: "" }));
        return;
      }
      if (event.type === "tool_use") {
        setState((c) => ({
          ...c,
          messages: [...c.messages, event as ClaudeCodeMessage],
          streamTools: c.streamTools.filter((t) => t.id !== (event as { id?: string }).id),
        }));
        return;
      }
      // Persisted tool_result events (replay), append to messages
      if (event.type === "tool_result") {
        setState((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage] }));
        return;
      }
      // User events (live + replay). Control-only events (/compact) are not
      // shown as user turns. A real user turn starts a fresh turn, so clear
      // stale suggestions.
      if (event.type === "user") {
        if (event.control) return;
        setState((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage], suggestions: [] }));
        return;
      }
    }, abort.signal)
      .then(() => { if (abortRef.current === abort) abortRef.current = null; })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          patch({ streaming: false, connHealth: null });
          return;
        }
        if (abortRef.current !== abort) return;
        patch({ connHealth: "reconnecting" });
        reconnectTimerRef.current = window.setTimeout(() => connectToStream(key, lastEventIdxRef.current), 2_000);
      });
  }, [disconnect, patch, queryClient, resetHealthTimer, sessionId, flushDeltasNow, scheduleDeltaFlush]);

  useEffect(() => {
    if (!sessionId) { setState(INITIAL); disconnect(); return; }
    let cancelled = false;
    setState({ ...INITIAL });
    void (async () => {
      try {
        const status = await getClaudeCodeStatus(sessionId);
        if (cancelled) return;
        if (status.active || status.status === "error" || status.status === "complete") {
          lastEventIdxRef.current = -1;
          connectToStream(status.queryKey || sessionId, -1);
          return;
        }
      } catch {}
      if (cancelled) return;
      try {
        const msgs = await getClaudeCodeMessages(sessionId);
        if (!cancelled) setState((c) => ({ ...c, messages: msgs }));
      } catch (error) {
        if (!cancelled) setState((c) => ({ ...c, error: error instanceof Error ? error.message : "Unable to load session" }));
      }
    })();
    return () => { cancelled = true; disconnect(); };
  }, [sessionId, connectToStream, disconnect]);

  useEffect(() => () => disconnect(), [disconnect]);

  return { state, connectToStream, disconnect, setState };
}
