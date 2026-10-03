import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { CodexMode, CodexSessionFile, CodexSettingsRequest } from "@tracyhill-rp/contracts";

import {
  compactCodexSession,
  downloadCodexExport,
  forkCodexSession,
  getCodexSessions,
  getCodexSkills,
  getCodexStatus,
  interruptCodexSession,
  reviewCodexSession,
  runCodexShell,
  sendCodexTurn,
  steerCodexTurn,
  updateCodexSettings,
} from "./codexApi";
import { CodexComposer } from "./CodexComposer";
import { CodexInspector, CodexPalette, CodexShortcuts, type CodexPaletteAction, type InspectorTab } from "./CodexOverlays";
import { CodexRail } from "./CodexRail";
import { CodexTranscript } from "./CodexTranscript";
import { useCodexSession } from "./useCodexSession";
import { CodexDraftStore } from "./codexDrafts";
import { activeCodexTurn, codexContextLeft, shellFinishedMessage } from "./codexViewState";
import { Icon } from "../../shared/ui/Icon";
import "../../styles/feature-panels.css";

type Props = { onExit: () => void; drafts?: CodexDraftStore };
type Settings = { mode: CodexMode; model: string; effort: string; serviceTier: string | null };
const MODEL_KEY = "codex-panel-model-v2";
const EFFORT_KEY = "codex-panel-effort-v2";
const MODE_KEY = "codex-panel-mode-v2";
const TIER_KEY = "codex-panel-tier-v2";
const WORKSPACE_KEY = "codex-panel-workspace-v2";
const RAIL_KEY = "codex-panel-rail-v2";
function preference(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function savePreference(key: string, value: string | null) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* preferences are optional */ } }

