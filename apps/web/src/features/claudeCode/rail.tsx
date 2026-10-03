import { QueryError } from "../../shared/ui/QueryError";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ClaudeCodeSessionSummary } from "@tracyhill-rp/contracts";

import {
  deleteClaudeCodeSession,
  downloadClaudeCodeExport,
  getClaudeCodeSessions,
  patchClaudeCodeSession,
} from "./claudeCodeApi";
import { useCodingBackend } from "./backend";
import { sessionLabel } from "./sessionLabel";
import { Icon } from "../../shared/ui/Icon";

type RailProps = {
  open: boolean;
  onToggle: () => void;
  activeSessionId: string | null;
  onSelect: (sessionId: string | null) => void;
  // A session was deleted: the page drops its remembered permission mode.
  onDeleted?: (sessionId: string) => void;
};

export function SessionRail({ open, onToggle, activeSessionId, onSelect, onDeleted }: RailProps) {
  const { apiBase, sessionsKey } = useCodingBackend();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  // Read at resolution time: a slow delete of A must not deselect the B the
  // user picked meanwhile (the Codex rail does the same).
  const selectedId = useRef(activeSessionId); selectedId.current = activeSessionId;

  const sessionsQuery = useQuery({
    queryKey: [sessionsKey],
    queryFn: () => getClaudeCodeSessions(apiBase),
    refetchInterval: (query) => {
      // `0` would DISABLE polling: a rail that starts empty (fresh browser,
      // last session deleted) then never learned about a session started from
      // another browser/Android until something else invalidated the key.
      // Keep the idle cadence instead.
      const data = query.state.data;
      return data?.some((s) => s.active) ? 3_000 : 15_000;
    },
  });

  // A failed export (agent down, lapsed session) surfaces through the global
  // mutation-error toast instead of navigating the tab to a JSON page.
  const exportMutation = useMutation({ mutationFn: (sessionId: string) => downloadClaudeCodeExport(apiBase, sessionId) });
  // Rename, pin and delete were plain awaited calls whose rejection went
  // nowhere — the row reverted on the next poll and nothing said why. As
  // mutations, a failure reaches the global error toast.
  const patchMutation = useMutation({
    mutationFn: ({ sessionId, patch }: { sessionId: string; patch: { title?: string; pinned?: boolean } }) => patchClaudeCodeSession(apiBase, sessionId, patch),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: [sessionsKey] }); },
  });
  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteClaudeCodeSession(apiBase, sessionId),
    onSuccess: async (_, sessionId) => {
      if (selectedId.current === sessionId) onSelect(null);
      onDeleted?.(sessionId);
      await queryClient.invalidateQueries({ queryKey: [sessionsKey] });
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
        <button type="button" className="ccp-rail-toggle" title="Expand sidebar (⌘/)" onClick={onToggle}><Icon name="menu" size={16} /></button>
      </div>
    );
  }

  return (
    <aside className="ccp-rail">
      <div className="ccp-rail-head">
        <button type="button" className="ccp-rail-toggle" title="Collapse sidebar (⌘/)" onClick={onToggle}><Icon name="chevron-left" size={16} /></button>
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
        <QueryError query={sessionsQuery} label="Unable to load sessions" />
        {sessionsQuery.isLoading ? <div className="ccp-rail-muted">Loading…</div> : null}
        {sessionsQuery.isSuccess && filtered.length === 0 ? (
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
                onPatch={(patch) => patchMutation.mutate({ sessionId: s.sessionId, patch })}
                onDelete={() => deleteMutation.mutate(s.sessionId)}
                onExport={() => exportMutation.mutate(s.sessionId)}
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
  onPatch: (p: { title?: string; pinned?: boolean }) => void;
  onDelete: () => void;
  onExport: () => void;
};

function SessionRow({ session, active, onSelect, onPatch, onDelete, onExport }: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  // Enter commits and unmounts the input; the browser then fires blur on the
  // removed element, which re-ran commitRename with the same draft against the
  // not-yet-invalidated title → a second identical PATCH + audit row.
  const renameCommittedRef = useRef(false);

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

  const commitRename = () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const title = draft.trim();
    setRenaming(false);
    if (title && title !== session.title) onPatch({ title });
  };
  const startRename = () => { renameCommittedRef.current = false; setDraft(session.title ?? ""); setRenaming(true); };

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
            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
            else if (e.key === "Escape") { renameCommittedRef.current = true; setRenaming(false); setDraft(session.title ?? ""); }
          }}
        />
      ) : (
        <button type="button" className="ccp-rail-row-btn" onClick={onSelect}>
          {session.active ? <span className="ccp-live-dot" title="Active now" /> : null}
          {session.pinned ? <span className="ccp-pin-icon" title="Pinned"><Icon name="pin" size={11} /></span> : null}
          <span className="ccp-rail-row-title">{sessionLabel(session)}</span>
        </button>
      )}
      {menuOpen && menuPos ? (
        <div className="ccp-rail-menu" style={{ top: menuPos.y, left: menuPos.x }} onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => { setMenuOpen(false); startRename(); }}>Rename</button>
          <button type="button" onClick={() => { setMenuOpen(false); onPatch({ pinned: !session.pinned }); }}>
            {session.pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" onClick={() => { setMenuOpen(false); onExport(); }}>Export Markdown</button>
          <div className="ccp-rail-menu-sep" />
          {confirmingDelete ? (
            <button type="button" className="danger" onClick={() => { setMenuOpen(false); setConfirmingDelete(false); onDelete(); }}>Confirm Delete</button>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>Delete</button>
          )}
        </div>
      ) : null}
    </div>
  );
}
