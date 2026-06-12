import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ClaudeCodeEffort, ClaudeCodeFile, ClaudeCodeFsTreeEntry, ClaudeCodeMode } from "@tracyhill-rp/contracts";

import {
  getClaudeCodeFsTree,
  sendClaudeCodePrompt,
  uploadClaudeCodeFile,
} from "./claudeCodeApi";

type ComposerProps = {
  activeSessionId: string | null;
  streaming: boolean;
  onSent: (queryKey: string, newSessionId: string | null, prompt: string) => void;
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
  onResearchBashToggle: (on: boolean) => void;
};

const MODELS: { id: string; label: string }[] = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

const EFFORTS: ClaudeCodeEffort[] = ["low", "medium", "high", "xhigh", "max"];

// The binary mode the UI exposes. Any legacy reported mode collapses to one of
// these two for the toggle's active state.
function binaryOf(mode: string | undefined): "research" | "execute" {
  return mode === "research" || mode === "plan" ? "research" : "execute";
}

export function Composer(props: ComposerProps) {
  const {
    activeSessionId, streaming, onSent, onQueued, onInterrupt, onSlashCommand,
    model, effort, mode, researchBash, currentMode, serverCommands, serverSkills, suggestions,
    onModelChange, onEffortChange, onModeToggle, onResearchBashToggle,
  } = props;

  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<ClaudeCodeFile[]>([]);
  const [fileDrag, setFileDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [escArmed, setEscArmed] = useState(false);
  const historyRef = useRef<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const uploadMutation = useMutation({ mutationFn: uploadClaudeCodeFile });
  const sendMutation = useMutation({ mutationFn: sendClaudeCodePrompt });

  const activeBinary = binaryOf(streaming ? currentMode ?? mode : mode);

  // Slash popup (allowed even while streaming now that the composer stays live)
  const slashOpen = input.startsWith("/") && !input.includes("\n");
  const [slashSelection, setSlashSelection] = useState(0);

  // @ mention popup
  const [atPopup, setAtPopup] = useState<{ prefix: string; start: number } | null>(null);
  const [atEntries, setAtEntries] = useState<ClaudeCodeFsTreeEntry[]>([]);
  const [atSelection, setAtSelection] = useState(0);
  // Empty = let the agent service default to its own cwd for the first listing.
  const [atBrowsePath, setAtBrowsePath] = useState<string>("");

  useEffect(() => { setHistoryIdx(-1); }, [activeSessionId]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = 20 * 20;
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [input]);

  // Shift+Tab toggles the binary mode (skip while a popup is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey && !slashOpen && !atPopup) {
        e.preventDefault();
        onModeToggle(activeBinary === "research" ? "execute" : "research");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeBinary, onModeToggle, slashOpen, atPopup]);

  const commands = useMemo(() => (slashOpen ? matchSlashCommands(input, serverCommands, serverSkills) : []), [input, slashOpen, serverCommands, serverSkills]);

  const onFileAdd = useCallback(async (selected: FileList | null) => {
    if (!selected?.length) return;
    setError(null);
    const next: ClaudeCodeFile[] = [];
    for (const f of Array.from(selected)) {
      try {
        const uploaded = await uploadMutation.mutateAsync({ name: f.name, data: arrayBufferToBase64(await f.arrayBuffer()) });
        next.push({ name: f.name, path: uploaded.path, kind: f.type.startsWith("image/") ? "image" : "file", size: f.size });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    }
    setFiles((c) => [...c, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [uploadMutation]);

  const send = useCallback(async () => {
    if (!input.trim() && files.length === 0) return;
    // Panel slash command dispatch (client-side commands only). Anything else
    // starting with "/" is passed THROUGH to the SDK as a prompt.
    if (input.startsWith("/")) {
      const raw = input.trim();
      const space = raw.indexOf(" ");
      const command = (space === -1 ? raw : raw.slice(0, space)).slice(1);
      const args = space === -1 ? "" : raw.slice(space + 1);
      if (PANEL_HANDLERS.has(command)) {
        onSlashCommand(command, args);
        setInput("");
        return;
      }
      // else: fall through — send the slash command to the SDK as a prompt.
    }
    let prompt = input.trim();
    // ! and # prefixes (col 0): bash passthrough / memory note.
    if (prompt.startsWith("!")) prompt = prompt.slice(1).trim();
    else if (prompt.startsWith("#")) prompt = `Remember this in project memory: ${prompt.slice(1).trim()}`;
    const finalPrompt = prompt || "See attached files.";
    historyRef.current = [input.trim(), ...historyRef.current].slice(0, 50);
    setHistoryIdx(-1);
    setError(null);
    try {
      const response = await sendMutation.mutateAsync({
        prompt: finalPrompt,
        sessionId: activeSessionId,
        files: files.length ? files : undefined,
        model: model || undefined,
        effort: effort || undefined,
        mode: mode || undefined,
        researchBash,
      });
      setInput("");
      setFiles([]);
      // While streaming, the message was queued into the live session — the open
      // stream delivers it; do NOT reconnect (that would replay & duplicate).
      if (streaming) onQueued(finalPrompt);
      else onSent(response.queryKey, activeSessionId, finalPrompt);
      void queryClient.invalidateQueries({ queryKey: ["claude-code-sessions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    }
  }, [input, files, streaming, activeSessionId, model, effort, mode, researchBash, sendMutation, onSent, onQueued, onSlashCommand, queryClient]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (e.key === "ArrowUp" && input === "" && !slashOpen && !atPopup && historyRef.current.length > 0) {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, historyRef.current.length - 1);
      setHistoryIdx(next);
      setInput(historyRef.current[next]!);
      return;
    }
    if (e.key === "ArrowDown" && historyIdx >= 0 && !atPopup) {
      e.preventDefault();
      const next = historyIdx - 1;
      setHistoryIdx(next);
      setInput(next < 0 ? "" : historyRef.current[next]!);
      return;
    }
  };

  useEffect(() => {
    if (!textareaRef.current) return;
    const pos = textareaRef.current.selectionStart ?? input.length;
    const before = input.slice(0, pos);
    const match = before.match(/@(\S*)$/);
    if (!match) { setAtPopup(null); setAtEntries([]); return; }
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
    void getClaudeCodeFsTree(browse).then((res) => {
      const filter = prefix.startsWith("/") ? prefix.slice(prefix.lastIndexOf("/") + 1) : prefix;
      const filtered = res.entries.filter((e) => e.name.toLowerCase().startsWith(filter.toLowerCase())).slice(0, 20);
      setAtEntries(filtered);
    }).catch(() => setAtEntries([]));
  }, [input, atBrowsePath]);

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
    if (list.length) await onFileAdd(list as unknown as FileList);
  };

  const useSuggestion = (s: string) => { setInput(s); textareaRef.current?.focus(); };

  return (
    <div
      className={`ccp-composer ${fileDrag ? "is-file-drag" : ""} ${streaming ? "is-streaming" : ""}`}
      onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes("Files")) setFileDrag(true); }}
      onDragLeave={() => setFileDrag(false)}
      onDrop={(e) => { e.preventDefault(); setFileDrag(false); void onFileAdd(e.dataTransfer.files); }}
    >
      {error ? <div className="ccp-composer-error">{error}</div> : null}
      {suggestions.length && !streaming ? (
        <div className="ccp-suggest-row">
          {suggestions.map((s, i) => (
            <button key={i} type="button" className="ccp-suggest-chip" onClick={() => useSuggestion(s)}>{s}</button>
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="ccp-composer-chips">
          {files.map((f, i) => (
            <span key={i} className="ccp-file-chip">
              {f.kind === "image" ? "🖼" : "📄"} {f.name}
              <button type="button" onClick={() => setFiles((c) => c.filter((_, j) => j !== i))}>✕</button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="ccp-composer-row">
        <button type="button" className="ccp-composer-attach" title="Attach files" onClick={() => fileInputRef.current?.click()}>📎</button>
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
            placeholder={streaming ? "Queue a follow-up…  (sends after the current turn)" : activeSessionId ? "Send a message…  (Enter to send, ! bash, # memory, ↑ recall)" : "Start a new Claude Code session…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
                  className={`ccp-slash-row ${i === slashSelection ? "is-sel" : ""} ${cmd.disabled ? "is-disabled" : ""}`}
                  onClick={() => {
                    if (cmd.disabled) return;
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
                  <span>{entry.kind === "dir" ? "📁" : "📄"}</span>
                  <span>{entry.name}</span>
                  <span className="ccp-at-kind">{entry.kind}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="ccp-composer-controls">
          <div className="ccp-mode-toggle" title="Shift+Tab to toggle">
            <button type="button" className={`ccp-mode-opt ${activeBinary === "research" ? "is-active" : ""}`} onClick={() => onModeToggle("research")}>🔎 Research</button>
            <button type="button" className={`ccp-mode-opt ${activeBinary === "execute" ? "is-active" : ""}`} onClick={() => onModeToggle("execute")}>⚡ Execute</button>
          </div>
          {activeBinary === "research" ? (
            <label className="ccp-shell-check" title="Allow shell (Bash) in Research mode — still read-only by convention">
              <input type="checkbox" checked={researchBash} onChange={(e) => onResearchBashToggle(e.target.checked)} /> shell
            </label>
          ) : null}
          <select value={model} onChange={(e) => onModelChange(e.target.value)} title="Model">
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <select value={effort} onChange={(e) => onEffortChange(e.target.value as ClaudeCodeEffort)} title="Effort">
            {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          {streaming ? (
            <>
              <button type="button" className="ccp-composer-send" onClick={() => void send()} disabled={sendMutation.isPending || (!input.trim() && files.length === 0)} title="Queue this for after the current turn">
                Queue ⏎
              </button>
              <button type="button" className="ccp-composer-stop" onClick={onInterrupt}>⏹ Stop</button>
            </>
          ) : (
            <button type="button" className="ccp-composer-send" onClick={() => void send()} disabled={sendMutation.isPending || (!input.trim() && files.length === 0)}>
              {sendMutation.isPending ? "…" : "Send"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Slash commands ──────────────────────────────────────────────────────────

type PanelCmd = { name: string; desc: string };
type SlashEntry = { name: string; desc: string; group: "Panel" | "Session" | "Skills"; disabled?: boolean };

// Panel commands run client-side in the page; everything else is passed through
// to the SDK as a prompt.
export const PANEL_COMMANDS: PanelCmd[] = [
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

export const PANEL_HANDLERS = new Set(PANEL_COMMANDS.map((c) => c.name));

function matchSlashCommands(input: string, serverCommands: { name: string; description?: string | null }[], serverSkills: string[]): SlashEntry[] {
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
  return entries.filter((c) => c.name.toLowerCase().startsWith(prefix)).slice(0, 30);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
