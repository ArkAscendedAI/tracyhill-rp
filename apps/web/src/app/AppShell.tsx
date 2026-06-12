import { useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CurrentUser, Folder, SessionSummary, WorkspaceStateResponse } from "@tracyhill-rp/contracts";

import { AdminAuditDialog } from "../features/admin/AdminAuditDialog";
import { AdminStorageDialog } from "../features/admin/AdminStorageDialog";
import { AdminUsersDialog } from "../features/admin/AdminUsersDialog";
import { CampaignPanel } from "../features/campaigns/CampaignPanel";
import { LorebookPanel } from "../features/lorebook/LorebookPanel";
import { SessionConversation } from "../features/chat/SessionConversation";
import { createEmptySessionStreamState, type SessionStreamState } from "../features/chat/sessionStreamState";
import { DeleteAccountDialog } from "../features/auth/DeleteAccountDialog";
import { MfaDialog } from "../features/auth/MfaDialog";
import { PasswordDialog } from "../features/auth/PasswordDialog";
import { ProviderKeysDialog } from "../features/auth/ProviderKeysDialog";
import { ClaudeCodePage } from "../features/claudeCode/ClaudeCodePage";
import { CodexDialog } from "../features/codex/CodexDialog";
import { getActivePipelineRuns } from "../features/pipeline/pipelineApi";
import { PipelineActivityBar } from "../features/pipeline/PipelineActivityBar";
import { SystemEventsBadge } from "../features/system/SystemEventsBadge";
import { approveWizardRun, cancelWizardRun, getActiveWizardRuns, retryWizardRun } from "../features/wizard/wizardApi";
import { WizardReviewDialog } from "../features/wizard/WizardReviewDialog";
import {
  createFolder,
  createSession,
  deleteFolder,
  deleteSession,
  emptyRecycleBin,
  permanentlyDeleteSession,
  restoreSession,
  updateFolder,
  updateSession,
  updateWorkspacePreferences,
} from "../features/workspace/workspaceApi";
import { buildFolderTree, collectDescendantFolderIds, flattenFolderOptions, getFolderDepth, MAX_FOLDER_DEPTH, getFolderPathLabel, type FolderOption, type FolderTreeNode } from "../features/workspace/folderTree";
import { useWorkspaceSearch } from "../features/workspace/useWorkspaceSearch";
import { useWorkspaceState } from "../features/workspace/useWorkspaceState";

type AppShellProps = {
  user: CurrentUser;
  onLogout: () => void;
  loggingOut: boolean;
};

