import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";

import type { CodexMode, CodexSessionFile, CodexStatusResponse } from "@tracyhill-rp/contracts";
import { PANEL_UPLOAD_MAX_BYTES } from "@tracyhill-rp/contracts";

import { searchCodexFiles, uploadCodexFile } from "./codexApi";
import type { CodexDraftStore } from "./codexDrafts";
import { fileToBase64 } from "../../shared/files/fileToBase64";
import { Icon } from "../../shared/ui/Icon";

type Props = {
  status?: CodexStatusResponse;
  drafts: CodexDraftStore;
  draftKey: string;
  ready: boolean;
  settingsReady: boolean;
  settingsBusy: boolean;
  activeSessionId: string | null;
  activeTurn: boolean;
  workspaceId: string;
  mode: CodexMode;
  model: string;
  effort: string;
  serviceTier: string | null;
  skills: string[];
  onWorkspaceChange: (value: string) => void;
  onModeChange: (value: CodexMode) => void;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  onServiceTierChange: (value: string | null) => void;
  onSubmit: (prompt: string, files: CodexSessionFile[], draftKey: string) => Promise<void>;
  onInterrupt: () => void;
  onCommand: (command: string, args: string, files: CodexSessionFile[], draftKey: string) => Promise<void> | void;
};

const PANEL_COMMANDS = [
  ["clear", "Start a new session"], ["compact", "Compact context"], ["fork", "Fork this thread"], ["review", "Review uncommitted changes"],
  ["export", "Export markdown"], ["doctor", "Open diagnostics"], ["skills", "List installed skills"], ["mcp", "Show MCP servers"],
  ["model", "Show the current model"], ["effort", "Show reasoning effort"], ["mode", "Toggle Read Only / YOLO"], ["cwd", "Show working directory"],
  ["help", "Show keyboard shortcuts"],
] as const;

