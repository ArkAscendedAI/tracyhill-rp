import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ClaudeCodeEffort, ClaudeCodeMode } from "@tracyhill-rp/contracts";

import {
  compactClaudeCodeSession,
  downloadClaudeCodeExport,
  forkClaudeCodeSession,
  getClaudeCodeCommands,
  interruptClaudeCodeSession,
  setClaudeCodeMode,
} from "./claudeCodeApi";
import { Composer } from "./composer";
import { ContextMeter } from "./ContextMeter";
import { DoctorModal, MemoryModal } from "./modals";
import { CommandPalette } from "./overlays";
import { SessionRail } from "./rail";
import { Timeline } from "./timeline";
import { useClaudeCodeStream } from "./useClaudeCodeStream";

type ClaudeCodePageProps = { onExit: () => void };

const MODEL_STORAGE_KEY = "cc-model-v2";
const EFFORT_STORAGE_KEY = "cc-effort-v2";
const MODE_STORAGE_KEY = "cc-mode-v2";
const BASH_STORAGE_KEY = "cc-research-bash";
const RAIL_STORAGE_KEY = "ccp-rail-open";

// Per-session mode persistence key.
const sessionModeKey = (id: string) => `ccp-session-mode:${id}`;

export function ClaudeCodePage({ onExit }: ClaudeCodePageProps) {
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(RAIL_STORAGE_KEY) !== "0");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_STORAGE_KEY) || "claude-opus-4-8");
  const [effort, setEffort] = useState<ClaudeCodeEffort>(() => (localStorage.getItem(EFFORT_STORAGE_KEY) as ClaudeCodeEffort) || "max");
  // Binary mode: "research" | "execute" (stored as ClaudeCodeMode for the API).
  const [mode, setModeState] = useState<ClaudeCodeMode>(() => (localStorage.getItem(MODE_STORAGE_KEY) as ClaudeCodeMode) || "research");
  const [researchBash, setResearchBash] = useState(() => localStorage.getItem(BASH_STORAGE_KEY) === "1");
  const [flash, setFlash] = useState<string | null>(null);
  const [serverCommands, setServerCommands] = useState<{ name: string; description?: string | null }[]>([]);
  const [serverSkills, setServerSkills] = useState<string[]>([]);

  const { state, connectToStream, setState } = useClaudeCodeStream(activeSessionId);

  useEffect(() => { localStorage.setItem(MODEL_STORAGE_KEY, model); }, [model]);
  useEffect(() => { localStorage.setItem(EFFORT_STORAGE_KEY, effort); }, [effort]);
  useEffect(() => { localStorage.setItem(MODE_STORAGE_KEY, mode); }, [mode]);
  useEffect(() => { localStorage.setItem(BASH_STORAGE_KEY, researchBash ? "1" : "0"); }, [researchBash]);
  useEffect(() => { localStorage.setItem(RAIL_STORAGE_KEY, railOpen ? "1" : "0"); }, [railOpen]);

  // Restore the per-session mode when switching sessions.
  useEffect(() => {
    if (!activeSessionId) return;
    const stored = localStorage.getItem(sessionModeKey(activeSessionId)) as ClaudeCodeMode | null;
    if (stored) setModeState(stored);
  }, [activeSessionId]);

  // Pull the dynamic slash-command list once a session is known.
  useEffect(() => {
    let cancelled = false;
    void getClaudeCodeCommands(activeSessionId ?? undefined)
      .then((r) => { if (!cancelled) { setServerCommands(r.commands); setServerSkills(r.skills ?? []); } })
      .catch(() => { if (!cancelled) { setServerCommands([]); setServerSkills([]); } });
    return () => { cancelled = true; };
  }, [activeSessionId, state.sessionMeta?.slashCommands]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); return; }
      if (meta && e.key === "/") { e.preventDefault(); setRailOpen((o) => !o); return; }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Persist + live-apply a binary mode change.
  const applyMode = useCallback((next: "research" | "execute", bash?: boolean) => {
    setModeState(next);
    if (activeSessionId) localStorage.setItem(sessionModeKey(activeSessionId), next);
    const key = activeSessionId ?? state.sessionMeta?.sessionId;
    if (key && state.streaming) {
      void setClaudeCodeMode(key, { mode: next, researchBash: bash ?? researchBash }).catch(() => undefined);
    }
  }, [activeSessionId, researchBash, state.sessionMeta, state.streaming]);

  const applyResearchBash = useCallback((on: boolean) => {
    setResearchBash(on);
    const key = activeSessionId ?? state.sessionMeta?.sessionId;
    if (key && state.streaming) void setClaudeCodeMode(key, { researchBash: on }).catch(() => undefined);
  }, [activeSessionId, state.sessionMeta, state.streaming]);

  const handleSlash = useCallback((command: string, _args: string) => {
    const key = activeSessionId ?? state.sessionMeta?.sessionId ?? null;
    switch (command) {
      case "clear": setActiveSessionId(null); setFlash("New session."); break;
      case "model": setFlash(`Current model: ${model}. Change via composer dropdown.`); break;
      case "effort": setFlash(`Current effort: ${effort}. Change via composer dropdown.`); break;
      case "research": applyMode("research"); setFlash("Mode: Research & Planning (read-only)."); break;
      case "execute": applyMode("execute"); setFlash("Mode: Full Execution."); break;
      case "compact":
        if (key) void compactClaudeCodeSession(key).then(() => setFlash("Compacting conversation…")).catch((e) => setFlash(e instanceof Error ? e.message : "Compact failed"));
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
        if (key) void forkClaudeCodeSession(key).then((r) => { setActiveSessionId(r.sessionId); setFlash("Forked conversation."); }).catch((e) => setFlash(e instanceof Error ? e.message : "Fork failed"));
        else setFlash("No active session to fork.");
        break;
      case "cost": {
        const last = state.messages.slice().reverse().find((m) => m.type === "result");
        if (last) setFlash(`Cost: $${(last.cost ?? 0).toFixed(4)} · Turns: ${last.turns ?? 0} · Duration: ${((last.duration ?? 0) / 1000).toFixed(1)}s`);
        else setFlash("No result data available yet for this session.");
        break;
      }
      case "export": if (activeSessionId) downloadClaudeCodeExport(activeSessionId); else setFlash("No active session to export."); break;
      case "cwd": setFlash(`cwd: ${state.sessionMeta?.cwd ?? "~"}`); break;
      case "help": setFlash("Panel: /clear /model /effort /research /execute /compact /context /doctor /memory /fork /cost /export /cwd /help — other / commands pass through to Claude."); break;
      default: setFlash(`/${command} is not a panel command.`);
    }
  }, [activeSessionId, applyMode, effort, model, state.context, state.messages, state.sessionMeta]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 3_500);
    return () => window.clearTimeout(t);
  }, [flash]);

  const requestedModelRef = useRef<{ sessionKey: string | null; model: string } | null>(null);

  const handleSent = useCallback((queryKey: string, previousSessionId: string | null, _prompt: string) => {
    requestedModelRef.current = { sessionKey: previousSessionId ?? queryKey, model };
    connectToStream(queryKey, -1);
    if (!previousSessionId) {
      const iv = window.setInterval(async () => { await queryClient.invalidateQueries({ queryKey: ["claude-code-sessions"] }); }, 1_000);
      window.setTimeout(() => window.clearInterval(iv), 10_000);
    }
  }, [connectToStream, queryClient, model]);

  // Queued mid-stream: the open stream delivers the message + response; no reconnect.
  const handleQueued = useCallback((_prompt: string) => {
    void queryClient.invalidateQueries({ queryKey: ["claude-code-sessions"] });
  }, [queryClient]);

  useEffect(() => {
    const resolved = state.sessionMeta?.sessionId;
    if (resolved && resolved !== activeSessionId) setActiveSessionId(resolved);
  }, [state.sessionMeta, activeSessionId]);

  const handleInterrupt = useCallback(async () => {
    if (!state.queryKey && !activeSessionId) return;
    const key = activeSessionId ?? state.queryKey!;
    try { await interruptClaudeCodeSession(key); } catch {}
  }, [activeSessionId, state.queryKey]);

  const sessionTitle = useMemo(() => activeSessionId ? activeSessionId.slice(0, 8) : "New Session", [activeSessionId]);
  const activeMode = state.currentMode || mode;
  const dismissError = useCallback(() => setState((c) => ({ ...c, error: null })), [setState]);

  return (
    <div className="ccp-shell">
      <SessionRail
        open={railOpen}
        onToggle={() => setRailOpen((o) => !o)}
        activeSessionId={activeSessionId}
        onSelect={(id) => { setActiveSessionId(id); setPaletteOpen(false); }}
      />
      <main className="ccp-main">
        <header className="ccp-header">
          <button type="button" className="ccp-header-back" title="Back to RP workspace" onClick={onExit}>← RP</button>
          <span className="ccp-header-title">{sessionTitle}</span>
          {(() => {
            const reported = state.sessionMeta?.model;
            const requested = requestedModelRef.current?.model ?? null;
            const mismatch = Boolean(requested && reported && reported !== requested && !reported.startsWith(requested));
            return (
              <span
                className={`ccp-header-pill${mismatch ? " ccp-model-mismatch" : ""}`}
                title={mismatch ? `Requested ${requested} but this session is running on ${reported}.` : undefined}
              >
                {mismatch ? `⚠ ${reported} (requested ${requested})` : (reported ?? model)}
              </span>
            );
          })()}
          <span className="ccp-header-pill">cwd: {state.sessionMeta?.cwd ?? "~"}</span>
          <span className={`ccp-header-pill ccp-mode-pill ccp-mode-${activeMode}`}>{activeMode === "research" || activeMode === "plan" ? "🔎 Research" : "⚡ Execute"}</span>
          <ContextMeter sessionId={activeSessionId} context={state.context} />
          {state.streaming ? <span className="ccp-header-pill is-live"><span className="ccp-live-dot" /> live</span> : null}
          <span className="ccp-header-spacer" />
          <button type="button" className="ccp-header-pill" title="Doctor" onClick={() => setDoctorOpen(true)}>🩺</button>
          <button type="button" className="ccp-header-pill" title="Memory" onClick={() => setMemoryOpen(true)}>📚</button>
          <button type="button" className="ccp-header-pill" title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>⌘K</button>
        </header>
        {flash ? <div className="ccp-flash">{flash}</div> : null}
        {state.error ? (
          <div className="ccp-error-banner" role="alert">
            <span>⚠ {state.error}</span>
            <button type="button" onClick={dismissError}>Dismiss</button>
          </div>
        ) : null}
        <Timeline
          state={state}
          sessionId={activeSessionId}
          onPlanResolved={(approved) => setFlash(approved ? "Plan approved — executing." : "Plan sent back for revision.")}
          requestedModel={requestedModelRef.current?.model ?? null}
          onQuestionAnswered={() => setState((c) => ({ ...c, pendingQuestion: null }))}
        />
        <Composer
          activeSessionId={activeSessionId}
          streaming={state.streaming}
          onSent={handleSent}
          onQueued={handleQueued}
          onInterrupt={() => void handleInterrupt()}
          onSlashCommand={handleSlash}
          model={model}
          effort={effort}
          mode={mode}
          researchBash={researchBash}
          currentMode={activeMode}
          serverCommands={serverCommands}
          serverSkills={serverSkills}
          suggestions={state.suggestions}
          onModelChange={setModel}
          onEffortChange={setEffort}
          onModeToggle={applyMode}
          onResearchBashToggle={applyResearchBash}
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
    </div>
  );
}
