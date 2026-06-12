import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CodexSessionFile, CodexTranscriptItem } from "@tracyhill-rp/contracts";
import { renderMarkdown } from "../../shared/markdown/renderMarkdown";

import {
  deleteCodexSession,
  getCodexCommandOutput,
  getCodexMessages,
  getCodexSessions,
  getCodexStatus,
  interruptCodexSession,
  streamCodexSession,
  uploadCodexFile,
} from "./codexApi";

type CodexDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function CodexDialog({ open, onClose }: CodexDialogProps) {
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<CodexSessionFile[]>([]);
  const [streamItems, setStreamItems] = useState<CodexTranscriptItem[]>([]);
  // Abort handle for the in-flight send stream — without it, switching
  // sessions or closing the dialog left the old stream appending its events
  // into whatever transcript is currently displayed.
  const streamAbortRef = useRef<AbortController | null>(null);
  // Session the in-flight stream belongs to (a new-session send updates this
  // when the system event resolves the id).
  const streamSessionRef = useRef<string | null>(null);
  useEffect(() => () => streamAbortRef.current?.abort(), []);
  useEffect(() => {
    // Switching away from the streaming session aborts the stream — its events
    // used to keep appending into whatever transcript was displayed.
    if (streamAbortRef.current && streamSessionRef.current !== activeSessionId) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
      setStreamItems([]);
    }
  }, [activeSessionId]);
  const [streaming, setStreaming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expandedCommandId, setExpandedCommandId] = useState<string | null>(null);
  const [commandOutputs, setCommandOutputs] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const autoSelectedRef = useRef(false);
  const statusQuery = useQuery({ queryKey: ["codex-status"], queryFn: getCodexStatus, enabled: open });
  const sessionsQuery = useQuery({ queryKey: ["codex-sessions"], queryFn: getCodexSessions, enabled: open });
  const messagesQuery = useQuery({
    queryKey: ["codex-messages", activeSessionId],
    queryFn: () => getCodexMessages(activeSessionId!),
    enabled: open && Boolean(activeSessionId),
  });
  const uploadMutation = useMutation({ mutationFn: uploadCodexFile });
  const interruptMutation = useMutation({ mutationFn: interruptCodexSession });
  const deleteMutation = useMutation({
    mutationFn: deleteCodexSession,
    onSuccess: async (_, sessionId) => {
      await queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setStreamItems([]);
        setCommandOutputs({});
      }
      setConfirmDelete(false);
    },
  });

  useEffect(() => {
    if (!open) return;
    const defaultWorkspaceId = statusQuery.data?.workspaces[0]?.id ?? "";
    if (defaultWorkspaceId && !workspaceId) setWorkspaceId(defaultWorkspaceId);
  }, [open, statusQuery.data, workspaceId]);

  useEffect(() => {
    if (!open) { autoSelectedRef.current = false; return; }
    const firstSessionId = sessionsQuery.data?.[0]?.sessionId ?? null;
    // Auto-select the first session ONCE per open so the user can still pick
    // "New Session" (which sets activeSessionId to null) without being
    // immediately yanked back to an existing session.
    if (!autoSelectedRef.current && !activeSessionId && firstSessionId) {
      setActiveSessionId(firstSessionId);
      autoSelectedRef.current = true;
      return;
    }
    // If the current session was deleted from under us, fall back to first.
    // This branch is intentional and unrelated to the auto-select guard.
    if (activeSessionId && sessionsQuery.data && !sessionsQuery.data.some((entry) => entry.sessionId === activeSessionId)) {
      setActiveSessionId(firstSessionId);
    }
  }, [activeSessionId, open, sessionsQuery.data]);

  const activeSession = sessionsQuery.data?.find((entry) => entry.sessionId === activeSessionId) ?? null;
  const mergedItems = useMemo(() => [...(messagesQuery.data ?? []), ...streamItems], [messagesQuery.data, streamItems]);
  const busy = streaming || uploadMutation.isPending || interruptMutation.isPending || deleteMutation.isPending;
  const error = actionError
    ?? statusQuery.error?.message
    ?? sessionsQuery.error?.message
    ?? messagesQuery.error?.message
    ?? uploadMutation.error?.message
    ?? interruptMutation.error?.message
    ?? deleteMutation.error?.message
    ?? null;

  if (!open) return null;

  const handleFileAdd = async (selected: FileList | null) => {
    if (!selected?.length) return;
    setActionError(null);
    const next: CodexSessionFile[] = [];
    for (const file of Array.from(selected)) {
      const uploaded = await uploadMutation.mutateAsync({
        name: file.name,
        data: arrayBufferToBase64(await file.arrayBuffer()),
      });
      next.push({
        name: uploaded.name,
        path: uploaded.path,
        kind: file.type.startsWith("image/") ? "image" : "file",
        size: file.size,
      });
    }
    setFiles((current) => [...current, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSend = async () => {
    const trimmed = prompt.trim();
    if (!trimmed && files.length === 0) return;
    if (!activeSessionId && !workspaceId) {
      setActionError("Choose a workspace before starting a new Codex session");
      return;
    }
    setActionError(null);
    setStreaming(true);
    setConfirmDelete(false);
    const currentFiles = files;
    setStreamItems([{
      id: `draft-${Date.now()}`,
      type: "user",
      content: trimmed || "See attached files.",
      files: currentFiles,
      createdAt: new Date().toISOString(),
    }]);
    setPrompt("");
    setFiles([]);
    let nextActiveSessionId = activeSessionId;
    try {
      streamAbortRef.current?.abort();
      const abort = new AbortController();
      streamAbortRef.current = abort;
      streamSessionRef.current = activeSessionId;
      await streamCodexSession({
        prompt: trimmed || "See attached files.",
        sessionId: activeSessionId ?? undefined,
        workspaceId: activeSessionId ? undefined : workspaceId,
        files: currentFiles.length ? currentFiles : undefined,
      }, (event) => {
        if (abort.signal.aborted) return;
        setStreamItems((current) => {
          if (event.type === "system") {
            nextActiveSessionId = event.sessionId;
            streamSessionRef.current = event.sessionId;
            setActiveSessionId(event.sessionId);
            void queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
            return current;
          }
          if (event.type === "text") return [...current, {
            id: event.id,
            type: "text",
            content: event.content,
            createdAt: new Date().toISOString(),
          }];
          if (event.type === "command_start") return [...current, {
            id: event.id,
            type: "command",
            command: event.command,
            cwd: event.cwd,
            status: "running",
            exitCode: null,
            outputPreview: "",
            outputBytes: 0,
            hasFullOutput: false,
            startedAt: new Date().toISOString(),
          }];
          if (event.type === "command_end") return current.map((item) => item.type === "command" && item.id === event.id ? {
            ...item,
            command: event.command,
            status: event.status,
            exitCode: event.exitCode ?? null,
            outputPreview: event.outputPreview ?? "",
            outputTruncated: event.outputTruncated,
            outputBytes: event.outputBytes ?? 0,
            hasFullOutput: event.hasFullOutput,
            completedAt: new Date().toISOString(),
          } : item);
          if (event.type === "result") return [...current, {
            id: `result-${Date.now()}`,
            type: "result",
            sessionId: event.sessionId,
            usage: event.usage ?? null,
            createdAt: new Date().toISOString(),
          }];
          if (event.type === "error") return [...current, {
            id: `error-${Date.now()}`,
            type: "error",
            content: event.message,
            createdAt: new Date().toISOString(),
          }];
          return current;
        });
      }, abort.signal);
      await queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
      if (nextActiveSessionId) await queryClient.invalidateQueries({ queryKey: ["codex-messages", nextActiveSessionId] });
      setStreamItems([]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Codex request failed";
      setActionError(message);
      setStreamItems((current) => [...current, {
        id: `error-${Date.now()}`,
        type: "error",
        content: message,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setStreaming(false);
    }
  };

  const handleInterrupt = async () => {
    if (!activeSessionId) return;
    setActionError(null);
    await interruptMutation.mutateAsync(activeSessionId);
    await queryClient.invalidateQueries({ queryKey: ["codex-sessions"] });
  };

  const handleLoadOutput = async (itemId: string) => {
    setExpandedCommandId((current) => current === itemId ? null : itemId);
    if (!activeSessionId || commandOutputs[itemId]) return;
    const output = await getCodexCommandOutput(activeSessionId, itemId);
    setCommandOutputs((current) => ({ ...current, [itemId]: output.output }));
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog-card claude-dialog" role="dialog" aria-modal="true" aria-label="Codex">
        <div className="cc-topbar">
          <span style={{ color: "var(--accent)", fontSize: 14 }}>⚡</span>
          <span className="cc-title">Codex</span>
          <select
            aria-label="Codex session"
            value={activeSessionId ?? ""}
            onChange={(event) => {
              setActiveSessionId(event.target.value || null);
              setStreamItems([]);
              setConfirmDelete(false);
            }}
          >
            <option value="">New Session</option>
            {(sessionsQuery.data ?? []).map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {(session.title || session.preview || session.sessionId.slice(0, 8)).slice(0, 60)}
                {session.running ? " [running]" : ""}
              </option>
            ))}
          </select>
          <select
            aria-label="Codex workspace"
            value={activeSession?.workspaceId || workspaceId || ""}
            disabled={Boolean(activeSessionId)}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">Workspace...</option>
            {(statusQuery.data?.workspaces ?? []).map((workspace) => (
              <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
            ))}
          </select>
          {activeSessionId ? (
            confirmDelete ? (
              <>
                <button type="button" className="secondary-button" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button type="button" className="danger-button" onClick={() => deleteMutation.mutate(activeSessionId)} disabled={busy}>Confirm</button>
              </>
            ) : (
              <button type="button" className="ghost-button" onClick={() => setConfirmDelete(true)} disabled={busy} title="Delete session">🗑</button>
            )
          ) : null}
          {activeSession?.running ? (
            <button type="button" className="ghost-button" onClick={() => void handleInterrupt()} disabled={busy} title="Interrupt">⏹</button>
          ) : null}
          <button type="button" className="ghost-button" onClick={() => { void queryClient.invalidateQueries({ queryKey: ["codex-status"] }); void queryClient.invalidateQueries({ queryKey: ["codex-sessions"] }); }} title="Refresh">↻</button>
          <button type="button" className="ghost-button" onClick={onClose} title="Close">✕</button>
        </div>
        {error ? <div className="cc-msg cc-error">{error}</div> : null}
        <div className="claude-transcript">
          {mergedItems.map((item) => renderCodexItem(item, expandedCommandId, commandOutputs, handleLoadOutput))}
          {streaming ? (
            <div className="cc-stream-live">
              <div className="cc-msg" style={{ color: "var(--accent)" }}>⏳ Working...</div>
            </div>
          ) : null}
          {!mergedItems.length && !streaming ? <div className="cc-msg cc-system">No transcript yet. Send a prompt to start.</div> : null}
        </div>
        <div className="cc-input-area">
          {files.length ? (
            <div className="cc-file-chips">
              {files.map((file, index) => (
                <span key={index} className="cc-file-chip">
                  {file.name}
                  <button type="button" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>✕</button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="cc-input-row">
            <button type="button" className="cc-attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach files">📎</button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => void handleFileAdd(event.target.files)}
              accept=".md,.txt,.csv,.json,.xml,.yaml,.yml,.log,.js,.py,.html,.css,.png,.jpg,.jpeg,.gif,.webp,.pdf"
            />
            <textarea
              className="claude-input"
              placeholder="Ask Codex..."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void handleSend(); } }}
              disabled={busy}
            />
            {streaming ? (
              <button type="button" className="cc-send stop" onClick={() => void handleInterrupt()}>Stop</button>
            ) : (
              <button type="button" className="cc-send" onClick={() => void handleSend()} disabled={busy || (!prompt.trim() && files.length === 0)}>Send</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderCodexItem(
  item: CodexTranscriptItem,
  expandedCommandId: string | null,
  commandOutputs: Record<string, string>,
  handleLoadOutput: (id: string) => void,
) {
  if (item.type === "user") {
    return (
      <div key={item.id} className="cc-msg cc-user">
        <strong>You:</strong> {item.content || ""}
        {item.files?.length ? <span style={{ fontSize: 11, color: "var(--text2)", marginLeft: 6 }}>({item.files.map((f) => f.name).join(", ")})</span> : null}
      </div>
    );
  }
  if (item.type === "text") {
    return (
      <div key={item.id} className="cc-msg">
        <div className="msg-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.content || "") }} />
      </div>
    );
  }
  if (item.type === "command") {
    const open = expandedCommandId === item.id;
    const output = commandOutputs[item.id] || item.outputPreview || "";
    return (
      <div key={item.id} className="cc-msg cc-tool">
        <div className="cc-tool-header cc-collapsible" onClick={() => handleLoadOutput(item.id)}>
          <span>{open ? "▾" : "▸"} {item.command}</span>
          <span style={{ color: "var(--text2)", fontWeight: 400, marginLeft: "auto" }}>
            exit {item.exitCode ?? "?"}{item.outputBytes != null ? ` · ${item.outputBytes} bytes` : ""}
          </span>
        </div>
        {open ? (
          <>
            {item.cwd ? <div style={{ fontSize: 10, color: "var(--text2)", marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>{item.cwd}</div> : null}
            <pre className="cc-tool-output">{output || "[no output]"}</pre>
          </>
        ) : null}
      </div>
    );
  }
  if (item.type === "result") {
    return (
      <div key={item.id} className="cc-msg cc-result">
        Session: {item.sessionId?.slice(0, 8)}
        {item.usage ? ` · in ${item.usage.input_tokens || 0} / out ${item.usage.output_tokens || 0}` : ""}
      </div>
    );
  }
  if (item.type === "error") {
    return <div key={item.id} className="cc-msg cc-error">{item.content || "Codex error"}</div>;
  }
  return null;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
