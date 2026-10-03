import { lazy, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createFolderRequestSchema, createSessionRequestSchema, updateFolderRequestSchema, updateSessionRequestSchema, workspaceSearchRequestSchema } from "@tracyhill-rp/contracts";
import type { CurrentUser, Folder, SessionSummary, WorkspaceStateResponse } from "@tracyhill-rp/contracts";

import { SessionConversation } from "../features/chat/SessionConversation";
import { createEmptySessionStreamState, EMPTY_SESSION_STREAM_STATE, type SessionStreamState } from "../features/chat/sessionStreamState";
import { createUserScopedCacheWriter } from "../features/auth/authCache";
import { CodingBackendProvider, CLAUDE_BACKEND, KIMI_BACKEND } from "../features/claudeCode/backend";
import { ClaudeDraftStore } from "../features/claudeCode/claudeDrafts";
import { CodexDraftStore } from "../features/codex/codexDrafts";
import { getActivePipelineRuns } from "../features/pipeline/pipelineApi";
import { PipelineActivityBar } from "../features/pipeline/PipelineActivityBar";
import { SystemEventsBadge } from "../features/system/SystemEventsBadge";
import { approveWizardRun, cancelWizardRun, dismissWizardRun, getActiveWizardRuns, retryWizardRun } from "../features/wizard/wizardApi";
import { replaceWizardSession } from "../features/wizard/replaceWizard";
import { CancelWizardDialog } from "../features/wizard/CancelWizardDialog";
import { cancelWizardTargetOf, type CancelWizardTarget } from "../features/wizard/wizardUtils";
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
import { searchShowsResults, searchStatusLabel } from "./searchStatus";
import { CODING_PANELS_QUERY_KEY, codingPanelReady, codingPanelsNote, getCodingPanels } from "./codingPanels";
import { useWorkspaceState } from "../features/workspace/useWorkspaceState";
import { CommandPalette, type PaletteAction } from "../features/workspace/CommandPalette";
import { stringMaxLength } from "../features/lorebook/contractBounds";
import { DeferredMount } from "../shared/ui/DeferredMount";
import { Icon } from "../shared/ui/Icon";
import { Dialog } from "../shared/ui/Dialog";
// Code-split: each of these ships as its own
// chunk, fetched on first use through DeferredMount below. The shell's initial
// bundle no longer carries the coding panels, the campaign/lorebook/drives
// panels or the account/admin dialogs. SessionConversation stays static: it is
// the shell's working surface.
const AdminAuditDialog = lazy(() => import("../features/admin/AdminAuditDialog").then((m) => ({ default: m.AdminAuditDialog })));
const AdminStorageDialog = lazy(() => import("../features/admin/AdminStorageDialog").then((m) => ({ default: m.AdminStorageDialog })));
const AdminUsersDialog = lazy(() => import("../features/admin/AdminUsersDialog").then((m) => ({ default: m.AdminUsersDialog })));
const ServerSettingsDialog = lazy(() => import("../features/admin/ServerSettingsDialog").then((m) => ({ default: m.ServerSettingsDialog })));
const CampaignPanel = lazy(() => import("../features/campaigns/CampaignPanel").then((m) => ({ default: m.CampaignPanel })));
const LorebookPanel = lazy(() => import("../features/lorebook/LorebookPanel").then((m) => ({ default: m.LorebookPanel })));
const DrivesPanel = lazy(() => import("../features/drives/DrivesPanel").then((m) => ({ default: m.DrivesPanel })));
const DeleteAccountDialog = lazy(() => import("../features/auth/DeleteAccountDialog").then((m) => ({ default: m.DeleteAccountDialog })));
const MfaDialog = lazy(() => import("../features/auth/MfaDialog").then((m) => ({ default: m.MfaDialog })));
const PasswordDialog = lazy(() => import("../features/auth/PasswordDialog").then((m) => ({ default: m.PasswordDialog })));
const ProviderKeysDialog = lazy(() => import("../features/auth/ProviderKeysDialog").then((m) => ({ default: m.ProviderKeysDialog })));
const ClaudeCodePage = lazy(() => import("../features/claudeCode/ClaudeCodePage").then((m) => ({ default: m.ClaudeCodePage })));
const CodexPage = lazy(() => import("../features/codex/CodexPage").then((m) => ({ default: m.CodexPage })));
const WizardReviewDialog = lazy(() => import("../features/wizard/WizardReviewDialog").then((m) => ({ default: m.WizardReviewDialog })));
const ImportLorebookDialog = lazy(() => import("../features/wizard/ImportLorebookDialog").then((m) => ({ default: m.ImportLorebookDialog })));
const PANEL_LOADING = <div className="ccp-fullscreen-loading" role="status" aria-live="polite">Loading panel…</div>;

