import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ClaudeCodeEffort, ClaudeCodeFsTreeEntry, ClaudeCodeMode, KimiServingMode, KimiServingModeInfo } from "@tracyhill-rp/contracts";
import { PANEL_UPLOAD_MAX_BYTES } from "@tracyhill-rp/contracts";

import {
  getClaudeCodeFsTree,
  sendClaudeCodePrompt,
  uploadClaudeCodeFile,
} from "./claudeCodeApi";
import { KIMI_SERVING_LABELS, useCodingBackend } from "./backend";
import type { ClaudeDraftStore } from "./claudeDrafts";
import { fileToBase64 } from "../../shared/files/fileToBase64";
import { Icon } from "../../shared/ui/Icon";

type ComposerProps = {
  activeSessionId: string | null;
  // Shell-owned draft store + the slot this composer edits (`session:<id>` or
  // the New slot). Drafts, chips and in-flight counters live there, never in
  // component state.
  drafts: ClaudeDraftStore;
  draftKey: string;
  streaming: boolean;
  // `draftKey` identifies the slot the send came from so the page can attach
  // a New draft to the session id the stream resolves.
  onSent: (queryKey: string, previousSessionId: string | null, prompt: string, draftKey: string) => void;
  onQueued: (prompt: string) => void;
  onInterrupt: () => void;
  onSlashCommand: (command: string, args: string) => void;
  model: string;
  effort: ClaudeCodeEffort;
  mode: ClaudeCodeMode;
  researchBash: boolean;
  currentMode?: string;
  serverCommands: { name: string; description?: string | null }[];
  serverSkills: string[];
  suggestions: string[];
  onModelChange: (model: string) => void;
  onEffortChange: (effort: ClaudeCodeEffort) => void;
  onModeToggle: (mode: "research" | "execute") => void;
  // Shift+Tab from the textarea — the page owns the flash + persistence, the
  // composer owns the popup-open guard.
  onCycleMode: () => void;
  onResearchBashToggle: (on: boolean) => void;
  // Kimi backend only — the serving swap replaces the model picker.
  servingMode?: KimiServingMode;
  servingModes?: KimiServingModeInfo[];
  onServingChange?: (mode: KimiServingMode) => void;
};

// The binary mode the UI exposes. Any legacy reported mode collapses to one of
// these two for the toggle's active state.
function binaryOf(mode: string | undefined): "research" | "execute" {
  return mode === "research" || mode === "plan" ? "research" : "execute";
}

