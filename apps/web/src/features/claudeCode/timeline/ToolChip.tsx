import { useState } from "react";

import { rewindClaudeCodeSession } from "../claudeCodeApi";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import type { AssistantBlock } from "./turns";

// ─── Lossless output primitives ──────────────────────────────────────────────

/**
 * Never-lossy <pre>: shows a line-count-bounded preview with a "Show all"
 * expander that reveals the COMPLETE content (no scroll-trap max-height), plus
 * a copy button. `tail` previews the END of the content (terminal semantics).
 */
export function ExpandablePre({ text, previewLines = 12, tail = false, className = "ccp-tool-pre" }: { text: string; previewLines?: number; tail?: boolean; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = text.split("\n");
  const total = lines.length;
  // Small overshoot tolerance: expanding for 2 extra lines is just noise.
  const collapsible = total > previewLines + 4;
  const shown = expanded || !collapsible
    ? text
    : (tail ? lines.slice(total - previewLines) : lines.slice(0, previewLines)).join("\n");
  const kb = text.length >= 1024 ? ` · ${(text.length / 1024).toFixed(text.length > 10240 ? 0 : 1)} KB` : "";
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="ccp-expandable">
      {tail && collapsible && !expanded ? (
        <div className="ccp-expander-row">
          <button type="button" className="ccp-expander" onClick={() => setExpanded(true)}>⌃ Show all ({total} lines{kb})</button>
        </div>
      ) : null}
      <pre className={className}>{shown}</pre>
      <div className="ccp-expander-row">
        {collapsible && !tail ? (
          <button type="button" className="ccp-expander" onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Collapse" : `Show all (${total} lines${kb})`}
          </button>
        ) : null}
        {collapsible && tail && expanded ? (
          <button type="button" className="ccp-expander" onClick={() => setExpanded(false)}>Collapse</button>
        ) : null}
        <button type="button" className="ccp-expander" onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
        {collapsible && !expanded ? <span className="ccp-expander-meta">{tail ? `last ${previewLines}` : `first ${previewLines}`} of {total} lines</span> : null}
      </div>
    </div>
  );
}

/**
 * Heuristic: does this tool result read like prose/markdown (render it) rather
 * than structured output like JSON, logs, or listings (keep it monospace)?
 */
function isProse(s: string): boolean {
  const t = s.trim();
  if (!t || t.length < 40) return false;
  if (/^[{[]/.test(t)) {
    try { JSON.parse(t); return false; } catch { /* not JSON — keep checking */ }
  }
  const lines = t.split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  const wordy = lines.filter((l) => l.trim().split(/\s+/).length >= 4).length;
  return wordy / lines.length >= 0.5 && /[.!?:]/.test(t);
}

// ─── Tool icons ──────────────────────────────────────────────────────────────

function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n === "read") return "📖";
  if (n === "write") return "📝";
  if (n === "edit" || n === "multiedit") return "✏️";
  if (n === "bash" || n === "run") return "⚡";
  if (n === "grep" || n === "grep_search") return "🔎";
  if (n === "glob" || n === "find") return "🧭";
  if (n === "webfetch" || n === "webfetch_v2") return "🌐";
  if (n === "websearch") return "🔍";
  if (n === "task" || n === "agent") return "🤖";
  if (n === "todowrite" || n === "taskcreate") return "✅";
  return "🔧";
}

function toolLabel(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.file_path === "string") return truncateMid(o.file_path, 64);
    if (typeof o.path === "string") return truncateMid(o.path, 64);
    if (typeof o.command === "string") return o.command.length > 80 ? o.command.slice(0, 77) + "…" : o.command;
    if (typeof o.pattern === "string") return `"${o.pattern}"`;
    if (typeof o.url === "string") return o.url;
    if (typeof o.query === "string") return `"${o.query}"`;
    if (typeof o.prompt === "string") return (o.prompt as string).slice(0, 80);
  }
  return "";
}

function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}

// ─── Tool chip with expansion ────────────────────────────────────────────────