export function CodexComposer(props: Props) {
  const draft = useSyncExternalStore(props.drafts.subscribe, () => props.drafts.get(props.draftKey));
  const { input, files, error, pending: pendingCount, uploads } = draft;
  const submitting = pendingCount > 0;
  const setInput = (value: string | ((current: string) => string)) => props.drafts.update(props.draftKey, current => ({ ...current, input: typeof value === "function" ? value(current.input) : value }));
  const setFiles = (update: (current: CodexSessionFile[]) => CodexSessionFile[]) => props.drafts.update(props.draftKey, current => ({ ...current, files: update(current.files) }));
  const [dragging, setDragging] = useState(false);
  const [dismissedPopup, setDismissedPopup] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [atResults, setAtResults] = useState<Array<{ root: string; path: string; name: string; matchType: string }>>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedModel = props.status?.models.find((entry) => entry.id === props.model);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const tiers = selectedModel?.serviceTiers ?? [];
  const slashQuery = input.match(/^\/([^\s]*)$/)?.[1]?.toLowerCase() ?? null;
  const slashEntries = useMemo(() => {
    if (slashQuery == null || dismissedPopup === input) return [];
    const entries = [
      ...PANEL_COMMANDS.map(([name, description]) => ({ name, description, group: "Panel" })),
      ...props.skills.map((name) => ({ name, description: "Codex skill", group: "Skill" })),
    ];
    return entries.filter((entry) => entry.name.toLowerCase().includes(slashQuery)).slice(0, 20);
  }, [props.skills, slashQuery, dismissedPopup, input]);
  const atQuery = input.match(/(?:^|\s)@([^\s@]{1,80})$/)?.[1] ?? null;

  useEffect(() => { setSlashIndex(0); }, [slashQuery]);
  useEffect(() => {
    setAtResults([]); setSearchError(null);
    if (!atQuery || !props.workspaceId || dismissedPopup === input) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchCodexFiles(props.workspaceId, atQuery).then((result) => {
        if (!cancelled) setAtResults(result.files.slice(0, 12));
      }).catch(reason => { if (!cancelled) setSearchError(reason instanceof Error ? reason.message : "File search failed"); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [atQuery, props.workspaceId, dismissedPopup, input]);

  const addBrowserFiles = async (selected: FileList | File[]) => {
    const key = props.draftKey;
    const selectedFiles = Array.from(selected);
    // Count the whole batch before FileReader starts, including concurrent drops.
    props.drafts.update(key, current => ({ ...current, error: null, uploads: current.uploads + 1 }));
    try {
      for (const file of selectedFiles) {
        try {
          if (file.size > PANEL_UPLOAD_MAX_BYTES) throw new Error(`exceeds the ${Math.round(PANEL_UPLOAD_MAX_BYTES / 1024 / 1024)} MB upload limit`);
          const uploaded = await uploadCodexFile({ name: file.name, data: await fileToBase64(file) });
          props.drafts.update(key, current => ({ ...current, files: [...current.files, { name: file.name, path: uploaded.path, kind: file.type.startsWith("image/") ? "image" : "file", size: file.size }] }));
        } catch (reason) {
          props.drafts.update(key, current => ({ ...current, error: [current.error, `${file.name}: ${reason instanceof Error ? reason.message : "upload failed"}`].filter(Boolean).join("\n") }));
        }
      }
    } finally { props.drafts.update(key, current => ({ ...current, uploads: current.uploads - 1 })); }
  };

  const addMention = (entry: { root: string; path: string; name: string }) => {
    const path = entry.path.startsWith("/") ? entry.path : `${entry.root.replace(/\/$/, "")}/${entry.path}`;
    setFiles((current) => current.some((file) => file.path === path) ? current : [...current, { name: entry.name, path, kind: "file" }]);
    setInput((current) => current.replace(/@[^\s@]+$/, ""));
    setAtResults([]);
  };

  const send = async () => {
    const key = props.draftKey;
    const current = props.drafts.get(key);
    if (!props.ready || props.settingsBusy || current.pending || current.uploads) return;
    const prompt = current.input.trim();
    if (!prompt && !current.files.length) return;
    const isCommand = prompt.startsWith("/") && !prompt.includes("\n");
    const [command = "", ...rest] = isCommand ? prompt.slice(1).split(/\s+/) : [];
    const isPanelCommand = PANEL_COMMANDS.some(([name]) => name === command.toLowerCase());
    const submittedFiles = isPanelCommand ? [] : current.files;
    props.drafts.update(key, draft => ({ ...draft, input: "", files: isPanelCommand ? draft.files : [], pending: draft.pending + 1, error: null }));
    try {
      if (isCommand) await props.onCommand(command, rest.join(" "), submittedFiles, key);
      else await props.onSubmit(prompt, submittedFiles, key);
    } catch (reason) {
      props.drafts.restore(key, current.input, submittedFiles, reason instanceof Error ? reason.message : "Codex request failed");
    } finally { props.drafts.update(key, draft => ({ ...draft, pending: Math.max(0, draft.pending - 1) })); }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void addBrowserFiles(event.dataTransfer.files);
  };

  return (
    <div className={`ccp-composer ${props.activeTurn ? "is-streaming" : ""} ${dragging ? "is-file-drag" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {error || searchError ? <div className="ccp-composer-error" role="alert">{error || searchError}</div> : null}
      {uploads ? <div role="status">Uploading attachments…</div> : null}
      {files.length ? <div className="ccp-composer-chips">{files.map((file) => <span key={file.path} className="ccp-file-chip"><Icon name={file.kind === "image" ? "image" : "file"} size={12} /> {file.name}<button type="button" onClick={() => setFiles((current) => current.filter((entry) => entry.path !== file.path))}><Icon name="x" size={12} /></button></span>)}</div> : null}
      <div className="ccp-composer-row">
        <button type="button" className="ccp-composer-attach" title="Attach files" onClick={() => fileInputRef.current?.click()}><Icon name="paperclip" size={16} /></button>
        <input ref={fileInputRef} hidden type="file" multiple onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; if (selected.length) void addBrowserFiles(selected); }} />
        <div className="ccp-composer-textarea-wrap">
          <textarea
            className="ccp-composer-textarea"
            value={input}
            placeholder={props.mode === "yolo" ? "Ask Codex, /command, @file, or !shell…" : "Ask Codex, /command, or @file…"}
            onChange={(event) => { setDismissedPopup(null); setInput(event.target.value); }}
            onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void addBrowserFiles(event.clipboardData.files); } }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape" && (slashEntries.length || atResults.length || atQuery)) { event.preventDefault(); event.stopPropagation(); setDismissedPopup(input); setAtResults([]); return; }
              if (slashEntries.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setSlashIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + slashEntries.length) % slashEntries.length);
              } else if (slashEntries.length && event.key === "Tab") {
                event.preventDefault();
                setInput(`/${slashEntries[slashIndex]?.name || ""} `);
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                // Enter on a highlighted popup row completes it (as the ClaudeCode
                // composer does) — sending the raw partial posted "/co" to Codex as a
                // prompt. A fully typed name still sends.
                const highlighted = slashEntries[slashIndex]?.name;
                if (slashQuery != null && highlighted && slashQuery !== highlighted.toLowerCase()) { setInput(`/${highlighted} `); return; }
                void send();
              }
            }}
          />
          {slashEntries.length ? <div className="ccp-slash-popup">{slashEntries.map((entry, index) => <button type="button" key={`${entry.group}-${entry.name}`} className={`ccp-slash-row ${index === slashIndex ? "is-sel" : ""}`} onClick={() => setInput(`/${entry.name} `)}><span className="ccp-slash-name">/{entry.name}</span><span className="ccp-slash-desc">{entry.description}</span><span className="ccp-slash-group">{entry.group}</span></button>)}</div> : null}
          {atQuery && dismissedPopup !== input && atResults.length ? <div className="ccp-at-popup"><div className="ccp-at-browse">Workspace matches for @{atQuery}</div>{atResults.map((entry) => <button type="button" key={`${entry.root}:${entry.path}`} className="ccp-at-row" onClick={() => addMention(entry)}><span><Icon name={entry.matchType === "directory" ? "folder" : "file"} size={14} /></span><span>{entry.path}</span></button>)}</div> : null}
        </div>
        <div className="ccp-composer-controls">
          {!props.activeSessionId ? <select disabled={submitting || props.settingsBusy} aria-label="Workspace" value={props.workspaceId} onChange={(event) => props.onWorkspaceChange(event.target.value)}><option value="">Workspace…</option>{(props.status?.workspaces ?? []).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select> : null}
          <div className="ccp-mode-toggle" title="Shift+Tab toggles mode">
            <button type="button" disabled={props.settingsBusy || !props.settingsReady || submitting} className={`ccp-mode-opt ${props.mode === "read-only" ? "is-active" : ""}`} onClick={() => props.onModeChange("read-only")}><Icon name="diamond" size={12} /> Read Only</button>
            <button type="button" disabled={props.settingsBusy || !props.settingsReady || submitting} className={`ccp-mode-opt ${props.mode === "yolo" ? "is-active" : ""}`} onClick={() => props.onModeChange("yolo")}><Icon name="zap" size={12} /> YOLO</button>
          </div>
          <select disabled={props.settingsBusy || submitting || !props.status || !props.settingsReady} aria-label="Model" value={props.model} onChange={(event) => props.onModelChange(event.target.value)}>{!selectedModel && props.model ? <option value={props.model}>{props.model} (saved)</option> : null}{(props.status?.models ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}</select>
          <select disabled={props.settingsBusy || submitting || !props.ready} aria-label="Reasoning effort" value={props.effort} onChange={(event) => props.onEffortChange(event.target.value)}>{!efforts.some(entry => entry.id === props.effort) ? <option value={props.effort}>{props.effort || "Default"}</option> : null}{efforts.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}</select>
          {tiers.length ? <select disabled={props.settingsBusy || submitting || !props.ready} aria-label="Service tier" value={props.serviceTier ?? ""} onChange={(event) => props.onServiceTierChange(event.target.value || null)}><option value="">Standard</option>{tiers.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select> : null}
          <button type="button" className="ccp-composer-send" onClick={() => void send()} disabled={!props.ready || props.settingsBusy || submitting || uploads > 0 || (!input.trim() && !files.length)}>{submitting ? "…" : props.activeTurn ? "Steer ↵" : "Send"}</button>
          {props.activeTurn ? <button type="button" className="ccp-composer-stop" onClick={props.onInterrupt}>⏹ Stop</button> : null}
        </div>
      </div>
    </div>
  );
}