export function Composer(props: ComposerProps) {
  const {
    activeSessionId, drafts, draftKey, streaming, onSent, onQueued, onInterrupt, onSlashCommand,
    model, effort, mode, researchBash, currentMode, serverCommands, serverSkills, suggestions,
    onModelChange, onEffortChange, onModeToggle, onCycleMode, onResearchBashToggle,
    servingMode, servingModes, onServingChange,
  } = props;

  const { apiBase, sessionsKey, models: backendModels, efforts, serving, supportsCompact, title: backendTitle } = useCodingBackend();
  const queryClient = useQueryClient();
  const draft = useSyncExternalStore(drafts.subscribe, () => drafts.get(draftKey));
  const { input, files, error, pending, uploads } = draft;
  const setInput = (value: string | ((current: string) => string)) => drafts.update(draftKey, (c) => ({ ...c, input: typeof value === "function" ? value(c.input) : value }));
  const setFiles = (update: (current: typeof files) => typeof files) => drafts.update(draftKey, (c) => ({ ...c, files: update(c.files) }));
  const setError = (value: string | null) => drafts.update(draftKey, (c) => (c.error === value ? c : { ...c, error: value }));
  const [fileDrag, setFileDrag] = useState(false);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [escArmed, setEscArmed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeBinary = binaryOf(streaming ? currentMode ?? mode : mode);

  // Slash popup (allowed even while streaming now that the composer stays live).
  // Escape dismisses it for the current text; typing reopens it.
  const [dismissedPopup, setDismissedPopup] = useState<string | null>(null);
  const slashOpen = input.startsWith("/") && !input.includes("\n") && dismissedPopup !== input;
  const [slashSelection, setSlashSelection] = useState(0);

  // @ mention popup
  const [atPopup, setAtPopup] = useState<{ prefix: string; start: number } | null>(null);
  const [atEntries, setAtEntries] = useState<ClaudeCodeFsTreeEntry[]>([]);
  const [atSelection, setAtSelection] = useState(0);
  // Empty = let the agent service default to its own cwd for the first listing.
  const [atBrowsePath, setAtBrowsePath] = useState<string>("");

  // Per-slot transient state resets when the composer moves to another draft
  // slot; the draft itself comes from the store, so no remount is needed (a
  // keyed remount would drop focus mid-typing when a New session's id is
  // adopted).
  useEffect(() => { setHistoryIdx(-1); setEscArmed(false); setSlashSelection(0); setDismissedPopup(null); }, [draftKey]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 20 * 20;
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [input]);

  // Shift+Tab is bound ONCE: the page listener covers BODY, the textarea's
  // onKeyDown below covers the composer (it knows whether a popup is open). A
  // second window listener here fired alongside the page's — two mode writes
  // per keypress.

  // Backend-hidden commands never reach the popup, whatever their source —
  // the SDK also advertises /compact, which must not pass through as a prompt
  // on a backend where compaction is disabled.
  const hiddenCommands = useMemo(() => new Set(supportsCompact ? [] : ["compact"]), [supportsCompact]);
  const commands = useMemo(() => (slashOpen ? matchSlashCommands(input, serverCommands, serverSkills, hiddenCommands) : []), [input, slashOpen, serverCommands, serverSkills, hiddenCommands]);

  const onFileAdd = async (selected: FileList | File[] | null) => {
    if (!selected?.length) return;
    const key = draftKey;
    const list = Array.from(selected);
    // Count the batch BEFORE the first local read starts: reading and
    // encoding a 20 MB drop takes visible time, and `send()` used to gate only
    // on the upload request, so Enter in that window posted the prompt without
    // the attachment and the chip then appeared under an emptied composer.
    drafts.update(key, (c) => ({ ...c, error: null, uploads: c.uploads + 1 }));
    try {
      for (const f of list) {
        try {
          // Same ceiling the API enforces (413 before proxying) — check locally so
          // a big drop fails with a plain message instead of a parser error.
          if (f.size > PANEL_UPLOAD_MAX_BYTES) throw new Error(`exceeds the ${Math.round(PANEL_UPLOAD_MAX_BYTES / 1024 / 1024)} MB upload limit`);
          const uploaded = await uploadClaudeCodeFile(apiBase, { name: f.name, data: await fileToBase64(f) });
          drafts.update(key, (c) => ({ ...c, files: [...c.files, { name: f.name, path: uploaded.path, kind: f.type.startsWith("image/") ? "image" : "file", size: f.size }] }));
        } catch (err) {
          drafts.update(key, (c) => ({ ...c, error: [c.error, `${f.name}: ${err instanceof Error ? err.message : "upload failed"}`].filter(Boolean).join("\n") }));
        }
      }
    } finally {
      drafts.update(key, (c) => ({ ...c, uploads: Math.max(0, c.uploads - 1) }));
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const send = async () => {
    const key = draftKey;
    const current = drafts.get(key);
    if (current.pending || current.uploads) return;
    const raw = current.input;
    if (!raw.trim() && current.files.length === 0) return;
    // Panel slash command dispatch (client-side commands only). Anything else
    // starting with "/" is passed THROUGH to the SDK as a prompt.
    if (raw.startsWith("/")) {
      const trimmed = raw.trim();
      const space = trimmed.indexOf(" ");
      const command = (space === -1 ? trimmed : trimmed.slice(0, space)).slice(1);
      const args = space === -1 ? "" : trimmed.slice(space + 1);
      if (PANEL_HANDLERS.has(command)) {
        onSlashCommand(command, args);
        setInput("");
        return;
      }
      // else: fall through — send the slash command to the SDK as a prompt.
    }
    let prompt = raw.trim();
    // `!cmd` and `#note` are prompt rewrites, not CLI-parity actions: this
    // panel has no local Bash run and no memory-file write. The rewrite now
    // says so in the prompt itself, so the model and the transcript show
    // exactly what was asked (a bare "git status" prompt was answered in prose
    // in Research mode without the shell checkbox).
    const command = prompt.startsWith("!") ? prompt.slice(1).trim() : "";
    const note = prompt.startsWith("#") ? prompt.slice(1).trim() : "";
    if (command) prompt = `Run this shell command and show me its output:\n\`\`\`bash\n${command}\n\`\`\``;
    else if (note) prompt = `Remember this in project memory (add it to the project's CLAUDE.md or memory file): ${note}`;
    const finalPrompt = prompt || "See attached files.";
    drafts.pushHistory(raw.trim());
    setHistoryIdx(-1);
    const submittedFiles = current.files;
    // The send belongs to the session this slot was written for, whatever the
    // rail shows by the time the response arrives.
    const owner = activeSessionId;
    drafts.update(key, (c) => ({ ...c, input: "", files: [], error: null, pending: c.pending + 1 }));
    try {
      const response = await sendClaudeCodePrompt(apiBase, {
        prompt: finalPrompt,
        sessionId: owner,
        files: submittedFiles.length ? submittedFiles : undefined,
        model: serving ? undefined : model || undefined, // Kimi: model is fixed by serving mode
        effort: effort || undefined,
        mode: mode || undefined,
        researchBash,
        servingMode: serving ? servingMode : undefined,
      });
      // While streaming, the message is normally queued into the live session —
      // the open stream delivers it; do NOT reconnect (that would replay &
      // duplicate). BUT the turn can complete mid-POST: then the server starts a
      // FRESH query (the response carries a new queryKey and is NOT flagged
      // queued), and if we still take the onQueued path we'd never connect to it.
      // Trust the server's `queued` flag when present; only treat as
      // queued when streaming AND the server actually queued it.
      const serverQueued = (response as { queued?: boolean }).queued;
      const wasQueued = serverQueued ?? streaming;
      if (streaming && wasQueued) onQueued(finalPrompt);
      else onSent(response.queryKey, owner, finalPrompt, key);
      void queryClient.invalidateQueries({ queryKey: [sessionsKey] });
    } catch (err) {
      // Put the submitted text and chips back beside anything typed meanwhile.
      drafts.restore(key, raw, submittedFiles, err instanceof Error ? err.message : "Send failed");
    } finally { drafts.update(key, (c) => ({ ...c, pending: Math.max(0, c.pending - 1) })); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an IME composition must not submit.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Escape belongs to an open slash/@ popup first: it used to reach the
    // streaming branch below and interrupt the running turn.
    if (e.key === "Escape" && ((slashOpen && commands.length > 0) || (atPopup && atEntries.length > 0))) {
      e.preventDefault();
      e.stopPropagation();
      setDismissedPopup(input);
      setAtPopup(null);
      setAtEntries([]);
      return;
    }
    // double-Esc clears the draft (single Esc while streaming interrupts).
    if (e.key === "Escape") {
      if (streaming) { e.preventDefault(); onInterrupt(); return; }
      if (input) {
        e.preventDefault();
        if (escArmed) { setInput(""); setEscArmed(false); }
        else { setEscArmed(true); window.setTimeout(() => setEscArmed(false), 600); }
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey && !(e.metaKey || e.ctrlKey)) {
      // Popup open: swallow the key (no mode flip, no focus jump) — the
      // popup's own keys are ↑/↓/Enter.
      e.preventDefault();
      if ((slashOpen && commands.length > 0) || (atPopup && atEntries.length > 0)) return;
      onCycleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (slashOpen && commands.length > 0) {
        const chosen = commands[slashSelection] ?? commands[0]!;
        const typedName = input.slice(1).split(/\s/)[0] ?? "";
        if (typedName !== chosen.name) {
          e.preventDefault();
          setInput(`/${chosen.name} `);
          return;
        }
      }
      if (atPopup && atEntries.length > 0) {
        e.preventDefault();
        const chosen = atEntries[atSelection] ?? atEntries[0]!;
        applyAtCompletion(chosen);
        return;
      }
      e.preventDefault();
      // Gate on the in-flight send so a rapid second Enter can't fire a
      // duplicate POST before the first resolves.
      if (pending) return;
      void send();
      return;
    }
    if (slashOpen && commands.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashSelection((s) => Math.min(s + 1, commands.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashSelection((s) => Math.max(s - 1, 0)); return; }
    }
    if (atPopup && atEntries.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAtSelection((s) => Math.min(s + 1, atEntries.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAtSelection((s) => Math.max(s - 1, 0)); return; }
    }
    // ↑ walks back through history from an empty draft, or from the entry the
    // previous ↑ recalled (unchanged). Gating on `input === ""` alone made the
    // walk unreachable past the most recent prompt.
    if (e.key === "ArrowUp" && !slashOpen && !atPopup && canRecallOlder(input, historyIdx, drafts.history)) {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, drafts.history.length - 1);
      setHistoryIdx(next);
      setInput(drafts.history[next]!);
      return;
    }
    if (e.key === "ArrowDown" && historyIdx >= 0 && !atPopup) {
      e.preventDefault();
      const next = historyIdx - 1;
      setHistoryIdx(next);
      setInput(next < 0 ? "" : drafts.history[next]!);
      return;
    }
  };

  useEffect(() => {
    if (!textareaRef.current) return;
    const pos = textareaRef.current.selectionStart ?? input.length;
    const before = input.slice(0, pos);
    const match = before.match(/@(\S*)$/);
    if (!match || dismissedPopup === input) { setAtPopup(null); setAtEntries([]); return; }
    const prefix = match[1] || "";
    setAtPopup({ prefix, start: pos - prefix.length - 1 });
    setAtSelection(0);
    const browse = (() => {
      if (prefix.startsWith("/")) {
        const lastSlash = prefix.lastIndexOf("/");
        return lastSlash <= 0 ? "/" : prefix.slice(0, lastSlash);
      }
      return atBrowsePath;
    })();
    // One listing per pause in typing, and a listing that resolves after the
    // text moved on is dropped: without the debounce + cancel flag every
    // keystroke fired its own request and the slowest response installed
    // entries filtered by an older prefix.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getClaudeCodeFsTree(apiBase, browse).then((res) => {
        if (cancelled) return;
        const filter = prefix.startsWith("/") ? prefix.slice(prefix.lastIndexOf("/") + 1) : prefix;
        const filtered = res.entries.filter((e) => e.name.toLowerCase().startsWith(filter.toLowerCase())).slice(0, 20);
        setAtEntries(filtered);
      }).catch(() => { if (!cancelled) setAtEntries([]); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [input, atBrowsePath, dismissedPopup, apiBase]);

  const applyAtCompletion = (entry: ClaudeCodeFsTreeEntry) => {
    if (!atPopup) return;
    const before = input.slice(0, atPopup.start);
    const after = input.slice(atPopup.start + 1 + atPopup.prefix.length);
    const replacement = entry.kind === "dir" ? `@${entry.path}/` : `@${entry.path} `;
    const newValue = before + replacement + after;
    setInput(newValue);
    if (entry.kind === "dir") setAtBrowsePath(entry.path);
    setTimeout(() => {
      textareaRef.current?.focus();
      const pos = (before + replacement).length;
      textareaRef.current?.setSelectionRange(pos, pos);
    }, 0);
    if (entry.kind === "file") setAtPopup(null);
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const images = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    const list = images.map((it) => it.getAsFile()).filter((f): f is File => !!f);
    if (list.length) await onFileAdd(list);
  };

  const selectSuggestion = (s: string) => { setInput(s); textareaRef.current?.focus(); };

  const sendDisabled = pending > 0 || uploads > 0 || (!input.trim() && files.length === 0);

  return (
    <div
      className={`ccp-composer ${fileDrag ? "is-file-drag" : ""} ${streaming ? "is-streaming" : ""}`}
      onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes("Files")) setFileDrag(true); }}
      onDragLeave={() => setFileDrag(false)}
      onDrop={(e) => { e.preventDefault(); setFileDrag(false); void onFileAdd(e.dataTransfer.files); }}
    >
      {error ? <div className="ccp-composer-error" role="alert">{error}</div> : null}
      {uploads ? <div role="status">Uploading attachments…</div> : null}
      {suggestions.length && !streaming ? (
        <div className="ccp-suggest-row">
          {suggestions.map((s, i) => (
            <button key={i} type="button" className="ccp-suggest-chip" onClick={() => selectSuggestion(s)}>{s}</button>
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="ccp-composer-chips">
          {files.map((f, i) => (
            <span key={`${i}:${f.path}`} className="ccp-file-chip">
              <Icon name={f.kind === "image" ? "image" : "file"} size={12} /> {f.name}
              <button type="button" onClick={() => setFiles((c) => c.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="ccp-composer-row">
        <button type="button" className="ccp-composer-attach" title="Attach files" onClick={() => fileInputRef.current?.click()}><Icon name="paperclip" size={16} /></button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void onFileAdd(e.target.files)}
          accept=".md,.txt,.csv,.json,.xml,.yaml,.yml,.log,.js,.ts,.tsx,.jsx,.py,.html,.css,.png,.jpg,.jpeg,.gif,.webp,.pdf"
        />
        <div className="ccp-composer-textarea-wrap">
          <textarea
            ref={textareaRef}
            className="ccp-composer-textarea"
            placeholder={composerPlaceholder({ streaming, activeSessionId, backendTitle })}
            value={input}
            onChange={(e) => { setDismissedPopup(null); setInput(e.target.value); if (error) setError(null); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={3}
          />
          {slashOpen && commands.length > 0 ? (
            <div className="ccp-slash-popup">
              {commands.map((cmd, i) => (
                <button
                  key={`${cmd.group}:${cmd.name}`}
                  type="button"
                  className={`ccp-slash-row ${i === slashSelection ? "is-sel" : ""}`}
                  onClick={() => {
                    if (cmd.group === "Panel") { onSlashCommand(cmd.name, ""); setInput(""); }
                    else setInput(`/${cmd.name} `);
                  }}
                >
                  <span className="ccp-slash-name">/{cmd.name}</span>
                  <span className="ccp-slash-desc">{cmd.desc}</span>
                  <span className="ccp-slash-group">{cmd.group}</span>
                </button>
              ))}
            </div>
          ) : null}
          {atPopup && atEntries.length > 0 ? (
            <div className="ccp-at-popup">
              <div className="ccp-at-browse">{atBrowsePath || "~"}</div>
              {atEntries.map((entry, i) => (
                <button
                  key={entry.path}
                  type="button"
                  className={`ccp-at-row ${i === atSelection ? "is-sel" : ""}`}
                  onClick={() => applyAtCompletion(entry)}
                >
                  <span><Icon name={entry.kind === "dir" ? "folder" : "file"} size={14} /></span>
                  <span>{entry.name}</span>
                  <span className="ccp-at-kind">{entry.kind}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="ccp-composer-controls">
          <div className="ccp-mode-toggle" title="Shift+Tab to toggle">
            <button type="button" className={`ccp-mode-opt ${activeBinary === "research" ? "is-active" : ""}`} onClick={() => onModeToggle("research")}><Icon name="search" size={13} /> Research</button>
            <button type="button" className={`ccp-mode-opt ${activeBinary === "execute" ? "is-active" : ""}`} onClick={() => onModeToggle("execute")}><Icon name="zap" size={13} /> Execute</button>
          </div>
          {activeBinary === "research" ? (
            <label className="ccp-shell-check" title="Allow shell (Bash) in Research mode — still read-only by convention">
              <input type="checkbox" checked={researchBash} onChange={(e) => onResearchBashToggle(e.target.checked)} /> shell
            </label>
          ) : null}
          {serving ? (
            <select
              value={servingMode ?? "api"}
              onChange={(e) => onServingChange?.(e.target.value as KimiServingMode)}
              title="Serving mode — API (pay-per-token) or Kimi For Coding subscription"
              className="ccp-serving-select"
            >
              {(servingModes ?? []).map((m) => (
                <option key={m.id} value={m.id} disabled={!m.configured}>
                  {KIMI_SERVING_LABELS[m.id]}{m.configured ? "" : " (no key)"}
                </option>
              ))}
            </select>
          ) : (
            <select value={model} onChange={(e) => onModelChange(e.target.value)} title="Model">
              {(backendModels ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
          <select value={effort} onChange={(e) => onEffortChange(e.target.value as ClaudeCodeEffort)} title="Effort" aria-label="Effort">
            {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          {streaming ? (
            <>
              <button type="button" className="ccp-composer-send" onClick={() => void send()} disabled={sendDisabled} title="Queue this for after the current turn">
                Queue ⏎
              </button>
              <button type="button" className="ccp-composer-stop" onClick={onInterrupt}>⏹ Stop</button>
            </>
          ) : (
            <button type="button" className="ccp-composer-send" onClick={() => void send()} disabled={sendDisabled}>
              {pending ? "…" : "Send"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Slash commands ──────────────────────────────────────────────────────────

type PanelCmd = { name: string; desc: string };
type SlashEntry = { name: string; desc: string; group: "Panel" | "Session" | "Skills" };

// Panel commands run client-side in the page; everything else is passed through
// to the SDK as a prompt. Every entry here is live (the old `disabled`
// scaffolding never had a setter).
const PANEL_COMMANDS: PanelCmd[] = [
  { name: "clear", desc: "Start a new session" },
  { name: "model", desc: "Show current model" },
  { name: "effort", desc: "Show current effort" },
  { name: "research", desc: "Switch to Research & Planning" },
  { name: "execute", desc: "Switch to Full Execution" },
  { name: "compact", desc: "Compact the conversation" },
  { name: "context", desc: "Show context usage" },
  { name: "doctor", desc: "Show session diagnostics" },
  { name: "memory", desc: "Browse/edit memory files" },
  { name: "cost", desc: "Show cost for this session" },
  { name: "export", desc: "Download transcript as markdown" },
  { name: "fork", desc: "Branch this conversation" },
  { name: "cwd", desc: "Show current working directory" },
  { name: "help", desc: "List available commands" },
];

// /compact stays a panel handler on EVERY backend so a typed "/compact" is
// intercepted (the page refuses it where unsupported) instead of falling
// through to the SDK as a prompt.
const PANEL_HANDLERS = new Set(PANEL_COMMANDS.map((c) => c.name));

/**
 * The composer's placeholder: a follow-up while a turn streams, the session hint, or the New-session line. The
 * composer serves the Claude Code and Kimi panels, so the hint names neither agent (Android copies
 * it without "Enter to send" and "↑ recall").
 */
export function composerPlaceholder({ streaming, activeSessionId, backendTitle }: { streaming: boolean; activeSessionId: string | null; backendTitle: string }): string {
  if (streaming) return "Queue a follow-up…  (sends after the current turn)";
  if (activeSessionId) return "Send a message…  (Enter to send · !cmd asks the agent to run it · #note asks it to remember · ↑ recall)";
  return `Start a new ${backendTitle} session…`;
}

export function matchSlashCommands(
  input: string,
  serverCommands: { name: string; description?: string | null }[],
  serverSkills: string[],
  hidden: ReadonlySet<string> = new Set(),
): SlashEntry[] {
  const q = input.slice(1).toLowerCase();
  const space = q.indexOf(" ");
  const prefix = space === -1 ? q : q.slice(0, space);
  const panelNames = new Set(PANEL_COMMANDS.map((c) => c.name));
  const entries: SlashEntry[] = [
    ...PANEL_COMMANDS.map((c) => ({ name: c.name, desc: c.desc, group: "Panel" as const })),
    ...serverCommands
      .filter((c) => !panelNames.has(c.name))
      .map((c) => ({ name: c.name, desc: c.description || "Claude Code command", group: "Session" as const })),
    ...serverSkills.map((s) => ({ name: s, desc: "Skill", group: "Skills" as const })),
  ];
  return entries.filter((c) => !hidden.has(c.name) && c.name.toLowerCase().startsWith(prefix)).slice(0, 30);
}

// ↑ recalls history when the draft is empty, or still equals the entry the
// last ↑ put there (so repeated presses walk further back). An edited draft
// never gets clobbered.
export function canRecallOlder(input: string, historyIdx: number, history: readonly string[]): boolean {
  if (history.length === 0 || historyIdx >= history.length - 1) return false;
  if (input === "") return true;
  return historyIdx >= 0 && input === history[historyIdx];
}
