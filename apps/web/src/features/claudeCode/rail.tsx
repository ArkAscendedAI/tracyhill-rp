import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ClaudeCodeSessionSummary } from "@tracyhill-rp/contracts";

import {
  deleteClaudeCodeSession,
  downloadClaudeCodeExport,
  getClaudeCodeSessions,
  patchClaudeCodeSession,
} from "./claudeCodeApi";

type RailProps = {
  open: boolean;
  onToggle: () => void;
  activeSessionId: string | null;
  onSelect: (sessionId: string | null) => void;
};

export function SessionRail({ open, onToggle, activeSessionId, onSelect }: RailProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const sessionsQuery = useQuery({
    queryKey: ["claude-code-sessions"],
    queryFn: getClaudeCodeSessions,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data?.length) return 0;
      return data.some((s) => s.active) ? 3_000 : 15_000;
    },
  });

  const sessions = sessionsQuery.data ?? [];
  const filtered = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.trim().toLowerCase();
    return sessions.filter((s) =>
      (s.title || "").toLowerCase().includes(q) ||
      (s.lastPrompt || "").toLowerCase().includes(q) ||
      (s.sessionId || "").toLowerCase().includes(q),
    );
  }, [sessions, search]);

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);

  if (!open) {
    return (
      <div className="ccp-rail ccp-rail-collapsed">
        <button type="button" className="ccp-rail-toggle" title="Expand sidebar (⌘/)" onClick={onToggle}>☰</button>
      </div>
    );
  }

  return (
    <aside className="ccp-rail">
      <div className="ccp-rail-head">
        <button type="button" className="ccp-rail-toggle" title="Collapse sidebar (⌘/)" onClick={onToggle}>«</button>
        <button type="button" className="ccp-rail-new" title="New session" onClick={() => onSelect(null)}>+ New</button>
      </div>
      <div className="ccp-rail-search">
        <input
          type="search"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="ccp-rail-list">
        {sessionsQuery.isLoading ? <div className="ccp-rail-muted">Loading…</div> : null}
        {!sessionsQuery.isLoading && filtered.length === 0 ? (
          <div className="ccp-rail-muted">{search.trim() ? "No matches." : "No sessions yet."}</div>
        ) : null}
        {grouped.map(({ label, items }) => (
          <section key={label}>
            <div className="ccp-rail-group-label">{label}</div>
            {items.map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                active={s.sessionId === activeSessionId}
                onSelect={() => onSelect(s.sessionId)}
                onPatch={async (patch) => {
                  await patchClaudeCodeSession(s.sessionId, patch);
                  await queryClient.invalidateQueries({ queryKey: ["claude-code-sessions"] });
                }}
                onDelete={async () => {
                  await deleteClaudeCodeSession(s.sessionId);
                  if (s.sessionId === activeSessionId) onSelect(null);
                  await queryClient.invalidateQueries({ queryKey: ["claude-code-sessions"] });
                }}
                onExport={() => downloadClaudeCodeExport(s.sessionId)}
              />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

function groupByDate(sessions: ClaudeCodeSessionSummary[]): { label: string; items: ClaudeCodeSessionSummary[] }[] {
  const now = Date.now();
  const pinned: ClaudeCodeSessionSummary[] = [];
  const today: ClaudeCodeSessionSummary[] = [];
  const yesterday: ClaudeCodeSessionSummary[] = [];
  const week: ClaudeCodeSessionSummary[] = [];
  const older: ClaudeCodeSessionSummary[] = [];
  const dayMs = 24 * 3600_000;
  for (const s of sessions) {
    if (s.pinned) { pinned.push(s); continue; }
    const ts = s.updatedAt ? new Date(s.updatedAt).getTime() : s.createdAt ? new Date(s.createdAt).getTime() : 0;
    const age = now - ts;
    if (age < dayMs) today.push(s);
    else if (age < 2 * dayMs) yesterday.push(s);
    else if (age < 7 * dayMs) week.push(s);
    else older.push(s);
  }
  return [
    { label: "Pinned", items: pinned },
    { label: "Today", items: today },
    { label: "Yesterday", items: yesterday },
    { label: "This Week", items: week },
    { label: "Older", items: older },
  ].filter((g) => g.items.length > 0);
}

type RowProps = {
  session: ClaudeCodeSessionSummary;
  active: boolean;
  onSelect: () => void;
  onPatch: (p: { title?: string; pinned?: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
  onExport: () => void;
};

function SessionRow({ session, active, onSelect, onPatch, onDelete, onExport }: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) {
      // Disarm the delete confirmation when the menu closes — it used to stay
      // armed, so reopening the menu later showed "Confirm Delete" where one
      // accidental click irreversibly deleted the session.
      setConfirmingDelete(false);
      return;
    }
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  };

  const commitRename = async () => {
    const title = draft.trim();
    if (title && title !== session.title) await onPatch({ title });
    setRenaming(false);
  };

  return (
    <div ref={rowRef} className={`ccp-rail-row ${active ? "is-active" : ""} ${session.active ? "is-live" : ""}`} onContextMenu={onContext}>
      {renaming ? (
        <input
          className="ccp-rail-row-rename"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
            else if (e.key === "Escape") { setRenaming(false); setDraft(session.title ?? ""); }
          }}
        />
      ) : (
        <button type="button" className="ccp-rail-row-btn" onClick={onSelect}>
          {session.active ? <span className="ccp-live-dot" title="Active now" /> : null}
          {session.pinned ? <span className="ccp-pin-icon" title="Pinned">📌</span> : null}
          <span className="ccp-rail-row-title">{session.title || session.lastPrompt?.slice(0, 60) || session.sessionId.slice(0, 8)}</span>
        </button>
      )}
      {menuOpen && menuPos ? (
        <div className="ccp-rail-menu" style={{ top: menuPos.y, left: menuPos.x }} onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => { setMenuOpen(false); setRenaming(true); setDraft(session.title ?? ""); }}>Rename</button>
          <button type="button" onClick={() => { setMenuOpen(false); void onPatch({ pinned: !session.pinned }); }}>
            {session.pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" onClick={() => { setMenuOpen(false); onExport(); }}>Export Markdown</button>
          <div className="ccp-rail-menu-sep" />
          {confirmingDelete ? (
            <button type="button" className="danger" onClick={() => { setMenuOpen(false); setConfirmingDelete(false); void onDelete(); }}>Confirm Delete</button>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>Delete</button>
          )}
        </div>
      ) : null}
    </div>
  );
}
