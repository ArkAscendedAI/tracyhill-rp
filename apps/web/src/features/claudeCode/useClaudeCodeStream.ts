import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ClaudeCodeMessage } from "@tracyhill-rp/contracts";

import { getClaudeCodeMessages, getClaudeCodeSessions, getClaudeCodeStatus, streamClaudeCodeSession } from "./claudeCodeApi";
import { useCodingBackend } from "./backend";
import { ApiError } from "../../shared/api/client";
import { decideStreamClose, nextTerminalFlag } from "./streamLifecycle";

type StreamToolState = {
  id?: string;
  tool?: string;
  input?: string;
  elapsed?: number;
};

export type PendingQuestion = {
  id: string;
  questions: Array<{ question: string; options?: Array<{ label: string }> }>;
};

// Background (async) subagent tasks — `task_started/progress/updated` open or
// refresh one, `task_notification` closes it. Rendered as the transcript's
// background-task strip while running; the completion summary joins the
// transcript as a system notice.
type TaskItem = {
  taskId: string;
  description?: string;
  subagentType?: string;
  status: string; // running | completed | failed | stopped
  toolUseId?: string;
};

type PendingPlan = {
  id: string;
  plan: string | null;
  allowedPrompts: unknown[] | null;
};

type PromptSuggestion = string;

type ClaudeCodeContext = {
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
  // "offline" = the server refused the subscription (401/403/404); the hook
  // resumes from its cursor when the session list loads again.
  connHealth: "reconnecting" | "stale" | "offline" | null;
  queryKey: string | null;
  sessionMeta: { queryKey?: string; model?: string; cwd?: string; sessionId?: string; mode?: string; slashCommands?: string[]; skills?: string[]; researchBash?: boolean } | null;
  pendingQuestion: PendingQuestion | null;
  // Mode transitions are transcript turns now (`mode_change` messages →
  // turns.ts system notice), not a side array.
  currentMode: string;
  // v2 additions
  tasks: TaskItem[];
  suggestions: PromptSuggestion[];
  pendingPlan: PendingPlan | null;
  context: ClaudeCodeContext | null;
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
  sessionMeta: null,
  pendingQuestion: null,
  // Empty so consumers' `state.currentMode || pickerMode` fallback works —
  // "normal" here masked the user's plan/research selection until the first
  // server system event.
  currentMode: "",
  tasks: [],
  suggestions: [],
  pendingPlan: null,
  context: null,
};

type Mutator = (s: ClaudeCodeStreamState) => ClaudeCodeStreamState;

// Task statuses that end a background task when carried by a task_* event
// (the notification path applies its own `status`).
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "stopped", "killed"]);