// The sidebar's typed names and search stop at the contracts' limits: a longer one came
// back as a bare "invalid folder request" / "invalid session request" / "invalid search request".
const SIDEBAR_TEXT_MAX = {
  newFolder: stringMaxLength(createFolderRequestSchema.shape.name),
  renameFolder: stringMaxLength(updateFolderRequestSchema.shape.name),
  newSession: stringMaxLength(createSessionRequestSchema.shape.name),
  renameSession: stringMaxLength(updateSessionRequestSchema.shape.name),
  search: stringMaxLength(workspaceSearchRequestSchema.shape.query),
};

type AppShellProps = {
  user: CurrentUser;
  onLogout: () => void;
  // The account no longer exists: App forgets the identity and signs the shell
  // out the way an explicit logout does.
  onAccountDeleted: () => void;
  loggingOut: boolean;
};

export function AppShell({ user, onLogout, onAccountDeleted, loggingOut }: AppShellProps) {
  const queryClient = useQueryClient();
  const cacheUserQuery = createUserScopedCacheWriter(queryClient);
  const workspace = useWorkspaceState();
  const [sessionStreams, setSessionStreams] = useState<Record<string, SessionStreamState>>({});
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [mfaDialogOpen, setMfaDialogOpen] = useState(false);
  const [providerKeysDialogOpen, setProviderKeysDialogOpen] = useState(false);
  const [adminUsersDialogOpen, setAdminUsersDialogOpen] = useState(false);
  const [adminStorageDialogOpen, setAdminStorageDialogOpen] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const [adminAuditDialogOpen, setAdminAuditDialogOpen] = useState(false);
  const [claudeCodeFullScreen, setClaudeCodeFullScreen] = useState(false);
  // Composer drafts for the three coding panels live here, for the life of the
  // signed-in shell (App keys the shell by user id): the ⌘⇧C/⌘⇧X/⌘⇧K toggles
  // and "← RP" unmount the panels, and the drafts must not go with them.
  const [codexDrafts] = useState(() => new CodexDraftStore());
  const [claudeDrafts] = useState(() => new ClaudeDraftStore());
  const [kimiDrafts] = useState(() => new ClaudeDraftStore());
  const [codexFullScreen, setCodexFullScreen] = useState(false);
  const [kimiFullScreen, setKimiFullScreen] = useState(false);
  // The coding panels this server has set up (never set up automatically). The others are
  // greyed out in the coding menu, left out of the palette, and their shortcuts stay with the browser. The shortcut
  // listeners read the answer through a ref so they need no re-binding.
  const codingPanels = useQuery({ queryKey: CODING_PANELS_QUERY_KEY, queryFn: getCodingPanels, enabled: user.role === "admin", staleTime: 5 * 60_000, retry: false });
  const panelReady = {
    claudeCode: codingPanelReady(codingPanels.data, "claudeCode"),
    codex: codingPanelReady(codingPanels.data, "codex"),
    kimi: codingPanelReady(codingPanels.data, "kimi"),
  };
  const anyPanelReady = panelReady.claudeCode || panelReady.codex || panelReady.kimi;
  const panelsNote = codingPanelsNote(codingPanels.data);
  const panelReadyRef = useRef(panelReady);
  useEffect(() => { panelReadyRef.current = panelReady; });

  // Global Cmd/Ctrl+Shift+C opens Claude Code from anywhere.
  useEffect(() => {
    if (user.role !== "admin") return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "C" || e.key === "c")) {
        if (!panelReadyRef.current.claudeCode) return;
        e.preventDefault();
        // The three coding roots are mutually exclusive: toggling one closes the
        // others so the shortcuts can't stack full-screen panels.
        setCodexFullScreen(false);
        setKimiFullScreen(false);
        setClaudeCodeFullScreen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [user.role]);
  const [codingMenuOpen, setCodingMenuOpen] = useState(false);
  // Global Cmd/Ctrl+Shift+X opens Codex without colliding with Claude Code's C shortcut.
  useEffect(() => {
    if (user.role !== "admin") return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "X" || e.key === "x")) {
        if (!panelReadyRef.current.codex) return;
        e.preventDefault();
        setClaudeCodeFullScreen(false);
        setKimiFullScreen(false);
        setCodexFullScreen((open) => !open);
      }
      // Cmd/Ctrl+Shift+K opens the Kimi (K3) coding panel.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "K" || e.key === "k")) {
        if (!panelReadyRef.current.kimi) return;
        e.preventDefault();
        setClaudeCodeFullScreen(false);
        setCodexFullScreen(false);
        setKimiFullScreen((open) => !open);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [user.role]);
  const [deleteAccountDialogOpen, setDeleteAccountDialogOpen] = useState(false);
  const [campaignPanelOpen, setCampaignPanelOpen] = useState(false);
  const [lorebookPanelOpen, setLorebookPanelOpen] = useState(false);
  const [drivesPanel, setDrivesPanel] = useState<{ open: boolean; campaignId?: string | null; character?: string | null }>({ open: false });
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === "undefined" ? true : window.innerWidth > 768);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  // The nav rail's flyouts close on any outside press, and
  // Ctrl/⌘+K opens the command palette unless a coding panel (with its own ⌘K) is up.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!optionsOpen && !codingMenuOpen) return;
    const handler = (event: MouseEvent) => {
      if (railRef.current && !railRef.current.contains(event.target as Node)) { setOptionsOpen(false); setCodingMenuOpen(false); }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [optionsOpen, codingMenuOpen]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || (e.key !== "k" && e.key !== "K")) return;
      if (claudeCodeFullScreen || codexFullScreen || kimiFullScreen) return;
      e.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [claudeCodeFullScreen, codexFullScreen, kimiFullScreen]);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [wizardActivityCollapsed, setWizardActivityCollapsed] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  // Sidebar resize drag. `resizing` is state (not a ref) so the handle's
  // `dragging` class clears on mouse-up instead of sticking until an unrelated
  // re-render; the document listeners + body cursor/user-select overrides live
  // in the effect below so they are removed if the shell unmounts mid-drag
  // (logout / 401 while dragging).
  const [resizing, setResizing] = useState(false);
  const resizeOriginRef = useRef({ x: 0, width: 320 });
  // Hooks must stay above the loading/error early returns below — this effect
  // originally sat next to startSidebarResize (after them) and threw React
  // #310 on the first authenticated render in production.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - resizeOriginRef.current.x;
      const next = Math.max(200, Math.min(window.innerWidth * 0.5, resizeOriginRef.current.width + delta));
      setSidebarWidth(next);
    };
    const onUp = () => setResizing(false);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);
  const [newFolderFormOpen, setNewFolderFormOpen] = useState(false);
  const [newSessionFormOpen, setNewSessionFormOpen] = useState(false);
  const [reviewingWizardRunId, setReviewingWizardRunId] = useState<string | null>(null);
  // Import a SillyTavern lorebook as a new campaign.
  const [importLorebookOpen, setImportLorebookOpen] = useState(false);
  // The activity panel's Cancel Wizard asks first, as Cancel Run does.
  const [confirmingWizardCancel, setConfirmingWizardCancel] = useState<CancelWizardTarget | null>(null);
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
    // 1000ms (was 250ms — excessive; CampaignPanel already uses 2s with the same note).
    refetchInterval: (query) => query.state.data?.runs.some((entry) => entry.run.status === "queued" || entry.run.status === "running") ? 1000 : false,
  });
  const activeWizards = useQuery({
    queryKey: ["wizard-active"],
    queryFn: getActiveWizardRuns,
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running") ? 1000 : false,
  });

  const setWorkspaceState = (next: WorkspaceStateResponse) => {
    cacheUserQuery(["workspace-state"], next);
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
  // Delete the old wizard, then create the new one (the server allows one active wizard session);
  // a failure reaches the global mutation-error toast with a message that says what state it left.
  const replaceWizardMutation = useMutation({
    mutationFn: (oldWizardId: string) => replaceWizardSession(oldWizardId, { deleteSession, createSession, onState: setWorkspaceState }),
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
  const dismissWizardMutation = useMutation({
    mutationFn: dismissWizardRun,
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
  const searchView = { active: searchActive, loading: search.isLoading, failed: search.isError, resultCount: searchResults.length };
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
  const wizardRunInFlight = activeWizards.data?.runs.some((run) => run.status === "queued" || run.status === "running") ?? false;

  if (workspace.isLoading) {
    return <main className="shell"><section className="card">Loading workspace...</section></main>;
  }

  if (!workspace.data) {
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
    || cancelWizardMutation.isPending
    || dismissWizardMutation.isPending
    || replaceWizardMutation.isPending;

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
    resizeOriginRef.current = { x: event.clientX, width: sidebarWidth };
    setResizing(true);
  };

  const initial = (user.username.trim()[0] ?? "?").toUpperCase();
  const paletteActions: PaletteAction[] = [
    { id: "new-session", label: "New session", icon: "message-plus", run: () => { setSidebarOpen(true); setNewSessionFormOpen(true); setNewFolderFormOpen(false); } },
    { id: "new-folder", label: "New folder", icon: "folder-plus", run: () => { setSidebarOpen(true); setNewFolderFormOpen(true); setNewSessionFormOpen(false); } },
    { id: "campaigns", label: "Open Campaigns", icon: "book", run: () => setCampaignPanelOpen(true) },
    { id: "lorebook", label: "Open Lorebook", icon: "book-open", run: () => setLorebookPanelOpen(true) },
    { id: "drives", label: "Open Drives", icon: "compass", run: () => setDrivesPanel({ open: true }) },
    { id: "wizard", label: "New campaign wizard", icon: "sparkles", run: () => void submitWizardSession() },
    { id: "provider-keys", label: "Providers", icon: "key", run: () => setProviderKeysDialogOpen(true) },
    { id: "password", label: "Change password", icon: "shield", run: () => setPasswordDialogOpen(true) },
    { id: "mfa", label: "MFA settings", icon: "shield", run: () => setMfaDialogOpen(true) },
    ...(user.role === "admin" ? [
      { id: "users", label: "Admin: Users", icon: "users" as const, run: () => setAdminUsersDialogOpen(true) },
      { id: "storage", label: "Admin: Storage", icon: "database" as const, run: () => setAdminStorageDialogOpen(true) },
      { id: "audit", label: "Admin: Audit log", icon: "list" as const, run: () => setAdminAuditDialogOpen(true) },
      { id: "server-settings", label: "Admin: Server settings", icon: "wrench" as const, run: () => setServerSettingsOpen(true) },
      ...(panelReady.claudeCode ? [{ id: "claude", label: "Claude Code panel", hint: "⌘⇧C", icon: "terminal" as const, run: () => { setCodexFullScreen(false); setKimiFullScreen(false); setClaudeCodeFullScreen(true); } }] : []),
      ...(panelReady.codex ? [{ id: "codex", label: "Codex panel", hint: "⌘⇧X", icon: "terminal" as const, run: () => { setClaudeCodeFullScreen(false); setKimiFullScreen(false); setCodexFullScreen(true); } }] : []),
      ...(panelReady.kimi ? [{ id: "kimi", label: "Kimi (K3) panel", hint: "⌘⇧K", icon: "terminal" as const, run: () => { setClaudeCodeFullScreen(false); setCodexFullScreen(false); setKimiFullScreen(true); } }] : []),
    ] : []),
    { id: "logout", label: "Log out", icon: "log-out", danger: true, run: onLogout },
  ];

  return (
    <main className="workspace-shell">
      <nav className="workspace-rail" ref={railRef} aria-label="Primary">
        <div className="rail-brand" title="TracyHill RP"><img src="/brand/mark-64.png" alt="" width="30" height="30" /></div>
        <button type="button" className={`rail-btn${sidebarOpen ? " is-active" : ""}`} aria-label="Sessions" aria-pressed={sidebarOpen} title={sidebarOpen ? "Hide the session panel" : "Show the session panel"} onClick={() => setSidebarOpen((open) => !open)}>
          <Icon name="message" size={20} /><span className="rail-label">Sessions</span>
        </button>
        <button type="button" className="rail-btn" aria-label="Campaigns" title="Campaigns" onClick={() => setCampaignPanelOpen(true)}>
          <Icon name="book" size={20} /><span className="rail-label">Campaigns</span>
        </button>
        <button type="button" className="rail-btn" aria-label="Lorebook" title="Lorebook" onClick={() => setLorebookPanelOpen(true)}>
          <Icon name="book-open" size={20} /><span className="rail-label">Lorebook</span>
        </button>
        <button type="button" className="rail-btn" aria-label="Drives" title="Character drives" onClick={() => setDrivesPanel({ open: true })}>
          <Icon name="compass" size={20} /><span className="rail-label">Drives</span>
        </button>
        {user.role === "admin" ? (
          <div className="rail-item-wrap rail-desktop-only">
            <button type="button" className={`rail-btn${anyPanelReady ? "" : " is-unavailable"}`} aria-label="Coding Panel" aria-expanded={codingMenuOpen} title={anyPanelReady ? "Coding panels" : "Coding panels: none is set up on this server"} onClick={() => { setCodingMenuOpen((current) => !current); setOptionsOpen(false); }}>
              <Icon name="terminal" size={20} /><span className="rail-label">Coding</span>
            </button>
            {codingMenuOpen ? (
              <div className="rail-flyout" aria-label="Coding panels">
                <div className="rail-flyout-title">Coding panels</div>
                <button type="button" className="ghost-button align-left" disabled={!panelReady.claudeCode} title={panelReady.claudeCode ? undefined : "Not set up on this server"} onClick={() => { setClaudeCodeFullScreen(true); setCodingMenuOpen(false); }}><Icon name="terminal" size={14} /> Claude Code <kbd>⌘⇧C</kbd></button>
                <button type="button" className="ghost-button align-left" disabled={!panelReady.codex} title={panelReady.codex ? undefined : "Not set up on this server"} onClick={() => { setCodexFullScreen(true); setCodingMenuOpen(false); }}><Icon name="terminal" size={14} /> Codex <kbd>⌘⇧X</kbd></button>
                <button type="button" className="ghost-button align-left" disabled={!panelReady.kimi} title={panelReady.kimi ? undefined : "Not set up on this server"} onClick={() => { setKimiFullScreen(true); setCodingMenuOpen(false); }}><Icon name="terminal" size={14} /> Kimi (K3) <kbd>⌘⇧K</kbd></button>
                {panelsNote ? <p className="rail-flyout-note">{panelsNote}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <button type="button" className="rail-btn rail-desktop-only" aria-label="Command palette" title="Jump to a session or run a command (Ctrl/⌘ K)" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={20} /><span className="rail-label">Jump</span>
        </button>
        <div className="rail-spacer" />
        <SystemEventsBadge compact />
        <div className="rail-item-wrap">
          <button type="button" className="rail-btn" aria-label="Options" aria-expanded={optionsOpen} title="Account and admin options" onClick={() => { setOptionsOpen((current) => !current); setCodingMenuOpen(false); }}>
            <Icon name="sliders" size={20} /><span className="rail-label">Options</span>
          </button>
          {optionsOpen ? (
            <div className="rail-flyout rail-flyout-up" aria-label="Options">
              <div className="rail-flyout-title">Account</div>
              <button type="button" className="ghost-button align-left" onClick={() => { setProviderKeysDialogOpen(true); setOptionsOpen(false); }}><Icon name="key" size={14} /> Providers</button>
              <button type="button" className="ghost-button align-left" onClick={() => { setPasswordDialogOpen(true); setOptionsOpen(false); }}><Icon name="shield" size={14} /> Password</button>
              <button type="button" className="ghost-button align-left" onClick={() => { setMfaDialogOpen(true); setOptionsOpen(false); }}><Icon name="shield" size={14} /> MFA</button>
              {user.role === "admin" ? (
                <>
                  <div className="rail-flyout-title">Admin</div>
                  <button type="button" className="ghost-button align-left" onClick={() => { setAdminUsersDialogOpen(true); setOptionsOpen(false); }}><Icon name="users" size={14} /> Users</button>
                  <button type="button" className="ghost-button align-left" onClick={() => { setAdminStorageDialogOpen(true); setOptionsOpen(false); }}><Icon name="database" size={14} /> Storage</button>
                  <button type="button" className="ghost-button align-left" onClick={() => { setAdminAuditDialogOpen(true); setOptionsOpen(false); }}><Icon name="list" size={14} /> Audit</button>
                  <button type="button" className="ghost-button align-left" onClick={() => { setServerSettingsOpen(true); setOptionsOpen(false); }}><Icon name="wrench" size={14} /> Server settings</button>
                </>
              ) : null}
              <div className="rail-flyout-sep" />
              <button type="button" className="ghost-button align-left danger-text" onClick={() => { setDeleteAccountDialogOpen(true); setOptionsOpen(false); }}><Icon name="trash" size={14} /> Delete Account</button>
            </div>
          ) : null}
        </div>
        <button type="button" className="rail-btn rail-user" aria-label="Log Out" title={`${user.username} · ${user.role} — log out`} onClick={onLogout} disabled={loggingOut}>
          <span className="rail-avatar" aria-hidden="true">{initial}</span><span className="rail-label">{loggingOut ? "Leaving…" : "Log Out"}</span>
        </button>
      </nav>
      {sidebarOpen ? <div className="workspace-sidebar-backdrop" onClick={() => setSidebarOpen(false)} /> : null}
      <aside
        ref={sidebarRef}
        className={`workspace-sidebar${sidebarOpen ? " open" : ""}`}
        style={sidebarOpen ? { width: sidebarWidth, minWidth: 200, maxWidth: "50vw" } : undefined}
      >
        <div
          className={`sidebar-resize-handle${resizing ? " dragging" : ""}`}
          onMouseDown={startSidebarResize}
        />
        <div className="sidebar-panel">
          {workspace.isError ? <div role="alert" className="error small-copy">
            Workspace refresh failed. Showing the last loaded data. <button type="button" className="ghost-button" onClick={() => void workspace.refetch()}>Retry</button>
          </div> : null}
          <div className="sidebar-header">
            <div className="sidebar-title">
              <img src="/brand/logo-horizontal-480.webp" srcSet="/brand/logo-horizontal-480.webp 1x, /brand/logo-horizontal-960.webp 2x" alt="TracyHill RP" className="sidebar-logo" />
            </div>
            <button type="button" className="sidebar-collapse-button" onClick={() => setSidebarOpen(false)} aria-label="Collapse sidebar" title="Hide the session panel"><Icon name="chevron-left" /></button>
          </div>

          <div className="sidebar-search-row">
            <input
              aria-label="Search workspace"
              placeholder="Search sessions and messages"
              maxLength={SIDEBAR_TEXT_MAX.search}
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
              <input aria-label="New session name" placeholder="Part 1" maxLength={SIDEBAR_TEXT_MAX.newSession} value={newSessionName} onChange={(event) => setNewSessionName(event.target.value)} />
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
              <input aria-label="New folder name" placeholder="Campaign folder" maxLength={SIDEBAR_TEXT_MAX.newFolder} value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} />
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
                onPrepareChildFolder={(parentId) => {
                  // The "+" child-folder button used to only preselect the parent and
                  // never open the form, so it looked like it did nothing.
                  setNewFolderParentId(parentId);
                  setNewFolderFormOpen(true);
                  setNewSessionFormOpen(false);
                }}
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
              <span><Icon name={recycleBinOpen ? "chevron-down" : "chevron-right"} size={14} /></span>
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
                {deletedSessions.length === 0 ? <div className="recycle-bin-empty"><img className="empty-state-art empty-state-art-sm" src="/brand/empty-bin.webp" alt="" width="720" height="720" loading="lazy" /><p className="muted small-copy">Empty.</p></div> : deletedSessions.map((session) => (
                  <div key={session.id} className="recycle-bin-item">
                    <div className="inline-grow" style={{ minWidth: 0 }}>
                      <p className="session-row-name">{session.name}</p>
                      <p className="muted" style={{ fontSize: 10 }}>{session.deletedAt ? formatTimestamp(session.deletedAt) : "recently"}</p>
                    </div>
                    <div className="row gap-xs session-row-actions" style={{ display: "flex" }}>
                      <button type="button" className="ghost-button session-row-action" onClick={() => restoreSessionMutation.mutate(session.id)} disabled={busy} title="Restore">↩</button>
                      <button type="button" className="ghost-button session-row-action danger-text" onClick={() => setConfirming({ type: "permanent-session", id: session.id, name: session.name })} title="Delete permanently"><Icon name="x" size={14} /></button>
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
                    <Icon name={workspace.data.preferences.activeSessionId === wizardSession.id ? "dot" : "circle"} size={10} /> Wizard: {wizardSession.name}
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
            <button type="button" className="ghost-button wizard-import-button" onClick={() => setImportLorebookOpen(true)} disabled={busy}>
              <Icon name="book" size={12} /> Import SillyTavern Lorebook
            </button>
          </section>

          <div className="sidebar-user-row">
            <span className="muted">{user.username} · {user.role}</span>
            <span className="muted">Ctrl/⌘ K to jump</span>
          </div>
        </div>
      </aside>

      <section className="workspace-main">
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
                  <Icon name={wizardActivityCollapsed ? "chevron-right" : "chevron-down"} size={14} /> {wizardActivityCollapsed ? "Expand" : "Collapse"}
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
                    <button type="button" className="danger-button" onClick={() => setConfirmingWizardCancel(cancelWizardTargetOf(run))} disabled={busy}>Cancel Wizard</button>
                  ) : null}
                  {(run.status === "completed" || run.status === "failed" || run.status === "canceled") && !run.approvedAt ? (
                    <button type="button" className="secondary-button" onClick={() => retryWizardMutation.mutate(run.id)} disabled={busy}>Retry Wizard</button>
                  ) : null}
                  {(run.status === "completed" || run.status === "failed" || run.status === "canceled") && !run.approvedAt ? (
                    <button type="button" className="danger-button" onClick={() => dismissWizardMutation.mutate(run.id)} disabled={busy}>Dismiss</button>
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
              <span className="muted">{searchStatusLabel(searchView)}</span>
            </div>
            {search.isError ? <p className="error">{search.error instanceof Error ? search.error.message : "search request failed"}</p> : null}
            {!searchActive ? <p className="muted">Type at least 2 characters to search session names and message history.</p> : null}
            {searchActive && search.isSuccess && searchResults.length === 0 ? <p className="muted">No matching sessions or messages yet.</p> : null}
            {searchShowsResults(searchView) ? (
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
            // Load-bearing: SessionConversation keeps ALL per-session instance
            // state (draft, search, dialogs, windowing buffers, the
            // localStorage-seeded roll override) on the assumption that it is
            // REMOUNTED per session — never remove this key.
            key={activeSession.id}
            session={activeSession}
            streamState={sessionStreams[activeSession.id] ?? EMPTY_SESSION_STREAM_STATE}
            updateSessionStream={updateSessionStream}
            onOpenDrives={(campaignId, character) => setDrivesPanel({ open: true, campaignId, character })}
            isAdmin={user.role === "admin"}
          />
        ) : (
          <section className="detail-panel empty-state-panel">
            <img className="empty-state-art" src="/brand/empty-session.webp" alt="" width="720" height="720" loading="lazy" />
            <p className="eyebrow">No Active Session</p>
            <h3>Create or select a session</h3>
            <p className="muted">Create a session on the left to start chatting.</p>
            <div className="empty-state-actions">
              <button type="button" className="empty-state-wizard-button" onClick={submitWizardSession} disabled={busy}>
                <Icon name="sparkles" size={20} /> New Campaign Wizard
              </button>
              <button type="button" className="secondary-button empty-state-import-button" onClick={() => setImportLorebookOpen(true)} disabled={busy}>
                <Icon name="book" size={14} /> Import SillyTavern Compatible Lorebook
              </button>
            </div>
          </section>
        )}
      </section>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={workspace.data.sessions}
        folders={workspace.data.folders}
        activeSessionId={workspace.data.preferences.activeSessionId}
        onSelectSession={(sessionId) => updatePreferencesMutation.mutate({ activeSessionId: sessionId })}
        actions={paletteActions}
      />

      <DeferredMount when={passwordDialogOpen}>
        <PasswordDialog
          open={passwordDialogOpen}
          onClose={() => setPasswordDialogOpen(false)}
        />
      </DeferredMount>

      <DeferredMount when={mfaDialogOpen}>
        <MfaDialog
          open={mfaDialogOpen}
          onClose={() => setMfaDialogOpen(false)}
        />
      </DeferredMount>

      <DeferredMount when={providerKeysDialogOpen}>
        <ProviderKeysDialog
          open={providerKeysDialogOpen}
          onClose={() => setProviderKeysDialogOpen(false)}
        />
      </DeferredMount>

      <DeferredMount when={adminStorageDialogOpen}>
        <AdminStorageDialog
          open={adminStorageDialogOpen}
          onClose={() => setAdminStorageDialogOpen(false)}
        />
      </DeferredMount>

      <DeferredMount when={adminAuditDialogOpen}>
        <AdminAuditDialog
          open={adminAuditDialogOpen}
          onClose={() => setAdminAuditDialogOpen(false)}
        />
      </DeferredMount>

      {user.role === "admin" ? (
        <DeferredMount when={serverSettingsOpen}>
          <ServerSettingsDialog open={serverSettingsOpen} onClose={() => setServerSettingsOpen(false)} />
        </DeferredMount>
      ) : null}

      <DeferredMount when={adminUsersDialogOpen}>
        <AdminUsersDialog
          open={adminUsersDialogOpen}
          currentUserId={user.id}
          onClose={() => setAdminUsersDialogOpen(false)}
        />
      </DeferredMount>

      {claudeCodeFullScreen ? (
        <div className="ccp-fullscreen-root">
          <CodingBackendProvider backend={CLAUDE_BACKEND}>
            <DeferredMount when fallback={PANEL_LOADING}><ClaudeCodePage drafts={claudeDrafts} onExit={() => setClaudeCodeFullScreen(false)} /></DeferredMount>
          </CodingBackendProvider>
        </div>
      ) : null}

      {kimiFullScreen ? (
        <div className="ccp-fullscreen-root">
          <CodingBackendProvider backend={KIMI_BACKEND}>
            <DeferredMount when fallback={PANEL_LOADING}><ClaudeCodePage drafts={kimiDrafts} onExit={() => setKimiFullScreen(false)} /></DeferredMount>
          </CodingBackendProvider>
        </div>
      ) : null}

      {codexFullScreen && user.role === "admin" ? (
        <div className="ccp-fullscreen-root">
          <DeferredMount when fallback={PANEL_LOADING}><CodexPage drafts={codexDrafts} onExit={() => setCodexFullScreen(false)} /></DeferredMount>
        </div>
      ) : null}

      <DeferredMount when={deleteAccountDialogOpen}>
        <DeleteAccountDialog
          open={deleteAccountDialogOpen}
          onClose={() => setDeleteAccountDialogOpen(false)}
          onDeleted={() => {
            setDeleteAccountDialogOpen(false);
            setSessionStreams({});
            // Invalidating /me here used to answer {authenticated:false} against a
            // still-remembered identity → the "sign-in expired" overlay for an
            // account that no longer exists. App's sign-out publishes
            // the unauthenticated probe and purges every user cache itself.
            onAccountDeleted();
          }}
          currentUsername={user.username}
        />
      </DeferredMount>

      <CancelWizardDialog
        target={confirmingWizardCancel}
        busy={busy}
        onConfirm={() => { if (confirmingWizardCancel) cancelWizardMutation.mutate(confirmingWizardCancel.runId); setConfirmingWizardCancel(null); }}
        onKeep={() => setConfirmingWizardCancel(null)}
      />

      <DeferredMount when={importLorebookOpen}>
        <ImportLorebookDialog
          open={importLorebookOpen}
          wizardBusy={wizardRunInFlight}
          onClose={() => setImportLorebookOpen(false)}
          onImported={(runId) => {
            setImportLorebookOpen(false);
            // The review opens on the new run as soon as the active list has it, and follows its progress there.
            void queryClient.invalidateQueries({ queryKey: ["wizard-runs"] });
            void queryClient.invalidateQueries({ queryKey: ["wizard-active"] }).then(() => setReviewingWizardRunId(runId));
          }}
        />
      </DeferredMount>

      <DeferredMount when={reviewingWizardRun != null}>
        <WizardReviewDialog
          open={reviewingWizardRun != null}
          run={reviewingWizardRun}
          busy={busy}
          onClose={() => setReviewingWizardRunId(null)}
          onApprove={(runId, payload) => approveWizardMutation.mutate({ runId, payload }, { onSuccess: () => setReviewingWizardRunId(null) })}
          onRetry={(runId) => retryWizardMutation.mutate(runId, { onSuccess: () => setReviewingWizardRunId(null) })}
          onCancel={(runId) => cancelWizardMutation.mutate(runId, { onSuccess: () => setReviewingWizardRunId(null) })}
        />
      </DeferredMount>

      <DeferredMount when={campaignPanelOpen}>
        <CampaignPanel
          open={campaignPanelOpen}
          onClose={() => setCampaignPanelOpen(false)}
        />
      </DeferredMount>

      <DeferredMount when={lorebookPanelOpen}>
        <LorebookPanel
          open={lorebookPanelOpen}
          isAdmin={user.role === "admin"}
          onClose={() => setLorebookPanelOpen(false)}
        />
      </DeferredMount>

      <DeferredMount when={drivesPanel.open}>
        <DrivesPanel
          open={drivesPanel.open}
          onClose={() => setDrivesPanel({ open: false })}
          initialCampaignId={drivesPanel.campaignId ?? null}
          initialCharacter={drivesPanel.character ?? null}
        />
      </DeferredMount>

      {confirming ? (
        <Dialog open onClose={() => setConfirming(null)} label={`Delete ${confirming.name}`} eyebrow="Confirm Delete" title={confirming.name} icon="trash" size="sm">
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
                    // Delete, then create (replaceWizard.ts): the old create-first order met the
                    // server's one-wizard 409 every time. A failed create after the delete says the
                    // old conversation is gone and how to start again.
                    replaceWizardMutation.mutate(confirming.id, { onSettled: () => setConfirming(null) });
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
        </Dialog>
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
          <span className="session-row-bullet"><Icon name={isActive ? "dot" : "circle"} size={10} /></span>
          <span className="session-row-name">{session.name}</span>
          {streaming ? <span className="stream-indicator" aria-hidden="true" /> : null}
        </button>
        <div className="row gap-xs session-row-actions">
          <button type="button" className="ghost-button session-row-action" onClick={() => onStartRename(session)} title="Rename"><Icon name="pencil" size={14} /></button>
          {session.folderId ? <button type="button" className="ghost-button session-row-action" onClick={() => onMove(null)} title="Move to unfiled"><Icon name="home" size={14} /></button> : null}
          <button type="button" className="ghost-button session-row-action danger-text" onClick={onDelete} title="Delete"><Icon name="x" size={14} /></button>
        </div>
      </div>
      {isEditing ? (
        <div className="inline-form">
          <input aria-label={`Rename session ${session.name}`} maxLength={SIDEBAR_TEXT_MAX.renameSession} value={editingSessionName} onChange={(event) => setEditingSessionName(event.target.value)} />
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
              <input aria-label={`Rename folder ${folder.name}`} maxLength={SIDEBAR_TEXT_MAX.renameFolder} value={editingFolderName} onChange={(event) => setEditingFolderName(event.target.value)} />
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
                <span className="folder-row-chevron"><Icon name={folder.collapsed ? "chevron-right" : "chevron-down"} size={14} /></span>
                <span className="folder-row-icon"><Icon name="folder" size={14} /></span>
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
                <button type="button" className="ghost-button session-row-action" onClick={() => onStartFolderRename(folder)} title="Rename"><Icon name="pencil" size={14} /></button>
                <button type="button" className="ghost-button session-row-action danger-text" onClick={() => onDeleteFolder(folder)} title="Delete"><Icon name="x" size={14} /></button>
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
