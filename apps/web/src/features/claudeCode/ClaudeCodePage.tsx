import { useCallback, useEffect, useMemo, useState, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ClaudeCodeEffort, ClaudeCodeMode, KimiServingMode, KimiServingModeInfo } from "@tracyhill-rp/contracts";

import {
  compactClaudeCodeSession,
  downloadClaudeCodeExport,
  forkClaudeCodeSession,
  getClaudeCodeCommands,
  getKimiServingInfo,
  interruptClaudeCodeSession,
  setClaudeCodeMode,
  setKimiServing,
} from "./claudeCodeApi";
import { useCodingBackend } from "./backend";
import { ClaudeDraftStore, claudeDraftKey } from "./claudeDrafts";
import { forgetSessionMode, readSessionMode, writeSessionMode } from "./sessionModes";
import { adoptRequestedModel, requestedModelFor, type RequestedModelRecord } from "./requestedModel";
import { Composer } from "./composer";
import { DoctorModal, MemoryModal } from "./modals";
import { CommandPalette } from "./overlays";
import { SessionRail } from "./rail";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { StatusFooter } from "./StatusFooter";
import { Transcript } from "./timeline";
import { Welcome } from "./Welcome";
import { useClaudeCodeStream } from "./useClaudeCodeStream";
import { Icon } from "../../shared/ui/Icon";
import "../../styles/feature-panels.css";

// `drafts` is the shell-owned store for this backend (AppShell keeps one per
// backend for the life of the signed-in shell); without one the page keeps a
// private store, which only lives as long as the page does.
type ClaudeCodePageProps = { onExit: () => void; drafts?: ClaudeDraftStore };

const RAIL_STORAGE_KEY = "ccp-rail-open";