export function useClaudeCodeStream(sessionId: string | null) {
  const { apiBase, sessionsKey } = useCodingBackend();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ClaudeCodeStreamState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const healthTimerRef = useRef<number | null>(null);
  const lastEventIdxRef = useRef(-1);
  const staleReconnectRef = useRef<(() => void) | null>(null);
  // Reconnect backoff: count consecutive failures; reset once data flows again.
  const reconnectAttemptsRef = useRef(0);
  // A subscription the server refused (401/403/404): remembered so it resumes
  // from the cursor once the session list loads again, i.e. after the user
  // unlocked the lapsed session.
  const stoppedForAccessRef = useRef<{ key: string; status: number } | null>(null);
  // Bumped by reattach(): re-runs the status probe + connect for the current
  // session (a click on the already-selected rail row).
  const [attachEpoch, setAttachEpoch] = useState(0);
  // The session id the live connection's `system` event reported, so adopting
  // a brand-new session's id keeps that connection.
  const connectedSessionRef = useRef<string | null>(null);
  // Session-list refreshes are coalesced: an after=-1 replay of an N-turn
  // session carries N `system` and N `done` frames in a few chunks, and one
  // invalidateQueries per frame restarted the rail's fetch N times.
  const refreshTimerRef = useRef<number | null>(null);
  const refreshSessionsSoon = useCallback(() => {
    if (refreshTimerRef.current != null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void queryClient.invalidateQueries({ queryKey: [sessionsKey] });
    }, 120);
  }, [queryClient, sessionsKey]);

  const patch = useCallback((p: Partial<ClaudeCodeStreamState>) => setState((c) => ({ ...c, ...p })), []);

  // ── Per-frame batching ──────────────────────────────────────────────────
  // SSE events arrive far faster than the display refreshes — and a full replay
  // (after=-1) of a long session pours THOUSANDS of consolidated events in at
  // once. Applying one setState per event re-derives the whole turn tree and
  // re-renders every turn each time (O(N²)) — that was the "playing through all
  // the events" lag on reopening a big session. So we coalesce BOTH the live
  // text/thinking/input deltas (string buffers) AND every structural state
  // change (message appends, tool/task updates, etc.) into a SINGLE setState per
  // animation frame: deltas apply first, then the queued mutators in arrival
  // order. Net effect: ≤1 render per frame regardless of event rate, with the
  // transcript (built from messages[]) always exactly correct.
  const pendingDeltasRef = useRef({ text: "", thinking: "", input: "" });
  const pendingMutatorsRef = useRef<Mutator[]>([]);
  const rafRef = useRef<number | null>(null);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const d = pendingDeltasRef.current;
    const muts = pendingMutatorsRef.current;
    const hasDeltas = d.text || d.thinking || d.input;
    if (!hasDeltas && muts.length === 0) return;
    pendingDeltasRef.current = { text: "", thinking: "", input: "" };
    pendingMutatorsRef.current = [];
    setState((c) => {
      let next = hasDeltas
        ? {
            ...c,
            streamText: d.text ? c.streamText + d.text : c.streamText,
            streamThinking: d.thinking ? c.streamThinking + d.thinking : c.streamThinking,
            streamTools: d.input
              ? c.streamTools.map((t) => (t.id === c.activeToolId ? { ...t, input: (t.input ?? "") + d.input } : t))
              : c.streamTools,
          }
        : c;
      for (const m of muts) next = m(next);
      return next;
    });
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current == null) rafRef.current = window.requestAnimationFrame(flushPending);
  }, [flushPending]);

  const flushNow = useCallback(() => {
    if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    flushPending();
  }, [flushPending]);

  // Queue a structural state change for the next frame's batched flush.
  const enqueue = useCallback((m: Mutator) => {
    pendingMutatorsRef.current.push(m);
    schedule();
  }, [schedule]);

  const clearPending = useCallback(() => {
    if (rafRef.current != null) { window.cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    pendingDeltasRef.current = { text: "", thinking: "", input: "" };
    pendingMutatorsRef.current = [];
  }, []);

  const disconnect = useCallback(() => {
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
    if (reconnectTimerRef.current) { window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (healthTimerRef.current) { window.clearTimeout(healthTimerRef.current); healthTimerRef.current = null; }
    clearPending();
  }, [clearPending]);

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
    // Commit any buffered deltas/mutators BEFORE disconnect() cancels the pending
    // frame — otherwise a mid-stream reconnect (after >= 0) silently drops the
    // last chunks. On a full replay (after === -1) the buffers are
    // cleared below anyway.
    flushNow();
    disconnect();
    // A full replay (after === -1) rebuilds the transcript from the start, so
    // clear the message + live buffers first. Without this, any -1 reconnect
    // (next turn, stale recovery) APPENDS a second copy of every event onto the
    // existing array. Mid-stream reconnects (after >= 0) keep the array intact.
    if (after === -1) {
      clearPending(); // drop any queued mutators from the prior connection
      setState((c) => ({
        ...c,
        messages: [], streamText: "", streamThinking: "", streamTools: [],
        activeToolId: null, pendingQuestion: null, pendingPlan: null,
        tasks: [], suggestions: [],
        // Errors and mode-change notices need no separate reset: they live in
        // `messages` (cleared above) and replay to their historical positions.
        // (A side array of mode banners once ACCUMULATED every turn.)
      }));
    }
    // null clears any stale/reconnecting banner; no consumer distinguishes a
    // dedicated "connected" value from the healthy default.
    patch({ connHealth: null, streaming: true, queryKey: key });
    const abort = new AbortController();
    abortRef.current = abort;
    resetHealthTimer();

    // Per-connection cursor: each query's _idx restarts at 0 server-side, so a
    // stale ref clamped upward by Math.max made mid-stream reconnects ask for
    // after=<old query's count> and permanently skip the new transcript.
    lastEventIdxRef.current = after;
    staleReconnectRef.current = () => connectToStream(key, lastEventIdxRef.current);
    // Per-connection: did the last persisted frame close the stream for a
    // reason (`done` / `stream_end`)? Decides what a finished fetch means —
    // see streamLifecycle.ts.
    let sawTerminal = false;

    // One exit path for BOTH a resolved and a rejected fetch. A clean close
    // without a terminal frame is the proxy ending its response on an upstream
    // failure — it reconnects from the cursor exactly like a throw.
    const settle = (aborted: boolean, error?: unknown) => {
      const status = error instanceof ApiError ? error.status : undefined;
      const decision = decideStreamClose({ isCurrent: abortRef.current === abort, aborted, sawTerminal, attempts: reconnectAttemptsRef.current, status });
      switch (decision.action) {
        case "ignore": return;
        case "closed": abortRef.current = null; return;
        case "aborted": patch({ streaming: false, connHealth: null }); return;
        case "access-denied": {
          // Release the connection and its health timer, keep the transcript
          // and the cursor, and say so inline. The rail's poll raises the
          // re-login overlay for a 401; the next successful session-list load
          // (after the unlock) resumes this stream from lastEventIdxRef.
          abortRef.current = null;
          if (healthTimerRef.current) { window.clearTimeout(healthTimerRef.current); healthTimerRef.current = null; }
          stoppedForAccessRef.current = { key, status: decision.status };
          const detail = error instanceof Error ? error.message : "access denied";
          const advice = decision.status === 401 ? "Sign in again to resume." : decision.status === 404 ? "The session is no longer available." : "Access was refused.";
          setState((c) => ({
            ...c, connHealth: "offline",
            messages: [...c.messages, { type: "error", message: `Stream stopped (${detail}). ${advice}` } as ClaudeCodeMessage],
          }));
          return;
        }
        case "give-up":
          // Release the connection AND its health timer: with the ref still
          // set, the 30s stale check kept reconnecting a dead stream and
          // appended a fresh "Connection lost" every cycle.
          abortRef.current = null;
          if (healthTimerRef.current) { window.clearTimeout(healthTimerRef.current); healthTimerRef.current = null; }
          setState((c) => ({
            ...c, connHealth: null, streaming: false,
            messages: [...c.messages, { type: "error", message: decision.message } as ClaudeCodeMessage],
          }));
          return;
        case "reconnect":
          reconnectAttemptsRef.current = decision.attempt;
          patch({ connHealth: "reconnecting" });
          reconnectTimerRef.current = window.setTimeout(() => connectToStream(key, lastEventIdxRef.current), decision.delayMs);
          return;
      }
    };

    void streamClaudeCodeSession(apiBase, key, after, (event) => {
      resetHealthTimer();
      // Data is flowing — clear the backoff counter so a later transient drop
      // gets the full retry budget again.
      reconnectAttemptsRef.current = 0;
      if (event._idx !== undefined) lastEventIdxRef.current = event._idx;
      sawTerminal = nextTerminalFlag(sawTerminal, event);

      // Delta events: buffer + schedule one flush per animation frame.
      if (event.type === "text_delta") { pendingDeltasRef.current.text += event.text || ""; schedule(); return; }
      if (event.type === "thinking_delta") { pendingDeltasRef.current.thinking += event.text || ""; schedule(); return; }
      if (event.type === "input_delta") { pendingDeltasRef.current.input += event.text || ""; schedule(); return; }

      // Everything else is a structural change. Queue it for the same batched
      // flush so a thousand-event replay still collapses to ~1 render per frame.
      // Mutators run AFTER the frame's deltas, in arrival order — so a
      // consolidated `text` event appends its authoritative content and clears
      // the live preview within the same frame.

      if (event.type === "system" && event.sessionId) {
        const sessionId = event.sessionId;
        connectedSessionRef.current = sessionId;
        enqueue((c) => ({
          ...c,
          sessionMeta: {
            queryKey: key,
            model: event.model, cwd: event.cwd, sessionId, mode: event.mode,
            slashCommands: event.slashCommands, skills: event.skills,
          },
          currentMode: event.mode ?? c.currentMode,
        }));
        refreshSessionsSoon();
        return;
      }
      if (event.type === "question" && event.id) {
        // Surface the live card AND append the question into the message array.
        // turns.ts `openQuestions` is built from `question` messages; without the
        // append it stays empty and the answered (Q→A) branch is unreachable.
        enqueue((c) => ({
          ...c,
          pendingQuestion: { id: event.id!, questions: (event.questions as PendingQuestion["questions"]) ?? [] },
          messages: [...c.messages, event as ClaudeCodeMessage],
        }));
        return;
      }
      if (event.type === "question_answered" && event.id) {
        enqueue((c) => ({
          ...c,
          pendingQuestion: c.pendingQuestion?.id === event.id ? null : c.pendingQuestion,
          messages: [...c.messages, event as ClaudeCodeMessage],
        }));
        return;
      }
      if (event.type === "mode_change" && event.mode) {
        // The footer pill tracks currentMode; the transition itself joins the
        // transcript chronologically (turns.ts renders it as a system notice),
        // so a Claude-initiated switch (plan approval → execute) leaves a trace.
        enqueue((c) => ({
          ...c,
          currentMode: event.mode!,
          sessionMeta: c.sessionMeta ? { ...c.sessionMeta, mode: event.mode, ...(event.researchBash !== undefined ? { researchBash: event.researchBash } : {}) } : c.sessionMeta,
          messages: [...c.messages, event as ClaudeCodeMessage],
        }));
        return;
      }
      if (event.type === "model_change" && event.model) {
        enqueue((c) => ({ ...c, sessionMeta: c.sessionMeta ? { ...c.sessionMeta, model: event.model } : c.sessionMeta }));
        return;
      }
      if (event.type === "plan_ready" && event.id) {
        enqueue((c) => ({ ...c, pendingPlan: { id: event.id!, plan: event.plan ?? null, allowedPrompts: (event.allowedPrompts as unknown[]) ?? null } }));
        return;
      }
      if (event.type === "plan_approved" || event.type === "plan_rejected") {
        enqueue((c) => ({ ...c, pendingPlan: null }));
        return;
      }
      if (event.type === "task_started" || event.type === "task_progress" || event.type === "task_updated") {
        enqueue((c) => {
          const tasks = c.tasks.slice();
          const i = tasks.findIndex((t) => t.taskId === event.taskId);
          const existing = i >= 0 ? tasks[i] : undefined;
          // `task_updated` is a sparse patch (the SDK sends only what changed),
          // so merge the fields the event carries over the tracked task instead
          // of spreading explicit `undefined`s over its description/subagent/
          // tool-use id, and honor a terminal status when one is sent.
          const status = TERMINAL_TASK_STATUSES.has(event.status ?? "") ? event.status! : existing?.status ?? "running";
          const next: TaskItem = {
            taskId: event.taskId!,
            description: event.description ?? existing?.description,
            subagentType: event.subagentType ?? existing?.subagentType,
            toolUseId: event.toolUseId ?? existing?.toolUseId,
            status,
          };
          if (i >= 0) tasks[i] = next;
          else tasks.push(next);
          return { ...c, tasks };
        });
        return;
      }
      if (event.type === "task_notification" && event.taskId) {
        // Close the task in the strip AND put its completion summary into the
        // transcript — the service emits `summary`/`status` here and nothing
        // else carries them. The description lives on the tracked
        // task (the notification omits it), so compose inside the mutator.
        enqueue((c) => {
          const status = event.status ?? "completed";
          const task = c.tasks.find((t) => t.taskId === event.taskId);
          const label = task?.description ?? event.description ?? event.taskId!;
          const content = `⚙ Background task ${status}: ${label}${event.summary ? ` — ${event.summary}` : ""}`;
          return {
            ...c,
            tasks: c.tasks.map((t) => (t.taskId === event.taskId ? { ...t, status } : t)),
            messages: [...c.messages, { type: "system", content } as ClaudeCodeMessage],
          };
        });
        return;
      }
      if (event.type === "compact_boundary") {
        enqueue((c) => ({ ...c, messages: [...c.messages, { ...event, type: "compact_boundary" } as ClaudeCodeMessage] }));
        return;
      }
      if (event.type === "context_usage") {
        enqueue((c) => ({ ...c, context: { totalTokens: event.totalTokens ?? 0, maxTokens: event.maxTokens ?? 0, percentage: event.percentage, model: event.model, categories: (event.categories as ClaudeCodeContext["categories"]) ?? [] } }));
        return;
      }
      if (event.type === "suggestion" && event.text) {
        enqueue((c) => ({ ...c, suggestions: [...c.suggestions, event.text!] }));
        return;
      }
      if (event.type === "model_fallback") {
        enqueue((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage] }));
        return;
      }
      if (event.type === "rewind") {
        const summary = `↶ Rewind ${event.dryRun ? "(dry run) " : ""}— ${event.filesChanged?.length ?? 0} files, +${event.insertions ?? 0}/−${event.deletions ?? 0}`;
        enqueue((c) => ({ ...c, messages: [...c.messages, { type: "system", content: summary } as ClaudeCodeMessage] }));
        return;
      }
      if (event.type === "thinking_start") { enqueue((c) => ({ ...c, streamThinking: "" })); return; }
      if (event.type === "tool_start") {
        enqueue((c) => ({
          ...c,
          streamTools: [...c.streamTools, { id: event.id, tool: event.tool, input: "" }],
          activeToolId: event.id ?? null,
        }));
        return;
      }
      if (event.type === "tool_progress") {
        enqueue((c) => ({
          ...c,
          streamTools: c.streamTools.map((t) => (t.id === event.id ? { ...t, elapsed: event.elapsed, tool: event.tool ?? t.tool } : t)),
        }));
        return;
      }
      if (event.type === "done") {
        // v2: messages already hold the canonical transcript from streamed
        // consolidated events PLUS panel-only events. We no longer reload from
        // getClaudeCodeMessages (that SDK projection drops panel-only events).
        // `done` is emitted only after every background task has reported (a
        // `result` may precede it while tasks still run), so the strip is empty
        // by definition here — clear it so a stale entry can't survive.
        // A pending question cannot outlive its query either: a service
        // restart injects `error` + `done` for an interrupted file without a
        // `question_answered`, and the card used to survive onto a finished
        // session, posting to a dead query.
        enqueue((c) => ({
          ...c,
          streaming: false, streamText: "", streamThinking: "", streamTools: [],
          activeToolId: null, connHealth: null, queryKey: null, pendingPlan: null, pendingQuestion: null, tasks: [],
        }));
        lastEventIdxRef.current = -1;
        refreshSessionsSoon();
        return;
      }
      if (event.type === "stream_end") {
        // The agent service closes an idle session's replay with this frame
        // (handlers/sessions.js: status !== "running"). Nothing is in flight, so
        // the working indicator must clear even when the replayed file ends
        // without a `done` (a crash-cut file) — otherwise the panel spins on a
        // session that finished hours ago. Interactive cards clear too.
        enqueue((c) => ({
          ...c,
          streaming: false, streamText: "", streamThinking: "", streamTools: [],
          activeToolId: null, connHealth: null, queryKey: null, pendingPlan: null, pendingQuestion: null, tasks: [],
        }));
        lastEventIdxRef.current = -1;
        return;
      }
      if (event.type === "error") {
        // Inline + chronological: errors join the transcript at the point they
        // occurred (turns.ts renders them), so they scroll away with history and
        // a recurrence appends a fresh entry. Replays position them correctly.
        // There is NO sticky error slot anymore.
        //
        // The proxy's own frame (`source:"bridge-proxy"`) precedes every
        // failed close, so a reconnect storm would repeat one message up to
        // MAX_RECONNECT_ATTEMPTS times — collapse consecutive identical proxy
        // frames; real agent errors are never deduplicated.
        const fromProxy = (event as { source?: unknown }).source === "bridge-proxy";
        enqueue((c) => {
          const last = c.messages[c.messages.length - 1];
          if (fromProxy && last && last.type === "error" && last.message === event.message && (last as { source?: unknown }).source === "bridge-proxy") return c;
          return { ...c, messages: [...c.messages, event as ClaudeCodeMessage] };
        });
        return;
      }
      if (event.type === "result") {
        // Without this branch /cost was always empty, the context meter stuck at
        // 0, ResultTurn never rendered, and plan-mode approve/execute was
        // unreachable (planReady requires a trailing result turn).
        enqueue((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage] }));
        return;
      }
      // Consolidated block events: append the authoritative content and PRUNE the
      // matching live-delta buffer so completed blocks don't render twice.
      if (event.type === "text") {
        enqueue((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage], streamText: "" }));
        return;
      }
      if (event.type === "thinking") {
        enqueue((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage], streamThinking: "" }));
        return;
      }
      if (event.type === "tool_use") {
        enqueue((c) => ({
          ...c,
          messages: [...c.messages, event as ClaudeCodeMessage],
          streamTools: c.streamTools.filter((t) => t.id !== (event as { id?: string }).id),
        }));
        return;
      }
      if (event.type === "tool_result") {
        enqueue((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage] }));
        return;
      }
      // User events (live + replay). Control-only events (/compact) are not shown
      // as user turns. A real user turn starts fresh, so clear stale suggestions.
      if (event.type === "user") {
        if (event.control) return;
        enqueue((c) => ({ ...c, messages: [...c.messages, event as ClaudeCodeMessage], suggestions: [] }));
        return;
      }
    }, abort.signal)
      // A resolved fetch is only "the stream ended" when a terminal frame was
      // seen; otherwise settle() reconnects from the cursor. The
      // identity guard lives inside decideStreamClose: a superseded
      // fetch — AbortError or not — never patches its replacement.
      .then(() => settle(false))
      .catch((error: unknown) => settle(error instanceof DOMException && error.name === "AbortError", error));
  }, [apiBase, disconnect, patch, resetHealthTimer, flushNow, schedule, enqueue, clearPending, refreshSessionsSoon]);

  // Resume a stream the server refused once the session list loads again. The
  // rail's poll owns the fetching (this observer never fetches on its own); a
  // successful load after a lapse means the unlock happened (the Codex hook's
  // detail-query pattern). A 404 stays stopped unless the list still has the
  // session.
  const sessionsProbe = useQuery({ queryKey: [sessionsKey], queryFn: () => getClaudeCodeSessions(apiBase), enabled: false });
  useEffect(() => {
    const stopped = stoppedForAccessRef.current;
    if (!stopped || !sessionsProbe.isSuccess) return;
    if (stopped.status === 404 && !(sessionsProbe.data ?? []).some((s) => s.sessionId === sessionId)) return;
    stoppedForAccessRef.current = null;
    connectToStream(stopped.key, lastEventIdxRef.current);
  }, [sessionsProbe.dataUpdatedAt, sessionsProbe.isSuccess, sessionsProbe.data, sessionId, connectToStream]);

  useEffect(() => {
    stoppedForAccessRef.current = null;
    if (!sessionId) { setState(INITIAL); disconnect(); return; }
    // Adopting a brand-new session's id: the connection that produced the
    // `system` event IS this session's stream (the previous run of this effect
    // had no session and returned no cleanup, so it is still live). Keep it —
    // resetting to INITIAL, re-probing /status and replaying at -1 flashed the
    // Welcome box mid-turn, hid Stop for a round trip and restarted the
    // spinner. Every other transition (A→B, reattach) runs after the
    // previous effect's cleanup disconnected, so abortRef is null there.
    if (abortRef.current && connectedSessionRef.current === sessionId) {
      return () => { disconnect(); };
    }
    let cancelled = false;
    setState({ ...INITIAL });
    void (async () => {
      try {
        const status = await getClaudeCodeStatus(apiBase, sessionId);
        if (cancelled) return;
        if (status.active || status.status === "error" || status.status === "complete") {
          lastEventIdxRef.current = -1;
          connectToStream(status.queryKey || sessionId, -1);
          return;
        }
      } catch (error) {
        // /status failing (agent down, 400) used to fall through SILENTLY to
        // the SDK-projected messages — an ACTIVE session opened as a frozen,
        // event-poor transcript with no hint why and never attached to the
        // live stream. Say so inline, then still show what we can.
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : "status unavailable";
        setState((c) => ({
          ...c,
          messages: [...c.messages, { type: "error", message: `Session status unavailable (${detail}) — showing the archived transcript; a running turn will not stream here until the panel is reopened.` } as ClaudeCodeMessage],
        }));
      }
      if (cancelled) return;
      try {
        const msgs = await getClaudeCodeMessages(apiBase, sessionId);
        if (!cancelled) setState((c) => ({ ...c, messages: [...msgs, ...c.messages.filter((message) => message.type === "error")] }));
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Unable to load session";
          setState((c) => ({ ...c, messages: [...c.messages, { type: "error", message } as ClaudeCodeMessage] }));
        }
      }
    })();
    return () => { cancelled = true; disconnect(); };
  }, [sessionId, attachEpoch, connectToStream, disconnect]);

  useEffect(() => () => {
    disconnect();
    if (refreshTimerRef.current != null) { window.clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
  }, [disconnect]);

  const resetSession = useCallback(() => { stoppedForAccessRef.current = null; disconnect(); setState(INITIAL); }, [disconnect]);
  const reattach = useCallback(() => setAttachEpoch((epoch) => epoch + 1), []);
  return { state, connectToStream, disconnect, setState, resetSession, reattach };
}
