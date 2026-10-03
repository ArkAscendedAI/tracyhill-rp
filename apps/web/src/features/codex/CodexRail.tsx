import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CodexSessionResponse, CodexSessionSummary } from "@tracyhill-rp/contracts";

import { applyCodexMetadata } from "./codexMetadata";
import { createUserScopedCacheWriter } from "../auth/authCache";

import { archiveCodexSession, deleteCodexSession, downloadCodexExport, getCodexSessions, patchCodexSession, unarchiveCodexSession } from "./codexApi";
import { Icon } from "../../shared/ui/Icon";

type Props = {
  open: boolean;
  onToggle: () => void;
  activeSessionId: string | null;
  onSelect: (sessionId: string | null) => void;
};

export function CodexRail({ open, onToggle, activeSessionId, onSelect }: Props) {
  const queryClient = useQueryClient();
  const cacheUserQuery = useRef(createUserScopedCacheWriter(queryClient)).current;
  const selectedId = useRef(activeSessionId); selectedId.current = activeSessionId;
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  // Enter commits and unmounts the input; the browser's blur on the removed
  // element re-ran saveTitle → a second identical PATCH.
  const titleCommittedRef = useRef(false);
  const [menu, setMenu] = useState<{ session: CodexSessionSummary; x: number; y: number; confirming?: boolean } | null>(null);
  const sessionsQuery = useQuery({
    queryKey: ["codex-sessions"],
    queryFn: getCodexSessions,
    refetchInterval: (query) => query.state.data?.some((session) => session.active) ? 3_000 : 15_000,
  });
  const patchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { title?: string; pinned?: boolean } }) => patchCodexSession(id, patch),
    onSuccess: async (metadata, { patch }) => {
      // Rename/pin acknowledgments only own those fields, not concurrent settings.
      const key = ["codex-session", metadata.sessionId];
      const current = queryClient.getQueryData<CodexSessionResponse>(key);
      if (current) {
        const cursor = typeof metadata.eventCursor === "number" ? metadata.eventCursor : undefined;
        let next = current;
        if (patch.title !== undefined) next = applyCodexMetadata(next, { title: metadata.title }, "title", cursor);
        if (patch.pinned !== undefined) next = applyCodexMetadata(next, { pinned: metadata.pinned }, "pinned", cursor);
        cacheUserQuery(key, next);
      }
      await queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
    },
  });
  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => archived ? unarchiveCodexSession(id) : archiveCodexSession(id),
    onSuccess: async (_, { id, archived }) => {
      if (!archived && selectedId.current === id) onSelect(null);
      setMenu(current => current?.session.sessionId === id ? null : current);
      await queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: deleteCodexSession,
    onSuccess: async (_, id) => {
      if (selectedId.current === id) onSelect(null);
      setMenu(current => current?.session.sessionId === id ? null : current);
      await queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
    },
  });
  const exportMutation = useMutation({ mutationFn: downloadCodexExport });
  const filtered = useMemo(() => {
    const sessions = sessionsQuery.data ?? [];
    const query = search.trim().toLowerCase();
    return query ? sessions.filter((session) => [session.title, session.preview, session.cwd, session.sessionId].some((value) => value?.toLowerCase().includes(query))) : sessions;
  }, [search, sessionsQuery.data]);
  const grouped = useMemo(() => groupSessions(filtered), [filtered]);

  if (!open) return <div className="ccp-rail ccp-rail-collapsed"><button type="button" className="ccp-rail-toggle" title="Expand sidebar (⌘/)" onClick={onToggle}><Icon name="menu" size={16} /></button></div>;

  const beginEdit = (session: CodexSessionSummary) => {
    titleCommittedRef.current = false;
    setEditingId(session.sessionId);
    setEditTitle(session.title || session.preview || "");
  };
  const saveTitle = (sessionId: string) => {
    if (titleCommittedRef.current) return;
    titleCommittedRef.current = true;
    const title = editTitle.trim();
    if (title) patchMutation.mutate({ id: sessionId, patch: { title } });
    setEditingId(null);
  };

  return (
    <aside className="ccp-rail">
      <div className="ccp-rail-head">
        <button type="button" className="ccp-rail-toggle" title="Collapse sidebar (⌘/)" onClick={onToggle}><Icon name="chevron-left" size={16} /></button>
        <button type="button" className="ccp-rail-new" onClick={() => onSelect(null)}>+ New</button>
      </div>
      <div className="ccp-rail-search"><input type="search" placeholder="Search Codex sessions…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <div className="ccp-rail-list">
        {sessionsQuery.isLoading ? <div className="ccp-rail-muted">Loading…</div> : null}
        {sessionsQuery.error ? <div className="ccp-rail-muted">{sessionsQuery.error.message}</div> : null}
        {/* Empty-state copy only for a successful read; a failed one shows its error above. */}
        {sessionsQuery.isSuccess && !filtered.length ? <div className="ccp-rail-muted">No App Server sessions yet.</div> : null}
        {grouped.map(([label, sessions]) => (
          <div key={label}>
            <div className="ccp-rail-group-label">{label}</div>
            {sessions.map((session) => (
              <div key={session.sessionId} className={`ccp-rail-row ${activeSessionId === session.sessionId ? "is-active" : ""} ${session.active ? "is-live" : ""}`}>
                {editingId === session.sessionId ? (
                  <input
                    autoFocus
                    maxLength={200} className="ccp-rail-row-rename"
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    onBlur={() => saveTitle(session.sessionId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveTitle(session.sessionId);
                      if (event.key === "Escape") { titleCommittedRef.current = true; setEditingId(null); }
                    }}
                  />
                ) : (
                  <div className="codex-rail-row-controls" onContextMenu={(event) => { event.preventDefault(); setMenu({ session, x: event.clientX, y: event.clientY }); }}>
                    <button
                      type="button"
                      className="ccp-rail-row-btn"
                      onClick={() => onSelect(session.sessionId)}
                      onDoubleClick={() => beginEdit(session)}
                      title={`${session.cwd || ""}\n${session.mode === "yolo" ? "YOLO" : "Read Only"}`}
                    >
                      {session.active ? <span className="ccp-live-dot" /> : <span className="codex-rail-mode"><Icon name={session.mode === "yolo" ? "zap" : "diamond"} size={11} /></span>}
                      <span className="ccp-rail-row-title">{session.title || session.preview || session.sessionId.slice(0, 8)}</span>
                      {session.pinned ? <span className="ccp-pin-icon"><Icon name="pin" size={11} /></span> : null}
                    </button>
                    <button type="button" className="codex-rail-more" aria-label="Session actions" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ session, x: rect.right, y: rect.bottom }); }}>⋯</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {menu ? (
        <>
          <button type="button" className="codex-menu-scrim" aria-label="Close session menu" onClick={() => setMenu(null)} />
          <div className="ccp-rail-menu" style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 230) }}>
            {menu.confirming ? (
              <>
                <span className="codex-menu-confirm">Delete this native Codex thread?</span>
                <button type="button" onClick={() => setMenu({ ...menu, confirming: false })}>Cancel</button>
                <button type="button" className="danger" onClick={() => deleteMutation.mutate(menu.session.sessionId)} disabled={deleteMutation.isPending}>Delete permanently</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => { beginEdit(menu.session); setMenu(null); }}>Rename</button>
                <button type="button" onClick={() => { patchMutation.mutate({ id: menu.session.sessionId, patch: { pinned: !menu.session.pinned } }); setMenu(null); }}>{menu.session.pinned ? "Unpin" : "Pin"}</button>
                <button type="button" onClick={() => { exportMutation.mutate(menu.session.sessionId); setMenu(null); }}>Export markdown</button>
                <div className="ccp-rail-menu-sep" />
                <button type="button" onClick={() => archiveMutation.mutate({ id: menu.session.sessionId, archived: Boolean(menu.session.archived) })} disabled={menu.session.active}>{menu.session.archived ? "Unarchive" : "Archive"}</button>
                <button type="button" className="danger" onClick={() => setMenu({ ...menu, confirming: true })}>Delete…</button>
              </>
            )}
          </div>
        </>
      ) : null}
    </aside>
  );
}

function groupSessions(sessions: CodexSessionSummary[]): Array<[string, CodexSessionSummary[]]> {
  const groups = new Map<string, CodexSessionSummary[]>();
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  for (const session of sessions) {
    const time = new Date(session.updatedAt || session.createdAt || 0).getTime();
    const age = startToday - time;
    const label = session.archived ? "Archived" : session.pinned ? "Pinned" : age < 0 ? "Today" : age < 86_400_000 ? "Yesterday" : age < 7 * 86_400_000 ? "This week" : "Older";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(session);
  }
  const order = ["Pinned", "Today", "Yesterday", "This week", "Older", "Archived"];
  return order.flatMap((label) => groups.has(label) ? [[label, groups.get(label)!] as [string, CodexSessionSummary[]]] : []);
}