export function CodexPage({ onExit, drafts: suppliedDrafts }: Props) {
  const queryClient = useQueryClient();
  const [localDrafts] = useState(() => new CodexDraftStore());
  const drafts = suppliedDrafts ?? localDrafts;
  const newDraftKey = useSyncExternalStore(drafts.subscribe, () => drafts.newKey);
  const statusQuery = useQuery({ queryKey: ["codex-status-v2"], queryFn: getCodexStatus, staleTime: 60_000, refetchInterval: 60_000, retry: 1 });
  const sessionsQuery = useQuery({ queryKey: ["codex-sessions"], queryFn: getCodexSessions, staleTime: 5_000 });
  const [activeSessionId, updateActiveSessionId] = useState<string | null>(() => drafts.selectedSessionId);
  const [railOpen, setRailOpen] = useState(() => preference(RAIL_KEY) !== "0");
  const [newWorkspaceId, setWorkspaceId] = useState(() => preference(WORKSPACE_KEY) || "tracyhill_rp");
  const [defaults, setDefaults] = useState<Settings>(() => ({ model: preference(MODEL_KEY) || "", effort: preference(EFFORT_KEY) || "max", mode: preference(MODE_KEY) === "yolo" ? "yolo" : "read-only", serviceTier: preference(TIER_KEY) || null }));
  const [flash, setFlash] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [inspector, setInspector] = useState<{ open: boolean; tab: InspectorTab }>({ open: false, tab: "doctor" });
  const { detailQuery, live, connHealth, streamError, refresh, acknowledgeSettings, acknowledgeTurn } = useCodexSession(activeSessionId);
  const selection = useRef({ id: activeSessionId, epoch: 0 });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const setActiveSessionId = useCallback((id: string | null) => {
    selection.current = { id, epoch: selection.current.epoch + 1 };
    drafts.selectedSessionId = id;
    updateActiveSessionId(id);
    setFlash(null); setPaletteOpen(false);
    if (window.innerWidth <= 720) setRailOpen(false);
  }, [drafts]);
  const locks = useRef(new Map<string, string>());
  const [, redrawOperations] = useState(0);
  const skillsQuery = useQuery({ queryKey: ["codex-skills", activeSessionId], queryFn: () => getCodexSkills(activeSessionId ?? undefined), staleTime: 5 * 60_000 });
  const detail = detailQuery.data;
  const settings: Settings = activeSessionId ? { mode: detail?.metadata.mode ?? "read-only", model: detail?.metadata.model ?? "", effort: detail?.metadata.effort ?? "", serviceTier: detail?.metadata.serviceTier ?? null } : defaults;
  const { mode, model, effort, serviceTier } = settings;
  const workspaceId = activeSessionId ? detail?.metadata.workspaceId ?? "" : newWorkspaceId;
  const activeTurn = activeCodexTurn(detail, live) != null;
  const operation = locks.current.get(activeSessionId ?? "new");
  const settingsReady = Boolean(statusQuery.data) && (!activeSessionId || Boolean(detail) && !detailQuery.isError);
  const ready = settingsReady && Boolean(statusQuery.data?.models.some(entry => entry.id === model)) && Boolean(activeSessionId || workspaceId);

  useEffect(() => { savePreference(RAIL_KEY, railOpen ? "1" : "0"); }, [railOpen]);
  useEffect(() => { savePreference(WORKSPACE_KEY, newWorkspaceId); }, [newWorkspaceId]);
  useEffect(() => {
    savePreference(MODEL_KEY, defaults.model); savePreference(EFFORT_KEY, defaults.effort);
    savePreference(MODE_KEY, defaults.mode); savePreference(TIER_KEY, defaults.serviceTier);
  }, [defaults]);
  useEffect(() => {
    const status = statusQuery.data;
    if (!status) return;
    setDefaults(current => {
      const selected = status.models.find(entry => entry.id === current.model) || status.models.find(entry => entry.id === status.defaultModel) || status.models[0];
      if (!selected) return current;
      const supported = selected.supportedReasoningEfforts.map(entry => entry.id);
      const normalized = { ...current, model: selected.id, effort: supported.includes(current.effort) ? current.effort : supported.includes(status.defaultEffort) ? status.defaultEffort : selected.defaultReasoningEffort || supported[0] || "", serviceTier: selected.serviceTiers.some(entry => entry.id === current.serviceTier) ? current.serviceTier : null };
      return JSON.stringify(normalized) === JSON.stringify(current) ? current : normalized;
    });
    if (!status.workspaces.some(entry => entry.id === newWorkspaceId)) setWorkspaceId(status.workspaces.find(entry => entry.id === "tracyhill_rp")?.id || status.workspaces[0]?.id || "");
  }, [statusQuery.data, newWorkspaceId]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const withLock = useCallback(async <T,>(id: string, label: string, action: () => Promise<T>): Promise<T> => {
    if (locks.current.has(id)) throw new Error("Wait for the current operation to finish.");
    locks.current.set(id, label); redrawOperations(value => value + 1);
    try { return await action(); }
    finally { locks.current.delete(id); if (mounted.current) redrawOperations(value => value + 1); }
  }, []);
  const showResult = useCallback((owner: number, message: string) => { if (mounted.current && selection.current.epoch === owner) setFlash(message); }, []);
  const invoke = useCallback((action: () => Promise<unknown>) => {
    const owner = selection.current.epoch;
    void action().catch(error => showResult(owner, error instanceof Error ? error.message : "Codex request failed"));
  }, [showResult]);

  const applySettings = useCallback(async (patch: CodexSettingsRequest) => {
    if (!settingsReady) throw new Error("Wait for the session settings to load.");
    const requestedModel = patch.model ?? model;
    const modelInfo = statusQuery.data?.models.find(entry => entry.id === requestedModel);
    const supported = modelInfo?.supportedReasoningEfforts.map(entry => entry.id) ?? [];
    const nextEffort = patch.effort ?? (patch.model ? supported.includes(effort) ? effort : modelInfo?.defaultReasoningEffort || supported[0] || "" : effort);
    const requestedTier = Object.hasOwn(patch, "serviceTier") ? patch.serviceTier ?? null : serviceTier;
    const nextTier = modelInfo?.serviceTiers.some(entry => entry.id === requestedTier) ? requestedTier : null;
    const next = { mode: patch.mode ?? mode, model: requestedModel, effort: nextEffort, serviceTier: nextTier };
    if (!activeSessionId) { setDefaults(next); return; }
    const id = activeSessionId; const owner = selection.current.epoch;
    await withLock(id, "Updating settings…", async () => {
      const response = await updateCodexSettings(id, { ...patch, ...(patch.model ? { effort: next.effort || undefined, serviceTier: next.serviceTier } : {}) });
      if (!mounted.current) return;
      acknowledgeSettings(id, response);
      // Header, selectors and Send use only these acknowledged values. A GET
      // already in flight is revision-guarded by useCodexSession.
      void queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
      showResult(owner, "Settings acknowledged.");
    });
  }, [activeSessionId, acknowledgeSettings, effort, mode, model, queryClient, serviceTier, settingsReady, showResult, statusQuery.data, withLock]);

  const submit = useCallback(async (prompt: string, files: CodexSessionFile[], draftKey: string) => {
    if (!ready) throw new Error("Load the session and choose an available model and workspace before sending.");
    const id = activeSessionId; const owner = selection.current.epoch;
    await withLock(id ?? "new", "Sending…", async () => {
      if (prompt.startsWith("!")) {
        if (!id) throw new Error("Start a Codex session before using !shell commands.");
        if (mode !== "yolo") throw new Error("!shell commands are available only in YOLO mode.");
        if (activeTurn) throw new Error("Interrupt or finish the active turn before using !shell commands.");
        if (files.length) throw new Error("Remove attachments before running a shell command; the shell does not receive them.");
        const command = prompt.slice(1).trim();
        if (!command) throw new Error("Enter a shell command after !");
        await runCodexShell(id, { command });
        showResult(owner, shellFinishedMessage(command));
      } else if (id && activeTurn) {
        const selected = statusQuery.data?.models.find(entry => entry.id === model);
        if (files.some(file => file.kind === "image") && selected && !selected.inputModalities.includes("image")) throw new Error("This model does not accept images. Choose an image-capable model or remove the image attachment.");
        await steerCodexTurn(id, { prompt: prompt || undefined, files: files.length ? files : undefined });
        showResult(owner, "Steering message sent to the active turn.");
      } else {
        const selected = statusQuery.data?.models.find(entry => entry.id === model);
        if (files.some(file => file.kind === "image") && selected && !selected.inputModalities.includes("image")) throw new Error("This model does not accept images. Choose an image-capable model or remove the image attachment.");
        const response = await sendCodexTurn({ prompt: prompt || undefined, files: files.length ? files : undefined, sessionId: id, workspaceId: id ? undefined : workspaceId, mode, model, effort: effort || undefined, serviceTier });
        if (!mounted.current) { if (!id) drafts.attachSession(draftKey, response.sessionId); return; }
        acknowledgeTurn(response.sessionId, response.turnId);
        if (!id) {
          drafts.attachSession(draftKey, response.sessionId);
          if (selection.current.epoch === owner) setActiveSessionId(response.sessionId);
        }
        void queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
      }
    });
  }, [activeSessionId, activeTurn, acknowledgeTurn, drafts, effort, mode, model, queryClient, ready, serviceTier, setActiveSessionId, showResult, statusQuery.data, withLock, workspaceId]);

  const interrupt = useCallback(async () => {
    if (!activeSessionId || !activeTurn) return;
    const owner = selection.current.epoch;
    await withLock(`interrupt:${activeSessionId}`, "Interrupting…", async () => { await interruptCodexSession(activeSessionId); showResult(owner, "Interrupt requested."); });
  }, [activeSessionId, activeTurn, showResult, withLock]);
  const sessionAction = useCallback(async (kind: "compact" | "fork" | "review") => {
    const id = activeSessionId; const owner = selection.current.epoch;
    if (!id || !detail) throw new Error("Load a session first.");
    if (activeTurn) throw new Error("Interrupt or finish the active turn first.");
    await withLock(id, `${kind === "compact" ? "Compacting" : kind === "fork" ? "Forking" : "Starting review"}…`, async () => {
      if (kind === "compact") { await compactCodexSession(id); showResult(owner, "Compacting context…"); }
      else if (kind === "fork") {
        const response = await forkCodexSession(id);
        if (mounted.current && selection.current.epoch === owner) { setActiveSessionId(response.sessionId); setFlash("Forked native Codex thread."); }
      } else {
        const response = await reviewCodexSession(id, { target: { type: "uncommittedChanges" } });
        if (mounted.current) acknowledgeTurn(id, response.turnId, typeof response.activeThreadId === "string" ? response.activeThreadId : id);
        showResult(owner, "Review started.");
      }
      if (mounted.current) void queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
    });
  }, [activeSessionId, activeTurn, acknowledgeTurn, detail, queryClient, setActiveSessionId, showResult, withLock]);
  const compact = useCallback(() => sessionAction("compact"), [sessionAction]);
  const fork = useCallback(() => sessionAction("fork"), [sessionAction]);
  const review = useCallback(() => sessionAction("review"), [sessionAction]);
  const exportSession = useCallback(async () => { if (!activeSessionId) throw new Error("No session to export."); await downloadCodexExport(activeSessionId); }, [activeSessionId]);
  const openInspector = useCallback((tab: InspectorTab) => setInspector({ open: true, tab }), []);
  const command = useCallback(async (enteredName: string, args: string, files: CodexSessionFile[], draftKey: string) => {
    const name = enteredName.toLowerCase();
    if (name === "clear") { setActiveSessionId(null); return; }
    if (name === "compact") return compact();
    if (name === "fork") return fork();
    if (name === "review") return review();
    if (name === "export") return exportSession();
    if (name === "doctor" || name === "skills" || name === "mcp") { openInspector(name); return; }
    if (name === "model") { setFlash(`Model: ${model}`); return; }
    if (name === "effort") { setFlash(`Reasoning effort: ${effort || "default"}`); return; }
    if (name === "mode") return applySettings({ mode: mode === "read-only" ? "yolo" : "read-only" });
    if (name === "cwd") { setFlash(`cwd: ${detail?.metadata.cwd || statusQuery.data?.workspaces.find(entry => entry.id === workspaceId)?.cwd || "~"}`); return; }
    if (name === "help") { setShortcutsOpen(true); return; }
    const skill = skillsQuery.data?.skills.find(skill => skill.enabled !== false && skill.name.toLowerCase() === name);
    await submit(`${skill ? `$${skill.name}` : `/${enteredName}`}${args ? ` ${args}` : ""}`, files, draftKey);
  }, [applySettings, compact, detail?.metadata.cwd, effort, exportSession, fork, mode, model, openInspector, review, setActiveSessionId, skillsQuery.data, statusQuery.data, submit, workspaceId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      const meta = event.metaKey || event.ctrlKey;
      // The authentication overlay is outside the coding shell. Its inputs and
      // shortcuts must not dispatch commands into the obscured session.
      if (target?.closest('[role="dialog"]') && !target.closest(".codex-panel-shell")) return;
      if (meta && !event.shiftKey && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(value => !value); return; }
      if (meta && event.key === "/") { event.preventDefault(); setRailOpen(value => !value); return; }
      if (event.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (inspector.open) setInspector(current => ({ ...current, open: false }));
        else if (shortcutsOpen) setShortcutsOpen(false);
        else if (activeTurn) invoke(interrupt);
        else return;
        event.preventDefault();
      } else if (event.key === "Tab" && event.shiftKey && !meta && target?.classList.contains("ccp-composer-textarea") && !operation && settingsReady) {
        event.preventDefault(); invoke(() => applySettings({ mode: mode === "read-only" ? "yolo" : "read-only" }));
      }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, [activeTurn, applySettings, inspector.open, interrupt, invoke, mode, operation, paletteOpen, settingsReady, shortcutsOpen]);

  const sessionTitle = detail?.metadata.title || detail?.thread.name || detail?.thread.preview || (activeSessionId ? activeSessionId.slice(0, 8) : "New Session");
  const contextLeft = codexContextLeft(live.tokenUsage ?? detail?.runtime.tokenUsage);
  const currentCwd = detail?.metadata.cwd || statusQuery.data?.workspaces.find(entry => entry.id === workspaceId)?.cwd;
  const paletteActions: CodexPaletteAction[] = useMemo(() => [
    { name: "New session", description: "Start clean", run: () => setActiveSessionId(null) },
    { name: "Toggle mode", description: mode === "read-only" ? "Switch to YOLO" : "Switch to Read Only", run: () => invoke(() => applySettings({ mode: mode === "read-only" ? "yolo" : "read-only" })) },
    { name: "Compact", description: "Compact context", run: () => invoke(compact) },
    { name: "Fork", description: "Fork native thread", run: () => invoke(fork) },
    { name: "Review", description: "Review uncommitted changes", run: () => invoke(review) },
    { name: "Doctor", description: "Run diagnostics", run: () => openInspector("doctor") },
    { name: "Skills", description: "Inspect skills", run: () => openInspector("skills") },
    { name: "MCP", description: "Inspect MCP servers", run: () => openInspector("mcp") },
    { name: "Export", description: "Download markdown", run: () => invoke(exportSession) },
    { name: "Back to RP", description: "Close Codex panel", run: onExit },
  ], [applySettings, compact, exportSession, fork, invoke, mode, onExit, openInspector, review, setActiveSessionId]);

  return (
    <div className="ccp-shell codex-panel-shell">
      <CodexRail open={railOpen} onToggle={() => setRailOpen((value) => !value)} activeSessionId={activeSessionId} onSelect={(id) => { setActiveSessionId(id); setPaletteOpen(false); }} />
      <main className="ccp-main">
        <div className="ccp-topbar">
          <button type="button" className="ccp-topbar-back" onClick={onExit}>← RP</button>
          <span className="codex-topbar-mark"><Icon name="terminal" size={16} /></span><span className="ccp-topbar-title">{sessionTitle}</span>
          {activeTurn ? <span className="ccp-topbar-live"><span className="ccp-live-dot" /> live</span> : null}
          <span className="ccp-topbar-spacer" />
          <button type="button" className="ccp-topbar-btn" onClick={() => setActiveSessionId(null)}>+ New</button>
          <button type="button" className="ccp-topbar-btn" onClick={() => invoke(review)} disabled={!detail || activeTurn || Boolean(operation)}>Review</button>
          <button type="button" className="ccp-topbar-btn" onClick={() => invoke(compact)} disabled={!detail || activeTurn || Boolean(operation)}>Compact</button>
          <button type="button" className="ccp-topbar-btn" onClick={() => invoke(fork)} disabled={!detail || activeTurn || Boolean(operation)}>Fork</button>
          <button type="button" className="ccp-topbar-btn" onClick={() => invoke(exportSession)} disabled={!activeSessionId}>Export</button>
          <button type="button" className="ccp-topbar-btn" title="Diagnostics" onClick={() => openInspector("doctor")}><Icon name="stethoscope" size={16} /></button>
          <button type="button" className="ccp-topbar-btn" title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>⌘K</button>
        </div>

        {!activeSessionId ? <CodexWelcome model={model || statusQuery.data?.defaultModel} mode={mode} cwd={currentCwd} error={statusQuery.error?.message} cliVersion={statusQuery.data?.cliVersion} legacySessions={statusQuery.data?.legacySessionCount} />
          : detailQuery.isLoading ? <div className="ccp-transcript-wrap"><div className="ccp-transcript"><div className="ccp-spinner"><span className="ccp-spinner-glyph"><Icon name="spinner" size={14} className="icon-spin" /></span><span>Loading native thread…</span></div></div></div>
          : detail ? <CodexTranscript key={`transcript:${activeSessionId}`} drafts={drafts} detail={detail} live={live} streamError={streamError} onQuestionAnswered={() => void refresh()} />
          : <div className="ccp-transcript-wrap"><div className="ccp-transcript"><div className="ccp-notice ccp-notice-error">{detailQuery.error?.message || "Unable to load Codex thread"}</div></div></div>}

        {detailQuery.isError && detail ? <div className="ccp-notice ccp-notice-error">{detailQuery.error.message} <button onClick={() => void refresh()}>Retry</button></div> : null}
        {statusQuery.error && activeSessionId ? <div className="ccp-notice ccp-notice-error">{statusQuery.error.message} <button onClick={() => void statusQuery.refetch()}>Retry catalog</button></div> : null}
        {settingsReady && model && !statusQuery.data?.models.some(entry => entry.id === model) ? <div className="ccp-notice ccp-notice-error">The saved model is unavailable. Select a model from the current catalog.</div> : null}
        {operation ? <div className="ccp-flash" role="status">{operation}</div> : null}
        {flash ? <div className="ccp-flash" role="status">{flash}</div> : null}
        <CodexComposer
          key={`composer:${activeSessionId ?? newDraftKey}`}
          drafts={drafts}
          draftKey={activeSessionId ? `session:${activeSessionId}` : newDraftKey}
          ready={ready}
          settingsReady={settingsReady}
          settingsBusy={Boolean(operation)}
          status={statusQuery.data}
          activeSessionId={activeSessionId}
          activeTurn={activeTurn}
          workspaceId={workspaceId}
          mode={mode}
          model={model}
          effort={effort}
          serviceTier={serviceTier}
          skills={(skillsQuery.data?.skills ?? []).filter((skill) => skill.enabled !== false).map((skill) => skill.name)}
          onWorkspaceChange={setWorkspaceId}
          onModeChange={(value) => invoke(() => applySettings({ mode: value }))}
          onModelChange={(value) => invoke(() => applySettings({ model: value }))}
          onEffortChange={(value) => invoke(() => applySettings({ effort: value }))}
          onServiceTierChange={(value) => invoke(() => applySettings({ serviceTier: value }))}
          onSubmit={submit}
          onInterrupt={() => invoke(interrupt)}
          onCommand={command}
        />
        <footer className="ccp-statusbar">
          <button type="button" className={`ccp-status-mode ${mode === "yolo" ? "ccp-mode-execute" : "ccp-mode-research"}`} disabled={!settingsReady || Boolean(operation)} onClick={() => invoke(() => applySettings({ mode: mode === "read-only" ? "yolo" : "read-only" }))}>{mode === "yolo" ? <><Icon name="zap" size={12} /> YOLO</> : <><Icon name="diamond" size={12} /> Read Only</>}</button>
          <span className="ccp-status-sep">│</span><span className="ccp-status-item">{model || "loading model…"}</span><span className="ccp-status-item">{effort || "default"}</span>
          {serviceTier ? <span className="ccp-status-item">{serviceTier}</span> : null}
          <span className="ccp-status-sep">│</span><span className="ccp-status-item ccp-status-cwd" title={currentCwd}>{currentCwd || "~"}</span>
          {contextLeft != null ? <><span className="ccp-status-sep">│</span><span className="ccp-status-item">{contextLeft.toFixed(0)}% ctx left</span></> : null}
          <span className="ccp-status-spacer" /><span className={`ccp-status-conn ${connHealth === "offline" ? "is-stale" : ""}`}>{activeSessionId ? connHealth : `CLI ${statusQuery.data?.cliVersion || "…"}`}</span>
          <button type="button" className="ccp-status-shortcuts" onClick={() => setShortcutsOpen(true)}>?</button>
        </footer>
      </main>

      <CodexPalette open={paletteOpen} sessions={sessionsQuery.data ?? []} actions={paletteActions} onSelectSession={setActiveSessionId} onClose={() => setPaletteOpen(false)} />
      <CodexInspector open={inspector.open} tab={inspector.tab} sessionId={activeSessionId} onClose={() => setInspector((current) => ({ ...current, open: false }))} />
      <CodexShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

function CodexWelcome({ model, mode, cwd, error, cliVersion, legacySessions }: { model?: string; mode: CodexMode; cwd?: string; error?: string; cliVersion?: string; legacySessions?: number }) {
  return (
    <div className="ccp-transcript-wrap">
      <div className="ccp-welcome">
        <div className="ccp-welcome-box">
          <div className="ccp-welcome-logo"><Icon name="terminal" size={16} /> Codex App Server</div>
          <div className="ccp-welcome-meta"><div><span className="ccp-welcome-key">model</span>{model || "loading…"}</div><div><span className="ccp-welcome-key">mode</span>{mode === "yolo" ? "YOLO · full host access" : "Read Only · no writes or network"}</div><div><span className="ccp-welcome-key">cwd</span>{cwd || "choose a workspace"}</div><div><span className="ccp-welcome-key">cli</span>{cliVersion || "…"}</div></div>
          <div className="ccp-welcome-tip">Send a prompt to create a native Codex thread. Use <code>@file</code>, <code>/commands</code>, <code>Shift+Tab</code> for mode, and <code>!command</code> in YOLO.</div>
          {legacySessions ? <div className="codex-legacy-note">{legacySessions} transcript{legacySessions === 1 ? "" : "s"} from the retired exec bridge are preserved separately and intentionally not offered as resumable App Server threads.</div> : null}
          {error ? <div className="ccp-notice ccp-notice-error">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