export function AppShell({ user, onLogout, loggingOut }: AppShellProps) {
  const queryClient = useQueryClient();
  const workspace = useWorkspaceState();
  const [sessionStreams, setSessionStreams] = useState<Record<string, SessionStreamState>>({});
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [mfaDialogOpen, setMfaDialogOpen] = useState(false);
  const [providerKeysDialogOpen, setProviderKeysDialogOpen] = useState(false);
  const [adminUsersDialogOpen, setAdminUsersDialogOpen] = useState(false);
  const [adminStorageDialogOpen, setAdminStorageDialogOpen] = useState(false);
  const [adminAuditDialogOpen, setAdminAuditDialogOpen] = useState(false);
  const [claudeCodeFullScreen, setClaudeCodeFullScreen] = useState(false);

  // Global Cmd/Ctrl+Shift+C opens Claude Code from anywhere.
  useEffect(() => {
    if (user.role !== "admin") return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "C" || e.key === "c")) {
        e.preventDefault();
        setClaudeCodeFullScreen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [user.role]);
  const [codexDialogOpen, setCodexDialogOpen] = useState(false);
  const [deleteAccountDialogOpen, setDeleteAccountDialogOpen] = useState(false);
  const [campaignPanelOpen, setCampaignPanelOpen] = useState(false);
  const [lorebookPanelOpen, setLorebookPanelOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === "undefined" ? true : window.innerWidth > 768);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [wizardActivityCollapsed, setWizardActivityCollapsed] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const resizingRef = useRef(false);
  const [newFolderFormOpen, setNewFolderFormOpen] = useState(false);
  const [newSessionFormOpen, setNewSessionFormOpen] = useState(false);
  const [reviewingWizardRunId, setReviewingWizardRunId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState("root");
  const [newSessionName, setNewSessionName] = useState("");
  const [newSessionFolderId, setNewSessionFolderId] = useState("root");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [editingFolderParentId, setEditingFolderParentId] = useState("root");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState("");
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragTargetFolderId, setDragTargetFolderId] = useState<string | "root" | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [confirming, setConfirming] = useState<{ type: "folder" | "session" | "permanent-session" | "empty-recycle-bin" | "replace-wizard"; id: string; name: string } | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());
  const search = useWorkspaceSearch(deferredSearchQuery);
  const activePipelines = useQuery({
    queryKey: ["pipeline-active"],
    queryFn: getActivePipelineRuns,
    refetchInterval: (query) => query.state.data?.runs.some((entry) => entry.run.status === "queued" || entry.run.status === "running") ? 250 : false,
  });
  const activeWizards = useQuery({
    queryKey: ["wizard-active"],
    queryFn: getActiveWizardRuns,
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running") ? 250 : false,
  });

  const setWorkspaceState = (next: WorkspaceStateResponse) => {
    queryClient.setQueryData(["workspace-state"], next);
  };

  const createFolderMutation = useMutation({
    mutationFn: createFolder,
    onSuccess: setWorkspaceState,
  });
  const updateFolderMutation = useMutation({
    mutationFn: ({ folderId, payload }: { folderId: string; payload: Parameters<typeof updateFolder>[1] }) => updateFolder(folderId, payload),
    onSuccess: setWorkspaceState,
  });
  const deleteFolderMutation = useMutation({
    mutationFn: deleteFolder,
    onSuccess: setWorkspaceState,
  });
  const createSessionMutation = useMutation({
    mutationFn: createSession,
    onSuccess: setWorkspaceState,
  });
  const updateSessionMutation = useMutation({
    mutationFn: ({ sessionId, payload }: { sessionId: string; payload: Parameters<typeof updateSession>[1] }) => updateSession(sessionId, payload),
    onSuccess: setWorkspaceState,
  });
  const deleteSessionMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: setWorkspaceState,
  });
  const restoreSessionMutation = useMutation({
    mutationFn: restoreSession,
    onSuccess: setWorkspaceState,
  });
  const permanentlyDeleteSessionMutation = useMutation({
    mutationFn: permanentlyDeleteSession,
    onSuccess: setWorkspaceState,
  });
  const emptyRecycleBinMutation = useMutation({
    mutationFn: emptyRecycleBin,
    onSuccess: setWorkspaceState,
  });
  const updatePreferencesMutation = useMutation({
    mutationFn: updateWorkspacePreferences,
    onSuccess: setWorkspaceState,
  });
  const approveWizardMutation = useMutation({
    mutationFn: ({ runId, payload }: { runId: string; payload: Parameters<typeof approveWizardRun>[1] }) => approveWizardRun(runId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
      void queryClient.invalidateQueries({ queryKey: ["wizard-runs"] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
    },
  });
  const retryWizardMutation = useMutation({
    mutationFn: retryWizardRun,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
      void queryClient.invalidateQueries({ queryKey: ["wizard-runs"] });
    },
  });
  const cancelWizardMutation = useMutation({
    mutationFn: cancelWizardRun,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
      void queryClient.invalidateQueries({ queryKey: ["wizard-runs"] });
    },
  });

  const activeSession = useMemo(() => {
    const activeId = workspace.data?.preferences.activeSessionId;
    return workspace.data?.sessions.find((session) => session.id === activeId) ?? null;
  }, [workspace.data]);
  const prevActiveIdRef = useRef(activeSession?.id);
  useEffect(() => {
    const prevId = prevActiveIdRef.current;
    prevActiveIdRef.current = activeSession?.id;
    if (prevId && prevId !== activeSession?.id) {
      setSessionStreams((prev) => {
        const entry = prev[prevId];
        if (entry && !entry.sending) { const { [prevId]: _, ...rest } = prev; return rest; }
        return prev;
      });
    }
  }, [activeSession?.id]);
  const searchActive = searchQuery.trim().length >= 2;
  const searchResults = search.data?.results ?? [];
  const wizardSession = useMemo(() => (workspace.data?.sessions ?? []).find((session) => session.sessionType === "wizard" && !session.deletedAt) ?? null, [workspace.data]);
  const streamingSessionIds = useMemo(() => new Set(Object.entries(sessionStreams)
    .filter(([, state]) => state.sending)
    .map(([sessionId]) => sessionId)), [sessionStreams]);

  const updateSessionStream = (
    sessionId: string,
    updater: SessionStreamState | ((current: SessionStreamState) => SessionStreamState),
  ) => {
    setSessionStreams((current) => {
      const previous = current[sessionId] ?? createEmptySessionStreamState();
      const next = typeof updater === "function" ? updater(previous) : updater;
      return { ...current, [sessionId]: next };
    });
  };

  const groupedSessions = useMemo(() => {
    const folders = workspace.data?.folders ?? [];
    const sessions = (workspace.data?.sessions ?? []).filter((session) => !session.deletedAt && session.sessionType !== "wizard");
    const sessionsByFolder = new Map(folders.map((folder) => [folder.id, sessions.filter((session) => session.folderId === folder.id)]));
    return {
      tree: buildFolderTree(folders),
      sessionsByFolder,
      rootSessions: sessions.filter((session) => !session.folderId),
    };
  }, [workspace.data]);
  const folderOptions = useMemo(() => flattenFolderOptions(workspace.data?.folders ?? []), [workspace.data?.folders]);
  const deletedSessions = useMemo(() => (workspace.data?.sessions ?? []).filter((session) => Boolean(session.deletedAt)), [workspace.data]);
  const reviewingWizardRun = activeWizards.data?.runs.find((run) => run.id === reviewingWizardRunId) ?? null;

  if (workspace.isLoading) {
    return <main className="shell"><section className="card">Loading workspace...</section></main>;
  }

  if (workspace.isError || !workspace.data) {
    return (
      <main className="shell">
        <section className="card stack">
          <p className="eyebrow">TracyHill RP</p>
          <h1>Workspace unavailable</h1>
          <p className="error">{workspace.error instanceof Error ? workspace.error.message : "workspace request failed"}</p>
          <button type="button" onClick={() => workspace.refetch()}>Retry</button>
        </section>
      </main>
    );
  }

  const busy = createFolderMutation.isPending
    || updateFolderMutation.isPending
    || deleteFolderMutation.isPending
    || createSessionMutation.isPending
    || updateSessionMutation.isPending
    || deleteSessionMutation.isPending
    || restoreSessionMutation.isPending
    || permanentlyDeleteSessionMutation.isPending
    || emptyRecycleBinMutation.isPending
    || updatePreferencesMutation.isPending
    || approveWizardMutation.isPending
    || retryWizardMutation.isPending
    || cancelWizardMutation.isPending;

  const submitNewFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    createFolderMutation.mutate({
      name,
      parentId: newFolderParentId === "root" ? null : newFolderParentId,
    }, {
      onSuccess: () => {
        setNewFolderName("");
        setNewFolderParentId("root");
        setNewFolderFormOpen(false);
      },
    });
  };

  const submitNewSession = () => {
    const name = newSessionName.trim();
    createSessionMutation.mutate({
      name: name || undefined,
      sessionType: "standard",
      folderId: newSessionFolderId === "root" ? null : newSessionFolderId,
    }, {
      onSuccess: () => {
        setNewSessionName("");
        setNewSessionFolderId("root");
        setNewSessionFormOpen(false);
      },
    });
  };

  const submitWizardSession = () => {
    if (wizardSession) {
      setConfirming({ type: "replace-wizard", id: wizardSession.id, name: wizardSession.name });
      return;
    }
    createSessionMutation.mutate({ sessionType: "wizard" });
  };

  const startFolderRename = (folder: Folder) => {
    setEditingFolderId(folder.id);
    setEditingFolderName(folder.name);
    setEditingFolderParentId(folder.parentId ?? "root");
  };

  const saveFolderRename = () => {
    if (!editingFolderId) return;
    const name = editingFolderName.trim();
    if (!name) return;
    updateFolderMutation.mutate({
      folderId: editingFolderId,
      payload: {
        name,
        parentId: editingFolderParentId === "root" ? null : editingFolderParentId,
      },
    }, {
      onSuccess: () => {
        setEditingFolderId(null);
        setEditingFolderName("");
        setEditingFolderParentId("root");
      },
    });
  };

  const startSessionRename = (session: SessionSummary) => {
    setEditingSessionId(session.id);
    setEditingSessionName(session.name);
  };

  const saveSessionRename = () => {
    if (!editingSessionId) return;
    const name = editingSessionName.trim();
    if (!name) return;
    updateSessionMutation.mutate({ sessionId: editingSessionId, payload: { name } }, {
      onSuccess: () => {
        setEditingSessionId(null);
        setEditingSessionName("");
      },
    });
  };

  const moveSessionToFolder = (sessionId: string, folderId: string | null) => {
    updateSessionMutation.mutate({ sessionId, payload: { folderId } });
  };

  const handleSessionDragStart = (event: DragEvent<HTMLElement>, sessionId: string) => {
    if (busy) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sessionId);
    setDraggingSessionId(sessionId);
  };

  const handleSessionDragEnd = () => {
    setDraggingSessionId(null);
    setDragTargetFolderId(null);
  };

  const handleFolderDragOver = (folderId: string | "root") => {
    if (!draggingSessionId) return;
    setDragTargetFolderId(folderId);
  };

  const handleFolderDragLeave = (folderId: string | "root") => {
    if (dragTargetFolderId === folderId) setDragTargetFolderId(null);
  };

  const handleFolderDrop = (folderId: string | "root") => {
    if (!draggingSessionId) return;
    moveSessionToFolder(draggingSessionId, folderId === "root" ? null : folderId);
    setDraggingSessionId(null);
    setDragTargetFolderId(null);
  };

  const startSidebarResize = (event: React.MouseEvent) => {
    event.preventDefault();
    resizingRef.current = true;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = Math.max(200, Math.min(window.innerWidth * 0.5, startWidth + delta));
      setSidebarWidth(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <main className="workspace-shell">
      {sidebarOpen ? <div className="workspace-sidebar-backdrop" onClick={() => setSidebarOpen(false)} /> : null}
      <aside
        ref={sidebarRef}
        className={`workspace-sidebar${sidebarOpen ? " open" : ""}`}
        style={sidebarOpen ? { width: sidebarWidth, minWidth: 200, maxWidth: "50vw" } : undefined}
      >
        <div
          className={`sidebar-resize-handle${resizingRef.current ? " dragging" : ""}`}
          onMouseDown={startSidebarResize}
        />
        <div className="sidebar-panel">
          <div className="sidebar-header">
            <div className="sidebar-title">
              <img src="/TracyHill-RP-Logo-Horizontal.png" alt="TracyHill RP" className="sidebar-logo" />
            </div>
            <button type="button" className="sidebar-collapse-button" onClick={() => setSidebarOpen(false)}>‹</button>
          </div>

          <div className="sidebar-search-row">
            <input
              aria-label="Search workspace"
              placeholder="Search sessions and messages"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <button type="button" className="ghost-button" onClick={() => setSearchQuery("")} disabled={!searchQuery}>
              Clear
            </button>
          </div>

          <div className="sidebar-actions-row">
            <button type="button" className="secondary-button" onClick={() => {
              setNewSessionFormOpen((current) => !current);
              setNewFolderFormOpen(false);
            }}>
              {newSessionFormOpen ? "Cancel Session" : "New Session"}
            </button>
            <button type="button" className="secondary-button" onClick={() => {
              setNewFolderFormOpen((current) => !current);
              setNewSessionFormOpen(false);
            }}>
              {newFolderFormOpen ? "Cancel Folder" : "New Folder"}
            </button>
          </div>

          {newSessionFormOpen ? (
            <section className="sidebar-inline-form stack stack-tight">
              <input aria-label="New session name" placeholder="Part 1" value={newSessionName} onChange={(event) => setNewSessionName(event.target.value)} />
              <div className="inline-form">
                <select aria-label="New session folder" value={newSessionFolderId} onChange={(event) => setNewSessionFolderId(event.target.value)}>
                  <option value="root">Unfiled</option>
                  {folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                </select>
                <button type="button" onClick={submitNewSession} disabled={busy}>Create</button>
              </div>
            </section>
          ) : null}

          {newFolderFormOpen ? (
            <section className="sidebar-inline-form stack stack-tight">
              <input aria-label="New folder name" placeholder="Campaign folder" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} />
              <div className="inline-form">
                <select aria-label="New folder parent" value={newFolderParentId} onChange={(event) => setNewFolderParentId(event.target.value)}>
                  <option value="root">Root</option>
                  {folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
                </select>
                <button type="button" onClick={submitNewFolder} disabled={!newFolderName.trim() || busy}>Create</button>
              </div>
            </section>
          ) : null}

          <section className="sidebar-explorer">
            <div className="sidebar-explorer-head">
              <span>Sessions</span>
              <span className="muted small-copy">{workspace.data.sessions.filter((session) => !session.deletedAt && session.sessionType !== "wizard").length}</span>
            </div>
            <div
              className={`sidebar-root-drop${dragTargetFolderId === "root" ? " is-drop-target" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                handleFolderDragOver("root");
              }}
              onDragLeave={() => handleFolderDragLeave("root")}
              onDrop={(event) => {
                event.preventDefault();
                handleFolderDrop("root");
              }}
            >
              <FolderTree
                nodes={groupedSessions.tree}
                sessionsByFolder={groupedSessions.sessionsByFolder}
                folders={workspace.data.folders}
                folderOptions={folderOptions}
                activeSessionId={workspace.data.preferences.activeSessionId}
                editingFolderId={editingFolderId}
                editingFolderName={editingFolderName}
                editingFolderParentId={editingFolderParentId}
                editingSessionId={editingSessionId}
                editingSessionName={editingSessionName}
                draggingSessionId={draggingSessionId}
                dragTargetFolderId={dragTargetFolderId}
                streamingSessionIds={streamingSessionIds}
                busy={busy}
                setEditingFolderName={setEditingFolderName}
                setEditingFolderParentId={setEditingFolderParentId}
                setEditingSessionName={setEditingSessionName}
                onActivateSession={(sessionId) => updatePreferencesMutation.mutate({ activeSessionId: sessionId })}
                onStartFolderRename={startFolderRename}
                onSaveFolderRename={saveFolderRename}
                onPrepareChildFolder={(parentId) => setNewFolderParentId(parentId)}
                onDeleteFolder={(folder) => setConfirming({ type: "folder", id: folder.id, name: folder.name })}
                onToggleFolder={(folder) => updateFolderMutation.mutate({ folderId: folder.id, payload: { collapsed: !folder.collapsed } })}
                onStartSessionRename={startSessionRename}
                onSaveSessionRename={saveSessionRename}
                onMoveSession={moveSessionToFolder}
                onDeleteSession={(session) => setConfirming({ type: "session", id: session.id, name: session.name })}
                onSessionDragStart={handleSessionDragStart}
                onSessionDragEnd={handleSessionDragEnd}
                onFolderDragOver={handleFolderDragOver}
                onFolderDragLeave={handleFolderDragLeave}
                onFolderDrop={handleFolderDrop}
              />
              {groupedSessions.rootSessions.length ? <p className="sidebar-subhead muted small-copy">Unfiled</p> : null}
              {groupedSessions.rootSessions.length === 0 ? <p className="muted small-copy">No unfiled sessions.</p> : groupedSessions.rootSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  folderOptions={folderOptions}
                  activeSessionId={workspace.data.preferences.activeSessionId}
                  editingSessionId={editingSessionId}
                  editingSessionName={editingSessionName}
                  setEditingSessionName={setEditingSessionName}
                  onActivate={(sessionId) => updatePreferencesMutation.mutate({ activeSessionId: sessionId })}
                  onStartRename={startSessionRename}
                  onSaveRename={saveSessionRename}
                  onMove={(folderId) => moveSessionToFolder(session.id, folderId)}
                  onDelete={() => setConfirming({ type: "session", id: session.id, name: session.name })}
                  onDragStart={handleSessionDragStart}
                  onDragEnd={handleSessionDragEnd}
                  dragging={draggingSessionId === session.id}
                  streaming={streamingSessionIds.has(session.id)}
                  busy={busy}
                />
              ))}
            </div>
          </section>

          <section className="sidebar-section recycle-bin-section">
            <button type="button" className="ghost-button align-left sidebar-section-toggle" onClick={() => setRecycleBinOpen((o) => !o)}>
              <span>{recycleBinOpen ? "▾" : "▸"}</span>
              <span>Recycle Bin</span>
              <span className="muted small-copy">{deletedSessions.length}</span>
            </button>
            {recycleBinOpen ? (
              <div className="sidebar-section-body">
                {deletedSessions.length ? (
                  <button type="button" className="ghost-button small-copy danger-text" onClick={() => setConfirming({ type: "empty-recycle-bin", id: "recycle-bin", name: "Recycle Bin" })} disabled={busy}>
                    Empty Bin
                  </button>
                ) : null}
                {deletedSessions.length === 0 ? <p className="muted small-copy">Empty.</p> : deletedSessions.map((session) => (
                  <div key={session.id} className="recycle-bin-item">
                    <div className="inline-grow" style={{ minWidth: 0 }}>
                      <p className="session-row-name">{session.name}</p>
                      <p className="muted" style={{ fontSize: 10 }}>{session.deletedAt ? formatTimestamp(session.deletedAt) : "recently"}</p>
                    </div>
                    <div className="row gap-xs session-row-actions" style={{ display: "flex" }}>
                      <button type="button" className="ghost-button session-row-action" onClick={() => restoreSessionMutation.mutate(session.id)} disabled={busy} title="Restore">↩</button>
                      <button type="button" className="ghost-button session-row-action danger-text" onClick={() => setConfirming({ type: "permanent-session", id: session.id, name: session.name })} title="Delete permanently">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="sidebar-section stack stack-tight wizard-slot-panel">
            <div className="section-head">
              <h2>Wizard Slot</h2>
              <span className="muted">{wizardSession ? "1 active" : "empty"}</span>
            </div>
            {wizardSession ? (
              <article className={`session-card wizard-session-card${workspace.data.preferences.activeSessionId === wizardSession.id ? " is-active" : ""}`}>
                <div className="row gap-sm">
                  <button
                  type="button"
                  className="ghost-button align-left inline-grow"
                  onClick={() => updatePreferencesMutation.mutate({ activeSessionId: wizardSession.id })}
                >
                    {workspace.data.preferences.activeSessionId === wizardSession.id ? "●" : "○"} Wizard: {wizardSession.name}
                    {streamingSessionIds.has(wizardSession.id) ? <span className="stream-indicator" aria-hidden="true" /> : null}
                  </button>
                  <button type="button" className="danger-button" onClick={() => setConfirming({ type: "session", id: wizardSession.id, name: wizardSession.name })}>
                    Discard
                  </button>
                </div>
                <p className="muted small-copy">
                  Dedicated wizard session
                  {streamingSessionIds.has(wizardSession.id) ? " · streaming" : ""}
                  {wizardSession.lastMessageAt ? ` · ${formatTimestamp(wizardSession.lastMessageAt)}` : ""}
                </p>
              </article>
            ) : (
              <p className="muted small-copy">No active wizard session. Create one to collect campaign setup through chat.</p>
            )}
            <button type="button" className="secondary-button wizard-slot-button" onClick={submitWizardSession} disabled={busy}>
              New Campaign Wizard
            </button>
          </section>

          <section className="sidebar-footer-panel stack stack-tight">
            <SystemEventsBadge />
            <button type="button" className="secondary-button sidebar-footer-button" onClick={() => setCampaignPanelOpen(true)}>
              Campaigns
            </button>
            <button type="button" className="secondary-button sidebar-footer-button" onClick={() => setLorebookPanelOpen(true)}>
              Lorebook
            </button>
            <button
              type="button"
              className="secondary-button sidebar-footer-button sidebar-options-button"
              onClick={() => setOptionsOpen((current) => !current)}
              aria-expanded={optionsOpen}
            >
              <span>Options</span>
              <span className="muted small-copy">{optionsOpen ? "▾" : "▸"}</span>
            </button>
            {optionsOpen ? (
              <div className="sidebar-options-menu stack stack-tight">
                <button type="button" className="ghost-button align-left" onClick={() => setProviderKeysDialogOpen(true)}>
                  Provider Keys
                </button>
                <button type="button" className="ghost-button align-left" onClick={() => setPasswordDialogOpen(true)}>
                  Password
                </button>
                <button type="button" className="ghost-button align-left" onClick={() => setMfaDialogOpen(true)}>
                  MFA
                </button>
                {user.role === "admin" ? (
                  <>
                    <button type="button" className="ghost-button align-left" onClick={() => setAdminUsersDialogOpen(true)}>
                      Users
                    </button>
                    <button type="button" className="ghost-button align-left" onClick={() => setAdminStorageDialogOpen(true)}>
                      Storage
                    </button>
                    <button type="button" className="ghost-button align-left" onClick={() => setAdminAuditDialogOpen(true)}>
                      Audit
                    </button>
                  </>
                ) : null}
                <button type="button" className="ghost-button align-left danger-text" onClick={() => setDeleteAccountDialogOpen(true)}>
                  Delete Account
                </button>
              </div>
            ) : null}
            {user.role === "admin" ? (
              <>
                <button type="button" className="secondary-button sidebar-footer-button" onClick={() => setClaudeCodeFullScreen(true)}>
                  Claude Code
                </button>
                <button type="button" className="secondary-button sidebar-footer-button" onClick={() => setCodexDialogOpen(true)}>
                  Codex
                </button>
              </>
            ) : null}
            <button type="button" className="sidebar-footer-button" onClick={onLogout} disabled={loggingOut}>
              {loggingOut ? "Logging Out..." : "Log Out"}
            </button>
            <div className="sidebar-user-row" style={{ border: 0, padding: "2px 0" }}>
              <span className="muted" style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{user.username} · {user.role}</span>
            </div>
          </section>
        </div>
      </aside>

      <section className="workspace-main">
        {!sidebarOpen ? (
          <div className="workspace-topbar">
            <button type="button" className="tb-btn workspace-burger" onClick={() => setSidebarOpen(true)}>
              ☰ Menu
            </button>
          </div>
        ) : null}

        <PipelineActivityBar runs={activePipelines.data?.runs ?? []} />

        {activeWizards.data?.runs.length ? (
          <section className={`detail-panel stack stack-tight activity-panel${wizardActivityCollapsed ? " is-collapsed" : ""}`}>
            <div className="section-head">
              <div className="row gap-sm" style={{ alignItems: "center" }}>
                {activeWizards.data.runs.some((run) => run.status === "running" || run.status === "queued") ? <span className="pipeline-spinner" aria-hidden="true" /> : null}
                <div>
                  <p className="eyebrow">Wizard Activity</p>
                  {!wizardActivityCollapsed ? <h3>Active Or Reviewable Wizard Runs</h3> : null}
                </div>
              </div>
              <div className="row gap-sm" style={{ alignItems: "center" }}>
                <span className="muted">{activeWizards.data.runs.length}</span>
                <button
                  type="button"
                  className="activity-panel-collapse-btn"
                  onClick={() => setWizardActivityCollapsed((current) => !current)}
                  title={wizardActivityCollapsed ? "Expand wizard activity" : "Collapse wizard activity"}
                >
                  {wizardActivityCollapsed ? "▸ Expand" : "▾ Collapse"}
                </button>
              </div>
            </div>
            <div className="activity-panel-body stack stack-tight">
            {activeWizards.data.runs.map((run) => (
              <article key={run.id} className="placeholder-card stack stack-tight">
                <div className="section-head">
                  <strong>{run.review.campaignName}</strong>
                  <span className="muted small-copy">{formatWizardStatus(run.status)}</span>
                </div>
                <p className="muted small-copy">
                  Requested {new Date(run.requestedAt).toLocaleString()}
                  {run.status === "completed" && !run.approvedAt ? " · Review available below" : ""}
                </p>
                <p className="message-body">{run.summary || "Wizard worker is preparing this run."}</p>
                <div className="row gap-sm">
                  <button type="button" className="secondary-button" onClick={() => setReviewingWizardRunId(run.id)}>
                    Open Review
                  </button>
                  {(run.status === "queued" || run.status === "running") ? (
                    <button type="button" className="danger-button" onClick={() => cancelWizardMutation.mutate(run.id)} disabled={busy}>Cancel Wizard</button>
                  ) : null}
                  {(run.status === "completed" || run.status === "failed" || run.status === "canceled") && !run.approvedAt ? (
                    <button type="button" className="secondary-button" onClick={() => retryWizardMutation.mutate(run.id)} disabled={busy}>Retry Wizard</button>
                  ) : null}
                </div>
              </article>
            ))}
            </div>
          </section>
        ) : null}
        {searchQuery ? (
          <section className="detail-panel search-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">Workspace Search</p>
                <h3>Results for &quot;{searchQuery.trim() || searchQuery}&quot;</h3>
              </div>
              <span className="muted">
                {!searchActive ? "Type 2+ characters" : search.isLoading ? "Searching..." : `${searchResults.length} matches`}
              </span>
            </div>
            {search.isError ? <p className="error">{search.error instanceof Error ? search.error.message : "search request failed"}</p> : null}
            {!searchActive ? <p className="muted">Type at least 2 characters to search session names and message history.</p> : null}
            {searchActive && !search.isLoading && searchResults.length === 0 ? <p className="muted">No matching sessions or messages yet.</p> : null}
            {searchActive && searchResults.length ? (
              <div className="search-results">
                {searchResults.map((result) => (
                  <button
                    key={`${result.type}-${result.messageId ?? result.sessionId}`}
                    type="button"
                    className={`search-result-card${workspace.data.preferences.activeSessionId === result.sessionId ? " is-active" : ""}`}
                    onClick={() => updatePreferencesMutation.mutate({ activeSessionId: result.sessionId })}
                  >
                    <div className="search-result-meta">
                      <strong>{result.sessionName}</strong>
                      <span className="muted small-copy">{result.type === "session" ? "Session name match" : `${result.role === "user" ? "You" : "Assistant"} message match`}</span>
                    </div>
                    <p className="search-result-excerpt">{result.excerpt}</p>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {activeSession ? (
          <SessionConversation
            session={activeSession}
            streamState={sessionStreams[activeSession.id] ?? createEmptySessionStreamState()}
            updateSessionStream={updateSessionStream}
          />
        ) : (
          <section className="detail-panel empty-state-panel">
            <p className="eyebrow">No Active Session</p>
            <h3>Create or select a session</h3>
            <p className="muted">Create a session on the left to start chatting.</p>
          </section>
        )}
      </section>

      <PasswordDialog
        open={passwordDialogOpen}
        onClose={() => setPasswordDialogOpen(false)}
      />

      <MfaDialog
        open={mfaDialogOpen}
        onClose={() => setMfaDialogOpen(false)}
      />

      <ProviderKeysDialog
        open={providerKeysDialogOpen}
        onClose={() => setProviderKeysDialogOpen(false)}
      />

      <AdminStorageDialog
        open={adminStorageDialogOpen}
        onClose={() => setAdminStorageDialogOpen(false)}
      />

      <AdminAuditDialog
        open={adminAuditDialogOpen}
        onClose={() => setAdminAuditDialogOpen(false)}
      />

      <AdminUsersDialog
        open={adminUsersDialogOpen}
        currentUserId={user.id}
        onClose={() => setAdminUsersDialogOpen(false)}
      />

      {claudeCodeFullScreen ? (
        <div className="ccp-fullscreen-root">
          <ClaudeCodePage onExit={() => setClaudeCodeFullScreen(false)} />
        </div>
      ) : null}

      <CodexDialog
        open={codexDialogOpen}
        onClose={() => setCodexDialogOpen(false)}
      />

      <DeleteAccountDialog
        open={deleteAccountDialogOpen}
        onClose={() => setDeleteAccountDialogOpen(false)}
        onDeleted={() => {
          setDeleteAccountDialogOpen(false);
          setSessionStreams({});
          queryClient.removeQueries({ queryKey: ["workspace-state"] });
          queryClient.invalidateQueries({ queryKey: ["current-user"] });
        }}
        currentUsername={user.username}
      />

      <WizardReviewDialog
        open={reviewingWizardRun != null}
        run={reviewingWizardRun}
        busy={busy}
        onClose={() => setReviewingWizardRunId(null)}
        onApprove={(runId, payload) => approveWizardMutation.mutate({ runId, payload }, { onSuccess: () => setReviewingWizardRunId(null) })}
        onRetry={(runId) => retryWizardMutation.mutate(runId, { onSuccess: () => setReviewingWizardRunId(null) })}
        onCancel={(runId) => cancelWizardMutation.mutate(runId, { onSuccess: () => setReviewingWizardRunId(null) })}
      />

      <CampaignPanel
        open={campaignPanelOpen}
        onClose={() => setCampaignPanelOpen(false)}
      />

      <LorebookPanel
        open={lorebookPanelOpen}
        onClose={() => setLorebookPanelOpen(false)}
      />

      {confirming ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog-card" role="dialog" aria-modal="true" aria-label={`Delete ${confirming.name}`}>
            <p className="eyebrow">Confirm Delete</p>
            <h3>{confirming.name}</h3>
            <p className="muted">
              {confirming.type === "folder"
                ? "Deleting a folder keeps its sessions, moves them to the parent folder, and re-homes any child folders upward."
                : confirming.type === "session"
                  ? wizardSession?.id === confirming.id
                    ? "Discarding a wizard session permanently removes the in-progress wizard conversation."
                    : "Deleting a session moves it to the recycle bin so it can be restored later."
                  : confirming.type === "permanent-session"
                    ? "Permanently deleting a session removes it from the recycle bin and erases its stored chat history and generated images."
                    : confirming.type === "replace-wizard"
                      ? "A wizard session is already active. Replacing it permanently removes the current wizard conversation and starts a fresh one."
                      : "Emptying the recycle bin permanently deletes every session currently stored there."}
            </p>
            <div className="row gap-sm end">
              <button type="button" className="secondary-button" onClick={() => setConfirming(null)}>Cancel</button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  if (confirming.type === "folder") {
                    deleteFolderMutation.mutate(confirming.id, { onSuccess: () => setConfirming(null) });
                    return;
                  }
                  if (confirming.type === "session") {
                    deleteSessionMutation.mutate(confirming.id, { onSuccess: () => setConfirming(null) });
                    return;
                  }
                  if (confirming.type === "permanent-session") {
                    permanentlyDeleteSessionMutation.mutate(confirming.id, { onSuccess: () => setConfirming(null) });
                    return;
                  }
                  if (confirming.type === "replace-wizard") {
                    deleteSessionMutation.mutate(confirming.id, {
                      onSuccess: () => {
                        createSessionMutation.mutate({ sessionType: "wizard" }, {
                          onSettled: () => setConfirming(null),
                        });
                      },
                    });
                    return;
                  }
                  emptyRecycleBinMutation.mutate(undefined, { onSuccess: () => setConfirming(null) });
                }}
              >
                {confirming.type === "permanent-session"
                  ? "Delete Permanently"
                  : confirming.type === "empty-recycle-bin"
                    ? "Empty Bin"
                    : confirming.type === "replace-wizard"
                      ? "Replace Wizard"
                      : wizardSession?.id === confirming.id
                        ? "Discard Wizard"
                        : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

type SessionRowProps = {
  session: SessionSummary;
  folderOptions: FolderOption[];
  activeSessionId: string | null;
  editingSessionId: string | null;
  editingSessionName: string;
  setEditingSessionName: (value: string) => void;
  onActivate: (sessionId: string) => void;
  onStartRename: (session: SessionSummary) => void;
  onSaveRename: () => void;
  onMove: (folderId: string | null) => void;
  onDelete: () => void;
  onDragStart: (event: DragEvent<HTMLElement>, sessionId: string) => void;
  onDragEnd: () => void;
  dragging: boolean;
  streaming: boolean;
  busy: boolean;
};

function SessionRow({
  session,
  folderOptions,
  activeSessionId,
  editingSessionId,
  editingSessionName,
  setEditingSessionName,
  onActivate,
  onStartRename,
  onSaveRename,
  onMove,
  onDelete,
  onDragStart,
  onDragEnd,
  dragging,
  streaming,
  busy,
}: SessionRowProps) {
  const isActive = activeSessionId === session.id;
  const isEditing = editingSessionId === session.id;

  return (
    <article
      className={`session-card${isActive ? " is-active" : ""}${dragging ? " is-dragging" : ""}`}
      draggable={!busy}
      onDragStart={(event) => onDragStart(event, session.id)}
      onDragEnd={onDragEnd}
    >
      <div className="row gap-xs session-row-head">
        <button type="button" className="ghost-button align-left inline-grow session-row-trigger" onClick={() => onActivate(session.id)}>
          <span className="session-row-bullet">{isActive ? "●" : "○"}</span>
          <span className="session-row-name">{session.name}</span>
          {streaming ? <span className="stream-indicator" aria-hidden="true" /> : null}
        </button>
        <div className="row gap-xs session-row-actions">
          <button type="button" className="ghost-button session-row-action" onClick={() => onStartRename(session)} title="Rename">✎</button>
          {session.folderId ? <button type="button" className="ghost-button session-row-action" onClick={() => onMove(null)} title="Move to unfiled">⌂</button> : null}
          <button type="button" className="ghost-button session-row-action danger-text" onClick={onDelete} title="Delete">✕</button>
        </div>
      </div>
      {isEditing ? (
        <div className="inline-form">
          <input aria-label={`Rename session ${session.name}`} value={editingSessionName} onChange={(event) => setEditingSessionName(event.target.value)} />
          <button type="button" onClick={onSaveRename} disabled={!editingSessionName.trim() || busy}>Save</button>
        </div>
      ) : null}
      {!isEditing ? (
        <p className="muted small-copy session-row-meta">
          {session.messageCount} msgs
          {session.campaignId ? " · campaign" : ""}
          {session.lastMessageAt ? ` · ${formatTimestamp(session.lastMessageAt)}` : ""}
        </p>
      ) : (
        <label className="row gap-xs muted small-copy">
          <span>Move</span>
          <select aria-label={`Move session ${session.name}`} value={session.folderId ?? "root"} onChange={(event) => onMove(event.target.value === "root" ? null : event.target.value)}>
            <option value="root">Unfiled</option>
            {folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
          </select>
        </label>
      )}
    </article>
  );
}

type FolderTreeProps = {
  nodes: FolderTreeNode[];
  sessionsByFolder: Map<string, SessionSummary[]>;
  folders: Folder[];
  folderOptions: FolderOption[];
  activeSessionId: string | null;
  editingFolderId: string | null;
  editingFolderName: string;
  editingFolderParentId: string;
  editingSessionId: string | null;
  editingSessionName: string;
  draggingSessionId: string | null;
  dragTargetFolderId: string | "root" | null;
  streamingSessionIds: Set<string>;
  busy: boolean;
  setEditingFolderName: (value: string) => void;
  setEditingFolderParentId: (value: string) => void;
  setEditingSessionName: (value: string) => void;
  onActivateSession: (sessionId: string) => void;
  onStartFolderRename: (folder: Folder) => void;
  onSaveFolderRename: () => void;
  onPrepareChildFolder: (parentId: string) => void;
  onDeleteFolder: (folder: Folder) => void;
  onToggleFolder: (folder: Folder) => void;
  onStartSessionRename: (session: SessionSummary) => void;
  onSaveSessionRename: () => void;
  onMoveSession: (sessionId: string, folderId: string | null) => void;
  onDeleteSession: (session: SessionSummary) => void;
  onSessionDragStart: (event: DragEvent<HTMLElement>, sessionId: string) => void;
  onSessionDragEnd: () => void;
  onFolderDragOver: (folderId: string | "root") => void;
  onFolderDragLeave: (folderId: string | "root") => void;
  onFolderDrop: (folderId: string | "root") => void;
};

function FolderTree({
  nodes,
  sessionsByFolder,
  folders,
  folderOptions,
  activeSessionId,
  editingFolderId,
  editingFolderName,
  editingFolderParentId,
  editingSessionId,
  editingSessionName,
  draggingSessionId,
  dragTargetFolderId,
  streamingSessionIds,
  busy,
  setEditingFolderName,
  setEditingFolderParentId,
  setEditingSessionName,
  onActivateSession,
  onStartFolderRename,
  onSaveFolderRename,
  onPrepareChildFolder,
  onDeleteFolder,
  onToggleFolder,
  onStartSessionRename,
  onSaveSessionRename,
  onMoveSession,
  onDeleteSession,
  onSessionDragStart,
  onSessionDragEnd,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop,
}: FolderTreeProps) {
  return nodes.map((node) => {
    const folder = node.folder;
    const directSessions = sessionsByFolder.get(folder.id) ?? [];
    const hasContent = directSessions.length > 0 || node.children.length > 0;
    const selectableParents = flattenFolderOptions(folders, { excludeIds: collectDescendantFolderIds(folders, folder.id) });
    return (
      <article
        key={folder.id}
        className={`folder-card${dragTargetFolderId === folder.id ? " is-drop-target" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFolderDragOver(folder.id);
        }}
        onDragLeave={() => onFolderDragLeave(folder.id)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFolderDrop(folder.id);
        }}
      >
        <div className="row space-between gap-sm">
          {editingFolderId === folder.id ? (
            <div className="stack stack-tight inline-grow">
              <input aria-label={`Rename folder ${folder.name}`} value={editingFolderName} onChange={(event) => setEditingFolderName(event.target.value)} />
              <div className="inline-form">
                <select aria-label={`Parent folder ${folder.name}`} value={editingFolderParentId} onChange={(event) => setEditingFolderParentId(event.target.value)}>
                  <option value="root">Root</option>
                  {selectableParents.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
                <button type="button" onClick={onSaveFolderRename} disabled={!editingFolderName.trim() || busy}>Save</button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" className="ghost-button align-left inline-grow folder-row-trigger" onClick={() => onToggleFolder(folder)}>
                <span className="folder-row-chevron">{folder.collapsed ? "▸" : "▾"}</span>
                <span className="folder-row-icon">📁</span>
                <span className="folder-row-name">{folder.name}</span>
              </button>
              <div className="row gap-xs folder-row-actions">
                <span className="muted small-copy">{directSessions.length + node.children.length}</span>
                <button
                  type="button"
                  className="ghost-button session-row-action"
                  onClick={() => onPrepareChildFolder(folder.id)}
                  disabled={busy || getFolderDepth(folders, folder.id) >= MAX_FOLDER_DEPTH}
                  title="Child folder"
                >
                  +
                </button>
                <button type="button" className="ghost-button session-row-action" onClick={() => onStartFolderRename(folder)} title="Rename">✎</button>
                <button type="button" className="ghost-button session-row-action danger-text" onClick={() => onDeleteFolder(folder)} title="Delete">✕</button>
              </div>
            </>
          )}
        </div>
        {!folder.collapsed ? (
          <div className="stack stack-tight folder-tree-children">
            {directSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                folderOptions={folderOptions}
                activeSessionId={activeSessionId}
                editingSessionId={editingSessionId}
                editingSessionName={editingSessionName}
                setEditingSessionName={setEditingSessionName}
                onActivate={onActivateSession}
                onStartRename={onStartSessionRename}
                onSaveRename={onSaveSessionRename}
                onMove={(folderId) => onMoveSession(session.id, folderId)}
                onDelete={() => onDeleteSession(session)}
                onDragStart={onSessionDragStart}
                onDragEnd={onSessionDragEnd}
                dragging={draggingSessionId === session.id}
                streaming={streamingSessionIds.has(session.id)}
                busy={busy}
              />
            ))}
            <FolderTree
              nodes={node.children}
              sessionsByFolder={sessionsByFolder}
              folders={folders}
              folderOptions={folderOptions}
              activeSessionId={activeSessionId}
              editingFolderId={editingFolderId}
              editingFolderName={editingFolderName}
              editingFolderParentId={editingFolderParentId}
              editingSessionId={editingSessionId}
              editingSessionName={editingSessionName}
              draggingSessionId={draggingSessionId}
              dragTargetFolderId={dragTargetFolderId}
              streamingSessionIds={streamingSessionIds}
              busy={busy}
              setEditingFolderName={setEditingFolderName}
              setEditingFolderParentId={setEditingFolderParentId}
              setEditingSessionName={setEditingSessionName}
              onActivateSession={onActivateSession}
              onStartFolderRename={onStartFolderRename}
              onSaveFolderRename={onSaveFolderRename}
              onPrepareChildFolder={onPrepareChildFolder}
              onDeleteFolder={onDeleteFolder}
              onToggleFolder={onToggleFolder}
              onStartSessionRename={onStartSessionRename}
              onSaveSessionRename={onSaveSessionRename}
              onMoveSession={onMoveSession}
              onDeleteSession={onDeleteSession}
              onSessionDragStart={onSessionDragStart}
              onSessionDragEnd={onSessionDragEnd}
              onFolderDragOver={onFolderDragOver}
              onFolderDragLeave={onFolderDragLeave}
              onFolderDrop={onFolderDrop}
            />
            {!hasContent ? <p className="muted small-copy">No sessions or subfolders yet.</p> : null}
            {folder.parentId ? <p className="muted small-copy">Path: {getFolderPathLabel(folders, folder.id)}</p> : null}
          </div>
        ) : null}
      </article>
    );
  });
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatWizardStatus(status: "queued" | "running" | "completed" | "failed" | "canceled") {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "canceled") return "Canceled";
  return "Failed";
}