export function ToolChip({
  tool, input, id, result, streaming, elapsed, userMessageId, sessionId, childBlocks,
}: {
  tool: string;
  input: unknown;
  id: string;
  result?: string;
  streaming?: boolean;
  elapsed?: number;
  userMessageId?: string;
  sessionId?: string | null;
  childBlocks?: AssistantBlock[];
}) {
  const n = tool.toLowerCase();
  const isTask = n === "task" || n === "agent";
  // Subagent (Task) chips with nested activity default open so the work is visible.
  const [open, setOpen] = useState(isTask && (childBlocks?.length ?? 0) > 0);
  const status = streaming ? "running" : result !== undefined ? "done" : "pending";
  const statusClass = `is-${status}`;

  // Summary stats for Edit
  let extra = "";
  if (n === "edit" || n === "multiedit") {
    const o = (input as Record<string, unknown>) ?? {};
    const edits = Array.isArray(o.edits) ? o.edits : [{ old_string: o.old_string, new_string: o.new_string }];
    let adds = 0, dels = 0;
    for (const e of edits) {
      const oldS = String((e as Record<string, unknown>).old_string ?? "");
      const newS = String((e as Record<string, unknown>).new_string ?? "");
      adds += (newS.match(/\n/g)?.length ?? 0) + (newS ? 1 : 0);
      dels += (oldS.match(/\n/g)?.length ?? 0) + (oldS ? 1 : 0);
    }
    extra = `+${adds} −${dels}`;
  }
  if (isTask && childBlocks?.length) extra = `${childBlocks.filter((b) => b.kind === "tool").length} steps`;

  return (
    <div className={`ccp-tool-chip ${statusClass} ${open ? "is-open" : ""}`}>
      <button type="button" className="ccp-tool-chip-head" onClick={() => setOpen((o) => !o)}>
        <span className="ccp-tool-icon">{toolIcon(tool)}</span>
        <span className="ccp-tool-name">{tool}</span>
        <span className="ccp-tool-label">{toolLabel(tool, input)}</span>
        {extra ? <span className="ccp-tool-extra">{extra}</span> : null}
        <span className="ccp-tool-spacer" />
        {elapsed != null ? <span className="ccp-tool-elapsed">{elapsed.toFixed(1)}s</span> : null}
        <span className={`ccp-tool-dot ${statusClass}`} />
      </button>
      {open ? (
        <>
          <ToolExpansion tool={tool} input={input} result={result} streaming={streaming} userMessageId={userMessageId} sessionId={sessionId} />
          {childBlocks?.length ? (
            <div className="ccp-subagent">
              {childBlocks.map((b, i) => {
                if (b.kind === "thinking") return <ThinkingBlock key={i} content={b.content} />;
                if (b.kind === "text") return <Markdown key={i} text={b.content} />;
                if (b.kind === "tool") return <ToolChip key={b.id || i} tool={b.tool} input={b.input} id={b.id} result={b.result} elapsed={b.elapsed} childBlocks={b.children} />;
                return null;
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ToolExpansion({ tool, input, result, streaming, userMessageId, sessionId }: { tool: string; input: unknown; result?: string; streaming?: boolean; userMessageId?: string; sessionId?: string | null }) {
  const n = tool.toLowerCase();
  if (n === "bash" || n === "run") return <BashExpansion input={input} result={result} streaming={streaming} />;
  if (n === "edit" || n === "multiedit" || n === "write") return <EditExpansion input={input} result={result} userMessageId={userMessageId} sessionId={sessionId} />;
  if (n === "read") return <ReadExpansion input={input} result={result} />;
  if (n === "grep" || n === "glob") return <GrepGlobExpansion input={input} result={result} />;
  if (n === "task" || n === "agent") return <TaskExpansion input={input} result={result} />;
  // generic — prose-looking results render as markdown, structured stays mono
  return (
    <div className="ccp-tool-body">
      {input ? (
        <div className="ccp-tool-section">
          <div className="ccp-tool-section-label">Input</div>
          <ExpandablePre text={typeof input === "string" ? input : JSON.stringify(input, null, 2)} />
        </div>
      ) : null}
      {result !== undefined ? (
        <div className="ccp-tool-section">
          <div className="ccp-tool-section-label">Result</div>
          {result && isProse(result) ? <Markdown text={result} /> : <ExpandablePre text={result || "[empty]"} />}
        </div>
      ) : null}
    </div>
  );
}

function TaskExpansion({ input, result }: { input: unknown; result?: string }) {
  const o = (input as Record<string, unknown>) ?? {};
  const prompt = typeof o.prompt === "string" ? o.prompt : JSON.stringify(o, null, 2);
  return (
    <div className="ccp-tool-body">
      <div className="ccp-tool-section">
        <div className="ccp-tool-section-label">Task</div>
        <ExpandablePre text={prompt} previewLines={8} />
      </div>
      {result !== undefined ? (
        <div className="ccp-tool-section">
          <div className="ccp-tool-section-label">Report</div>
          {/* Subagent reports are prose — always render as markdown. */}
          <Markdown text={result || "[empty]"} />
        </div>
      ) : null}
    </div>
  );
}

function BashExpansion({ input, result, streaming }: { input: unknown; result?: string; streaming?: boolean }) {
  const cmd = (input as Record<string, unknown>)?.command ?? "";
  return (
    <div className="ccp-tool-body">
      <pre className="ccp-term-prompt">$ {String(cmd)}</pre>
      {streaming ? (
        // While running, the terminal stays fully visible and grows; the
        // bottom-anchored scroll system absorbs the growth.
        <pre className="ccp-term-body is-streaming">
          {result ?? ""}
          <span className="ccp-term-caret">▋</span>
        </pre>
      ) : (
        // Completed: tail preview (the end of terminal output matters most),
        // expandable to the COMPLETE output.
        <ExpandablePre text={result ?? ""} previewLines={20} tail className="ccp-term-body" />
      )}
    </div>
  );
}

function ReadExpansion({ input, result }: { input: unknown; result?: string }) {
  const path = (input as Record<string, unknown>)?.file_path ?? (input as Record<string, unknown>)?.path ?? "";
  const lines = (result ?? "").split("\n");
  return (
    <div className="ccp-tool-body">
      <div className="ccp-tool-path">{String(path)} · {lines.length} line{lines.length === 1 ? "" : "s"}</div>
      {result !== undefined ? <ExpandablePre text={result} previewLines={30} /> : null}
    </div>
  );
}

function EditExpansion({ input, result, userMessageId, sessionId }: { input: unknown; result?: string; userMessageId?: string; sessionId?: string | null }) {
  const o = (input as Record<string, unknown>) ?? {};
  const path = o.file_path ?? o.path ?? "";
  const edits = Array.isArray(o.edits) ? o.edits : [{ old_string: o.old_string, new_string: o.new_string }];
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const onRevert = async () => {
    if (!sessionId || !userMessageId) return;
    setReverting(true); setRevertError(null);
    try {
      const r = await rewindClaudeCodeSession(sessionId, { userMessageId });
      if (!r.canRewind) setRevertError(r.error || "Cannot rewind");
    } catch (e) { setRevertError(e instanceof Error ? e.message : "Rewind failed"); }
    setReverting(false);
  };
  return (
    <div className="ccp-tool-body">
      <div className="ccp-tool-path">
        <span>{String(path)}</span>
        {sessionId && userMessageId ? (
          <button type="button" className="ccp-revert-btn" disabled={reverting} onClick={() => void onRevert()} title="Rewind files to state before this user message">
            ↶ {reverting ? "Reverting…" : "Revert"}
          </button>
        ) : null}
      </div>
      {revertError ? <div className="ccp-revert-error">{revertError}</div> : null}
      {edits.map((e, i) => (
        <DiffView key={i} oldText={String((e as Record<string, unknown>).old_string ?? "")} newText={String((e as Record<string, unknown>).new_string ?? "")} />
      ))}
      {result ? (
        <div className="ccp-tool-section" style={{ marginTop: 8 }}>
          <div className="ccp-tool-section-label">Result</div>
          <ExpandablePre text={result} previewLines={8} />
        </div>
      ) : null}
    </div>
  );
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return (
    <pre className="ccp-diff">
      {oldLines.map((l, i) => <div key={`o-${i}`} className="ccp-diff-del">− {l}</div>)}
      {newLines.map((l, i) => <div key={`n-${i}`} className="ccp-diff-add">+ {l}</div>)}
    </pre>
  );
}

function GrepGlobExpansion({ input, result }: { input: unknown; result?: string }) {
  const o = (input as Record<string, unknown>) ?? {};
  return (
    <div className="ccp-tool-body">
      <div className="ccp-tool-section">
        <div className="ccp-tool-section-label">Query</div>
        <pre className="ccp-tool-pre">{JSON.stringify(o, null, 2)}</pre>
      </div>
      {result !== undefined ? (
        <div className="ccp-tool-section">
          <div className="ccp-tool-section-label">Results</div>
          <ExpandablePre text={result || "[no matches]"} previewLines={20} />
        </div>
      ) : null}
    </div>
  );
}
