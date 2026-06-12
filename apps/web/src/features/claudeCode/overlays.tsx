import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getClaudeCodeSessions } from "./claudeCodeApi";

// ─── Command Palette (Cmd+K) ─────────────────────────────────────────────────

type PaletteItem =
  | { kind: "session"; sessionId: string; title: string; active?: boolean }
  | { kind: "command"; name: string; desc: string; run: () => void };

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onExit: () => void;
  onToggleRail: () => void;
};

export function CommandPalette({ open, onClose, onSelectSession, onNewSession, onExit, onToggleRail }: CommandPaletteProps) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const sessionsQuery = useQuery({ queryKey: ["claude-code-sessions"], queryFn: getClaudeCodeSessions, enabled: open });
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const items: PaletteItem[] = useMemo(() => {
    const commands: PaletteItem[] = [
      { kind: "command", name: "New session", desc: "Start a new Claude Code session", run: onNewSession },
      { kind: "command", name: "Toggle sidebar", desc: "Show/hide the session rail", run: onToggleRail },
      { kind: "command", name: "Exit Claude Code", desc: "Return to the RP workspace", run: onExit },
    ];
    const sessions: PaletteItem[] = (sessionsQuery.data ?? []).map((s) => ({
      kind: "session",
      sessionId: s.sessionId,
      title: s.title || s.lastPrompt?.slice(0, 60) || s.sessionId.slice(0, 8),
      active: s.active,
    }));
    const all = [...commands, ...sessions];
    if (!q.trim()) return all;
    const qq = q.trim().toLowerCase();
    return all.filter((it) => it.kind === "session" ? it.title.toLowerCase().includes(qq) : it.name.toLowerCase().includes(qq) || it.desc.toLowerCase().includes(qq));
  }, [sessionsQuery.data, q, onNewSession, onToggleRail, onExit]);

  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;

  const choose = (it: PaletteItem) => {
    if (it.kind === "session") onSelectSession(it.sessionId);
    else it.run();
    onClose();
  };

  return (
    <div className="ccp-palette-backdrop" onClick={onClose}>
      <div className="ccp-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="ccp-palette-input"
          placeholder="Jump to a session or run a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); return; }
            if (e.key === "Enter" && items[sel]) { e.preventDefault(); choose(items[sel]!); return; }
          }}
        />
        <div className="ccp-palette-list">
          {items.length === 0 ? <div className="ccp-palette-empty">No matches.</div> : null}
          {items.map((it, i) => (
            <button
              key={it.kind === "session" ? it.sessionId : it.name}
              type="button"
              className={`ccp-palette-row ${i === sel ? "is-sel" : ""}`}
              onClick={() => choose(it)}
              onMouseEnter={() => setSel(i)}
            >
              {it.kind === "session" ? (
                <>
                  <span className="ccp-palette-kind">session</span>
                  {it.active ? <span className="ccp-live-dot" /> : null}
                  <span>{it.title}</span>
                </>
              ) : (
                <>
                  <span className="ccp-palette-kind">command</span>
                  <span>{it.name}</span>
                  <span className="ccp-palette-desc">{it.desc}</span>
                </>
              )}
            </button>
          ))}
        </div>
        <div className="ccp-palette-hint">↑↓ navigate · Enter select · Esc close</div>
      </div>
    </div>
  );
}