export function ClaudeCodePage({ onExit, drafts: suppliedDrafts }: ClaudeCodePageProps) {
  const backend = useCodingBackend();
  const { apiBase } = backend;
  // Per-backend localStorage namespace so Claude and Kimi keep independent
  // model/effort/mode prefs (Claude keeps its historical "cc-" keys unchanged).
  const MODEL_STORAGE_KEY = `${backend.storagePrefix}-model-v2`;
  const EFFORT_STORAGE_KEY = `${backend.storagePrefix}-effort-v2`;
  const MODE_STORAGE_KEY = `${backend.storagePrefix}-mode-v2`;
  const BASH_STORAGE_KEY = `${backend.storagePrefix}-research-bash`;
  const SERVING_STORAGE_KEY = `${backend.storagePrefix}-serving`;

  const queryClient = useQueryClient();
  const [localDrafts] = useState(() => new ClaudeDraftStore());
  const drafts = suppliedDrafts ?? localDrafts;
  const newDraftKey = useSyncExternalStore(drafts.subscribe, () => drafts.newKey);
  // Reopening the panel returns to the session it showed when it was closed,
  // so the draft the user left is the one in view.
  const [activeSessionId, updateActiveSessionId] = useState<string | null>(() => drafts.selectedSessionId);
  // Read at response time by handleSent: a send belongs to the session its
  // draft was written for, not to whatever the rail shows when it resolves.
  const selectedSessionRef = useRef(activeSessionId);
  selectedSessionRef.current = activeSessionId;
  // A New-slot send waiting for the stream's `system` event to name its
  // session; carries the draft slot so the adoption can move the draft.
  const pendingNewQueryRef = useRef<{ queryKey: string; draftKey: string } | null>(null);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_STORAGE_KEY) !== "0");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_STORAGE_KEY) || backend.defaultModel);
  // A stored effort outside this backend's ladder (e.g. "xhigh" saved for Kimi
  // by the old five-value picker) is normalized to the default and said so
  // once, instead of being folded silently by the service.
  const [effortNotice] = useState<string | null>(() => {
    const stored = localStorage.getItem(EFFORT_STORAGE_KEY) as ClaudeCodeEffort | null;
    return stored && !backend.efforts.includes(stored) ? `Effort "${stored}" is not available on ${backend.title} — using ${backend.defaultEffort}.` : null;
  });
  const [effort, setEffort] = useState<ClaudeCodeEffort>(() => {
    const stored = localStorage.getItem(EFFORT_STORAGE_KEY) as ClaudeCodeEffort | null;
    return stored && backend.efforts.includes(stored) ? stored : backend.defaultEffort;
  });
  const [mode, setModeState] = useState<ClaudeCodeMode>(() => (localStorage.getItem(MODE_STORAGE_KEY) as ClaudeCodeMode) || "research");
  const [researchBash, setResearchBash] = useState(() => localStorage.getItem(BASH_STORAGE_KEY) === "1");
  // Kimi serving state (unused by the Claude backend — serving is false there).
  const [servingModes, setServingModes] = useState<KimiServingModeInfo[]>([]);
  const [servingMode, setServingMode] = useState<KimiServingMode>(() => (localStorage.getItem(SERVING_STORAGE_KEY) as KimiServingMode) || "api");
  const [flash, setFlash] = useState<string | null>(null);
  const [serverCommands, setServerCommands] = useState<{ name: string; description?: string | null }[]>([]);
  const [serverSkills, setServerSkills] = useState<string[]>([]);

  const { state, connectToStream, setState, resetSession, reattach } = useClaudeCodeStream(activeSessionId);
  const setActiveSessionId = (id: string | null) => {
    pendingNewQueryRef.current = null;
    drafts.selectedSessionId = id;
    if (!id) resetSession();
    // Clicking the already-selected session re-runs the status probe and
    // reattaches the stream — the way back from "Connection lost" that keeps
    // the composer draft; a state write with the same id is a no-op.
    else if (id === activeSessionId) { reattach(); return; }
    updateActiveSessionId(id);
  };

  useEffect(() => { localStorage.setItem(MODEL_STORAGE_KEY, model); }, [model]);
  useEffect(() => { localStorage.setItem(EFFORT_STORAGE_KEY, effort); }, [effort]);
  useEffect(() => { if (effortNotice) setFlash(effortNotice); }, [effortNotice]);
  useEffect(() => { localStorage.setItem(MODE_STORAGE_KEY, mode); }, [mode]);
  useEffect(() => { localStorage.setItem(BASH_STORAGE_KEY, researchBash ? "1" : "0"); }, [researchBash]);
  useEffect(() => { localStorage.setItem(RAIL_STORAGE_KEY, railOpen ? "1" : "0"); }, [railOpen]);
  useEffect(() => { if (backend.serving) localStorage.setItem(SERVING_STORAGE_KEY, servingMode); }, [servingMode, backend.serving, SERVING_STORAGE_KEY]);

  // Kimi: load the serving-mode inventory (which modes are key-configured).
  useEffect(() => {
    if (!backend.serving) return;
    let cancelled = false;
    void getKimiServingInfo(apiBase)
      .then((r) => { if (!cancelled) setServingModes(r.modes); })
      .catch(() => { if (!cancelled) setServingModes([]); });
    return () => { cancelled = true; };
  }, [backend.serving, apiBase]);

  // Swap serving mode. Persists immediately; if a session exists, tell the
  // agent so the NEXT turn resumes through the other endpoint (fail-loud on an
  // unconfigured mode — surfaced as a flash, never a silent no-op).
  const applyServing = useCallback((next: KimiServingMode) => {
    setServingMode(next);
    const key = activeSessionId ?? state.sessionMeta?.sessionId;
    if (key) {
      void setKimiServing(apiBase, key, next)
        .then(() => setFlash(`Serving: ${next === "api" ? "API (pay-per-token)" : "Kimi For Coding subscription"}`))
        .catch((e) => setFlash(e instanceof Error ? e.message : "Serving change failed"));
    } else {
      setFlash(`Serving: ${next === "api" ? "API (pay-per-token)" : "Kimi For Coding subscription"} — applies to the next session`);
    }
  }, [activeSessionId, apiBase, state.sessionMeta]);

  useEffect(() => {
    if (!activeSessionId) return;
    const stored = readSessionMode(backend.storagePrefix, activeSessionId);
    if (stored) setModeState(stored);
  }, [activeSessionId, backend.storagePrefix]);

  useEffect(() => {
    let cancelled = false;
    void getClaudeCodeCommands(apiBase, activeSessionId ?? undefined)
      .then((r) => { if (!cancelled) { setServerCommands(r.commands); setServerSkills(r.skills ?? []); } })
      .catch(() => { if (!cancelled) { setServerCommands([]); setServerSkills([]); } });
    return () => { cancelled = true; };
  }, [activeSessionId, state.sessionMeta?.slashCommands]);

  // Binary mode the UI persists + drives the next send with.
  const binaryMode: "research" | "execute" = mode === "research" || mode === "plan" ? "research" : "execute";

  // Optimistic mode/shell writes REVERT + flash on a rejected /mode (query no
  // longer live, service refusal): the pill used to flip while the server
  // stayed in the old mode, and the next denied tool call had no explanation.
  // Mirrors the Codex page's applySettings.
  const applyMode = useCallback((next: "research" | "execute", bash?: boolean) => {
    const previous = binaryMode;
    setModeState(next);
    if (activeSessionId) writeSessionMode(backend.storagePrefix, activeSessionId, next);
    const key = activeSessionId ?? state.sessionMeta?.sessionId;
    if (key && state.streaming) {
      void setClaudeCodeMode(apiBase, key, { mode: next, researchBash: bash ?? researchBash }).catch((error: unknown) => {
        setModeState(previous);
        if (activeSessionId) writeSessionMode(backend.storagePrefix, activeSessionId, previous);
        setFlash(`Mode change failed — still ${previous === "research" ? "Research & Planning" : "Full Execution"}: ${error instanceof Error ? error.message : "request rejected"}`);
      });
    }
  }, [activeSessionId, binaryMode, researchBash, state.sessionMeta, state.streaming, backend.storagePrefix]);

  const applyResearchBash = useCallback((on: boolean) => {
    const previous = researchBash;
    setResearchBash(on);
    const key = activeSessionId ?? state.sessionMeta?.sessionId;
    if (key && state.streaming) {
      void setClaudeCodeMode(apiBase, key, { researchBash: on }).catch((error: unknown) => {
        setResearchBash(previous);
        setFlash(`Shell toggle failed: ${error instanceof Error ? error.message : "request rejected"}`);
      });
    }
  }, [activeSessionId, researchBash, state.sessionMeta, state.streaming]);

  const cycleMode = useCallback(() => {
    const next = binaryMode === "research" ? "execute" : "research";
    applyMode(next);
    setFlash(next === "research" ? "Research & Planning (read-only)" : "Full Execution");
  }, [binaryMode, applyMode]);

  const handleSlash = useCallback((command: string, _args: string) => {
    const key = activeSessionId ?? state.sessionMeta?.sessionId ?? null;
    switch (command) {
      case "clear": setActiveSessionId(null); setFlash("New session."); break;
      case "model": setFlash(`Current model: ${model}. Change via composer dropdown.`); break;
      case "effort": setFlash(`Current effort: ${effort}. Change via composer dropdown.`); break;
      case "research": applyMode("research"); setFlash("Mode: Research & Planning (read-only)."); break;
      case "execute": applyMode("execute"); setFlash("Mode: Full Execution."); break;
      case "compact":
        // Kimi: compaction is disabled on the endpoint (positional tool ids →
        // id-collision loop); the agent still answers 200 to the request, so
        // refuse client-side and steer to /clear.
        if (!backend.supportsCompact) setFlash("Compaction is disabled on this backend — use /clear to start a fresh session.");
        else if (key) void compactClaudeCodeSession(apiBase, key).then(() => setFlash("Compacting conversation…")).catch((e) => setFlash(e instanceof Error ? e.message : "Compact failed"));
        else setFlash("No active session to compact.");
        break;
      case "context": {
        const c = state.context;
        setFlash(c ? `Context: ${Math.round(c.totalTokens / 1000)}k / ${Math.round(c.maxTokens / 1000)}k (${(c.percentage ?? 0).toFixed(1)}%)` : "No context data yet.");
        break;
      }
      case "doctor": setDoctorOpen(true); break;
      case "memory": setMemoryOpen(true); break;
      case "fork":
        if (key) void forkClaudeCodeSession(apiBase, key).then((r) => { setActiveSessionId(r.sessionId); setFlash("Forked conversation."); }).catch((e) => setFlash(e instanceof Error ? e.message : "Fork failed"));
        else setFlash("No active session to fork.");
        break;
      case "cost": {
        const last = state.messages.slice().reverse().find((m) => m.type === "result");
        if (last) setFlash(`Cost: $${(last.cost ?? 0).toFixed(4)} · Turns: ${last.turns ?? 0} · Duration: ${((last.duration ?? 0) / 1000).toFixed(1)}s`);
        else setFlash("No result data available yet for this session.");
        break;
      }
      case "export":
        if (activeSessionId) void downloadClaudeCodeExport(apiBase, activeSessionId).catch((e) => setFlash(e instanceof Error ? e.message : "Export failed"));
        else setFlash("No active session to export.");
        break;
      case "cwd": setFlash(`cwd: ${state.sessionMeta?.cwd ?? "~"}`); break;
      case "help": setShortcutsOpen(true); break;
      default: setFlash(`/${command} is not a panel command.`);
    }
  }, [activeSessionId, applyMode, backend.supportsCompact, effort, model, state.context, state.messages, state.sessionMeta]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 3_500);
    return () => window.clearTimeout(t);
  }, [flash]);

  const requestedModelRef = useRef<RequestedModelRecord | null>(null);

  const handleSent = useCallback((queryKey: string, previousSessionId: string | null, _prompt: string, draftKey: string) => {
    // The user moved to another session while the POST was in flight: the
    // turn runs server-side and shows in the rail; it replays when its
    // session is reselected. Attaching its stream here would replace the
    // transcript the user is now reading.
    if (previousSessionId !== selectedSessionRef.current) {
      void queryClient.invalidateQueries({ queryKey: [backend.sessionsKey] });
      return;
    }
    requestedModelRef.current = { sessionKey: previousSessionId ?? queryKey, model };
    pendingNewQueryRef.current = previousSessionId ? null : { queryKey, draftKey };
    // The stream's `system` event (which names the new session) refreshes the
    // rail; the ten one-second refetches that used to follow a New send are
    // gone — adoption below refreshes once more, explicitly.
    connectToStream(queryKey, -1);
  }, [connectToStream, queryClient, model, backend.sessionsKey]);

  const handleQueued = useCallback((_prompt: string) => {
    void queryClient.invalidateQueries({ queryKey: [backend.sessionsKey] });
  }, [queryClient]);

  // Adopt the server-resolved sessionId ONLY for a brand-new session (no
  // activeSessionId yet). A session the user explicitly picked is authoritative
  // — without the `if (activeSessionId) return` guard, switching A→B reverts to A
  // on the render where activeSessionId is already B but the stream's stale
  // sessionMeta still reports A, which locked you to one session until the panel
  // was reopened (long-standing bug, pre-dates the rewrite).
  useEffect(() => {
    const pending = pendingNewQueryRef.current;
    if (activeSessionId || !pending || state.sessionMeta?.queryKey !== pending.queryKey) return;
    const resolved = state.sessionMeta?.sessionId;
    if (!resolved) return;
    // The New draft (including anything typed since the send) now belongs to
    // the resolved session; the New slot rotates to a fresh key.
    drafts.attachSession(pending.draftKey, resolved);
    requestedModelRef.current = adoptRequestedModel(requestedModelRef.current, pending.queryKey, resolved);
    setActiveSessionId(resolved);
    void queryClient.invalidateQueries({ queryKey: [backend.sessionsKey] });
  }, [state.sessionMeta, activeSessionId, drafts, queryClient, backend.sessionsKey]);

  // Server-initiated mode change (plan approval → execute, idle sync): collapse
  // the reported mode to the binary the UI persists, write both through.
  useEffect(() => {
    const reported = state.currentMode;
    if (!reported) return;
    const binary: ClaudeCodeMode = reported === "research" || reported === "plan" ? "research" : "execute";
    setModeState((prev) => (prev === binary ? prev : binary));
    if (activeSessionId) writeSessionMode(backend.storagePrefix, activeSessionId, binary);
  }, [state.currentMode, activeSessionId, backend.storagePrefix]);

  const handleInterrupt = useCallback(async () => {
    if (!state.queryKey && !activeSessionId) return;
    const key = activeSessionId ?? state.queryKey!;
    // A failed interrupt (Esc / ⏹ Stop) used to give no feedback at all.
    try { await interruptClaudeCodeSession(apiBase, key); }
    catch (error) { setFlash(error instanceof Error ? error.message : "Unable to interrupt"); }
  }, [activeSessionId, state.queryKey]);

  // Keyboard: ⌘K palette, ⌘/ rail, Shift+Tab cycle mode (CLI parity).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); return; }
      if (meta && e.key === "/") { e.preventDefault(); setRailOpen((o) => !o); return; }
      if (e.key === "Tab" && e.shiftKey && !meta) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        // Only hijack Shift+Tab from the empty body. The composer textarea
        // binds its own (it knows whether the / or @ popup is open);
        // other inputs/textareas (memory editor, menus) keep reverse-tab nav.
        if (tag === "BODY" || tag === undefined) { e.preventDefault(); cycleMode(); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cycleMode]);

  const sessionTitle = useMemo(() => activeSessionId ? activeSessionId.slice(0, 8) : "New Session", [activeSessionId]);

  const reqRef = requestedModelRef.current;
  const requestedModel = useMemo(
    () => requestedModelFor(reqRef, activeSessionId ?? state.sessionMeta?.sessionId ?? state.queryKey ?? null, Boolean(backend.serving)),
    [backend.serving, reqRef, activeSessionId, state.sessionMeta?.sessionId, state.queryKey],
  );

  // Errors live in `messages` now, so an error-only session is covered by the length check.
  const showWelcome = !state.streaming && state.messages.length === 0 && !state.pendingPlan && !state.pendingQuestion;

  return (
    <div className="ccp-shell">
      <SessionRail
        open={railOpen}
        onToggle={() => setRailOpen((o) => !o)}
        activeSessionId={activeSessionId}
        onSelect={(id) => { setActiveSessionId(id); setPaletteOpen(false); }}
        onDeleted={(id) => forgetSessionMode(backend.storagePrefix, id)}
      />
      <main className="ccp-main">
        <div className="ccp-topbar">
          <button type="button" className="ccp-topbar-back" title="Back to RP workspace" onClick={onExit}>← RP</button>
          <span className="ccp-topbar-title">{sessionTitle}</span>
          {state.streaming ? <span className="ccp-topbar-live"><span className="ccp-live-dot" /> live</span> : null}
          <span className="ccp-topbar-spacer" />
          <button type="button" className="ccp-topbar-btn" title="New session" onClick={() => setActiveSessionId(null)}>+ New</button>
          <button type="button" className="ccp-topbar-btn" title="Doctor" aria-label="Session diagnostics" onClick={() => setDoctorOpen(true)}><Icon name="stethoscope" size={16} /></button>
          <button type="button" className="ccp-topbar-btn" title="Memory" aria-label="Memory files" onClick={() => setMemoryOpen(true)}><Icon name="book" size={16} /></button>
          <button type="button" className="ccp-topbar-btn" title="Command palette (⌘K)" aria-label="Command palette" onClick={() => setPaletteOpen(true)}>⌘K</button>
        </div>

        {showWelcome ? (
          <div className="ccp-transcript-wrap"><Welcome model={state.sessionMeta?.model ?? model} mode={binaryMode} cwd={state.sessionMeta?.cwd} /></div>
        ) : (
          <Transcript
            state={state}
            sessionId={activeSessionId}
            onPlanResolved={(approved) => setFlash(approved ? "Plan approved — executing." : "Plan sent back for revision.")}
            requestedModel={requestedModel}
            onQuestionAnswered={() => setState((c) => ({ ...c, pendingQuestion: null }))}
          />
        )}

        {flash ? <div className="ccp-flash" role="status">{flash}</div> : null}

        <Composer
          activeSessionId={activeSessionId}
          drafts={drafts}
          draftKey={claudeDraftKey(activeSessionId, newDraftKey)}
          streaming={state.streaming}
          onSent={handleSent}
          onQueued={handleQueued}
          onInterrupt={() => void handleInterrupt()}
          onSlashCommand={handleSlash}
          model={model}
          effort={effort}
          mode={mode}
          researchBash={researchBash}
          currentMode={binaryMode}
          serverCommands={serverCommands}
          serverSkills={serverSkills}
          suggestions={state.suggestions}
          onModelChange={setModel}
          onEffortChange={setEffort}
          onModeToggle={applyMode}
          onCycleMode={cycleMode}
          onResearchBashToggle={applyResearchBash}
          servingMode={servingMode}
          servingModes={servingModes}
          onServingChange={applyServing}
        />

        <StatusFooter
          state={state}
          model={model}
          effort={effort}
          mode={binaryMode}
          onCycleMode={cycleMode}
          onShortcuts={() => setShortcutsOpen(true)}
          connHealth={state.connHealth}
        />
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectSession={setActiveSessionId}
        onNewSession={() => setActiveSessionId(null)}
        onExit={onExit}
        onToggleRail={() => setRailOpen((o) => !o)}
      />
      <DoctorModal sessionId={activeSessionId} open={doctorOpen} onClose={() => setDoctorOpen(false)} />
      <MemoryModal open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
