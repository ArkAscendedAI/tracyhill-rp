import { useEffect, useMemo, useRef, useState } from "react";

import type { Folder, SessionSummary } from "@tracyhill-rp/contracts";

import { Icon } from "../../shared/ui/Icon";
import type { IconName } from "../../shared/ui/iconSprite";
import { getFolderPathLabel } from "./folderTree";

/**
 * Ctrl/⌘+K command palette for the workspace shell.
 * Jumps to any session by name (folder path shown, most recent first when the query is
 * empty) and runs shell actions (new session/folder, the panels, account and admin
 * dialogs, the coding panels, log out). Keyboard: ↑/↓ move, Enter runs, Esc closes.
 * Purely a launcher: it calls the same handlers the rail and sidebar call, so nothing
 * here owns state. The coding panels keep their own ⌘K palettes; the shell handler
 * yields while one of them is open.
 */
export type PaletteAction = { id: string; label: string; hint?: string; icon: IconName; danger?: boolean; run: () => void };

type Props = {
  open: boolean;
  onClose: () => void;
  sessions: SessionSummary[];
  folders: Folder[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  actions: PaletteAction[];
};

type Row = { key: string; kind: "session" | "action"; label: string; hint: string | null; icon: IconName; danger?: boolean; run: () => void };

/** 0 = no match; higher is better. Prefix > word start > substring > subsequence. */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 100 - Math.min(t.length - q.length, 40);
  const wordStart = t.split(/[\s/·\-_]+/).some((w) => w.startsWith(q));
  if (wordStart) return 80;
  const at = t.indexOf(q);
  if (at >= 0) return 60 - Math.min(at, 30);
  let i = 0;
  for (const ch of t) { if (ch === q[i]) i += 1; if (i === q.length) return 20; }
  return 0;
}

export function CommandPalette({ open, onClose, sessions, folders, activeSessionId, onSelectSession, actions }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const trimmed = query.trim();
    const live = sessions.filter((s) => !s.deletedAt && s.sessionType !== "wizard");
    const sessionRows = live
      .map((s) => ({ s, sc: score(trimmed, s.name) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc || (b.s.lastMessageAt ?? "").localeCompare(a.s.lastMessageAt ?? ""))
      .slice(0, trimmed ? 10 : 8)
      .map(({ s }): Row => ({
        key: `session:${s.id}`, kind: "session", label: s.name,
        hint: [getFolderPathLabel(folders, s.folderId), `${s.messageCount} msgs`, s.id === activeSessionId ? "current" : null].filter(Boolean).join(" · ") || null,
        icon: "message", run: () => onSelectSession(s.id),
      }));
    const actionRows = actions
      .map((a) => ({ a, sc: score(trimmed, a.label) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .map(({ a }): Row => ({ key: `action:${a.id}`, kind: "action", label: a.label, hint: a.hint ?? null, icon: a.icon, danger: a.danger, run: a.run }));
    return [...sessionRows, ...actionRows];
  }, [query, sessions, folders, activeSessionId, onSelectSession, actions]);

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, rows.length]);

  if (!open) return null;

  const runRow = (row: Row) => { onClose(); row.run(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(rows.length - 1, 0))); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const row = rows[cursor]; if (row) runRow(row); }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
  };
  const firstAction = rows.findIndex((r) => r.kind === "action");

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette-input-row">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            className="palette-input"
            aria-label="Command palette search"
            placeholder="Jump to a session or run a command…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="palette-kbd">esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox" aria-label="Results">
          {rows.length === 0 ? <div className="palette-empty muted">No matches.</div> : null}
          {rows.map((row, index) => (
            <div key={row.key}>
              {index === 0 && row.kind === "session" ? <div className="palette-group">Sessions</div> : null}
              {index === firstAction ? <div className="palette-group">Commands</div> : null}
              <button
                type="button"
                role="option"
                aria-selected={index === cursor}
                data-index={index}
                className={`palette-row${index === cursor ? " is-active" : ""}${row.danger ? " is-danger" : ""}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => runRow(row)}
              >
                <Icon name={row.icon} size={16} />
                <span className="palette-row-label">{row.label}</span>
                {row.hint ? <span className="palette-row-hint">{row.hint}</span> : null}
              </button>
            </div>
          ))}
        </div>
        <div className="palette-foot muted">↑↓ navigate · Enter open · Ctrl/⌘ K toggle</div>
      </div>
    </div>
  );
}
