import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { CodexSessionSummary } from "@tracyhill-rp/contracts";

import { getCodexDoctor, getCodexMcp, getCodexSkills } from "./codexApi";

export type InspectorTab = "doctor" | "skills" | "mcp";

export function CodexInspector({ open, tab: requestedTab, sessionId, onClose }: { open: boolean; tab: InspectorTab; sessionId: string | null; onClose: () => void }) {
  const dialog = useCodexDialog(open);
  const [tab, setTab] = useState<InspectorTab>(requestedTab);
  useEffect(() => { if (open) setTab(requestedTab); }, [open, requestedTab]);
  const doctor = useQuery({ queryKey: ["codex-doctor", sessionId], queryFn: () => getCodexDoctor(sessionId ?? undefined), enabled: open && tab === "doctor" });
  const skills = useQuery({ queryKey: ["codex-skills", sessionId], queryFn: () => getCodexSkills(sessionId ?? undefined), enabled: open && tab === "skills" });
  const mcp = useQuery({ queryKey: ["codex-mcp", sessionId], queryFn: () => getCodexMcp(sessionId ?? undefined), enabled: open && tab === "mcp" });
  if (!open) return null;
  const current = { doctor, skills, mcp }[tab];
  const error = current.error;
  return (
    <div className="ccp-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialog} className="codex-inspector" role="dialog" aria-modal="true" aria-label="Codex inspector">
        <header className="codex-inspector-head"><strong>Codex CLI</strong><span>{sessionId ? sessionId.slice(0, 8) : "global"}</span><button type="button" onClick={onClose}>×</button></header>
        <nav className="codex-inspector-tabs">{(["doctor", "skills", "mcp"] as const).map((entry) => <button type="button" key={entry} className={tab === entry ? "is-active" : ""} onClick={() => setTab(entry)}>{entry === "mcp" ? "MCP" : entry[0].toUpperCase() + entry.slice(1)}</button>)}</nav>
        <div className="codex-inspector-body">
          {error ? <div className="ccp-notice ccp-notice-error">{error.message} <button type="button" onClick={() => void current.refetch()}>Retry</button></div> : null}
          {tab === "doctor" ? doctor.isLoading ? <div className="ccp-rail-muted">Running diagnostics…</div> : doctor.data ? <><div className="codex-diagnostic-grid"><span>App Server</span><strong>{doctor.data.bridge.ready ? "ready" : "offline"}</strong><span>Active sessions</span><strong>{doctor.data.bridge.activeSessions}</strong><span>Warnings</span><strong>{doctor.data.bridge.warnings.length}</strong></div><pre className="codex-inspector-pre">{JSON.stringify(doctor.data.doctor, null, 2)}</pre></> : null : null}
          {tab === "skills" ? skills.isLoading ? <div className="ccp-rail-muted">Loading skills…</div> : <div className="codex-inspector-list">{(skills.data?.skills ?? []).map((skill) => <article key={`${skill.name}:${skill.path || ""}`}><strong>{skill.name}</strong><span>{skill.enabled === false ? "disabled" : skill.scope || "skill"}</span><p>{skill.description || "No description"}</p>{skill.path ? <code>{skill.path}</code> : null}</article>)}</div> : null}
          {tab === "mcp" ? mcp.isLoading ? <div className="ccp-rail-muted">Loading MCP servers…</div> : <div className="codex-inspector-list">{(mcp.data?.servers ?? []).map((server) => <article key={server.name}><strong>{server.name}</strong><span>{server.authStatus || "unknown"}</span>{server.tools.length ? <p>{server.tools.map((tool) => tool.title || tool.name).join(" · ")}</p> : <p>No tools advertised</p>}</article>)}</div> : null}
        </div>
      </section>
    </div>
  );
}

export function CodexShortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useCodexDialog(open);
  if (!open) return null;
  const shortcuts = [["Enter", "Send or steer"], ["Shift + Enter", "New line"], ["Shift + Tab", "Toggle Read Only / YOLO"], ["Esc", "Interrupt active turn"], ["⌘/ Ctrl+/", "Toggle session rail"], ["⌘K Ctrl+K", "Command palette"], ["@path", "Attach workspace file"], ["!command", "Run shell command (YOLO only)"], ["/command", "Panel or skill command"]];
  return <div className="ccp-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="codex-shortcuts" role="dialog" aria-modal="true"><header><strong>Codex shortcuts</strong><button type="button" onClick={onClose}>×</button></header>{shortcuts.map(([key, label]) => <div key={key}><kbd>{key}</kbd><span>{label}</span></div>)}</section></div>;
}

export type CodexPaletteAction = { name: string; description: string; run: () => void };

export function CodexPalette({ open, sessions, actions, onSelectSession, onClose }: { open: boolean; sessions: CodexSessionSummary[]; actions: CodexPaletteAction[]; onSelectSession: (id: string) => void; onClose: () => void }) {
  const dialog = useCodexDialog(open);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (open) { setQuery(""); setSelection(0); } }, [open]);
  const entries = useMemo(() => {
    const value = query.trim().toLowerCase();
    const all = [
      ...actions.map((action) => ({ key: `action:${action.name}`, kind: "Command", label: action.name, description: action.description, run: action.run })),
      ...sessions.map((session) => ({ key: `session:${session.sessionId}`, kind: "Session", label: session.title || session.preview || session.sessionId.slice(0, 8), description: session.mode === "yolo" ? "YOLO" : "Read Only", run: () => onSelectSession(session.sessionId) })),
    ];
    return value ? all.filter((entry) => `${entry.label} ${entry.description}`.toLowerCase().includes(value)).slice(0, 30) : all.slice(0, 30);
  }, [actions, onSelectSession, query, sessions]);
  useEffect(() => { setSelection(value => Math.max(0, Math.min(value, entries.length - 1))); }, [entries.length]);
  useEffect(() => { list.current?.querySelector(".is-sel")?.scrollIntoView({ block: "nearest" }); }, [selection]);
  if (!open) return null;
  const choose = (index: number) => { if (entries[index]) { entries[index].run(); onClose(); } };
  return (
    <div className="ccp-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialog} className="ccp-palette" role="dialog" aria-modal="true" aria-label="Codex command palette">
        <input autoFocus className="ccp-palette-input" placeholder="Search commands and sessions…" value={query} onChange={(event) => { setQuery(event.target.value); setSelection(0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSelection((value) => Math.max(0, Math.min(entries.length - 1, value + 1))); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setSelection((value) => Math.max(0, value - 1)); }
          else if (event.key === "Enter") { event.preventDefault(); choose(selection); }
          else if (event.key === "Escape") onClose();
        }} />
        <div ref={list} className="ccp-palette-list">{entries.length ? entries.map((entry, index) => <button type="button" key={entry.key} className={`ccp-palette-row ${selection === index ? "is-sel" : ""}`} onMouseEnter={() => setSelection(index)} onClick={() => choose(index)}><span className="ccp-palette-kind">{entry.kind}</span><span>{entry.label}</span><span className="ccp-palette-desc">{entry.description}</span></button>) : <div className="ccp-palette-empty">No matches</div>}</div>
        <div className="ccp-palette-hint">↑↓ navigate · enter select · esc close</div>
      </section>
    </div>
  );
}

/** Modal keyboard navigation stays inside its visible controls. */
function useCodexDialog(open: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open || !ref.current) return;
    const element = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')).filter(node => node.offsetParent !== null);
    controls()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = controls(); const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    element.addEventListener("keydown", trap);
    return () => { element.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  return ref;
}
