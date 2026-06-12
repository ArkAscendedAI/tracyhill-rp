import { useEffect, useRef, useState } from "react";

import { getClaudeCodeContext } from "./claudeCodeApi";
import type { ClaudeCodeContext } from "./useClaudeCodeStream";

const CAT_COLOR: Record<string, string> = {
  system_prompt: "#bc8cff", system: "#bc8cff",
  tools: "#58a6ff", mcp: "#39c5cf", mcp_tools: "#39c5cf",
  memory: "#d29922", messages: "#3fb950", conversation: "#3fb950",
};

function colorFor(name: string, provided?: string): string {
  if (provided) return provided;
  const key = name.toLowerCase().replace(/\s+/g, "_");
  return CAT_COLOR[key] ?? "#8b949e";
}

// Segmented context meter à la the CLI /context grid. Driven by the streamed
// context_usage snapshot; refetches the live /context endpoint when opened.
export function ContextMeter({ sessionId, context }: { sessionId: string | null; context: ClaudeCodeContext | null }) {
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<ClaudeCodeContext | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const data = live ?? context;

  useEffect(() => { setLive(null); }, [sessionId]);
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    void getClaudeCodeContext(sessionId)
      .then((r) => { if (!cancelled) setLive({ totalTokens: r.totalTokens, maxTokens: r.maxTokens, percentage: r.percentage, model: r.model, categories: r.categories }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!data || !data.maxTokens) return null;
  const pct = data.percentage ?? (data.totalTokens / data.maxTokens) * 100;
  const kLabel = `${Math.round(data.totalTokens / 1000)}k/${Math.round(data.maxTokens / 1000)}k`;
  const cats = data.categories.filter((c) => c.tokens > 0);

  return (
    <div className="ccp-context-meter" ref={popRef}>
      <button type="button" className="ccp-context-bar-btn" onClick={() => setOpen((o) => !o)} title="Context usage">
        <span className="ccp-context-bar">
          {cats.map((c, i) => (
            <span key={i} className="ccp-context-seg" style={{ width: `${(c.tokens / data.maxTokens) * 100}%`, background: colorFor(c.name, c.color) }} />
          ))}
        </span>
        <span className="ccp-context-label">{kLabel}</span>
      </button>
      {open ? (
        <div className="ccp-context-popover">
          <div className="ccp-context-popover-head">Context · {pct.toFixed(1)}% of {Math.round(data.maxTokens / 1000)}k{data.model ? ` · ${data.model}` : ""}</div>
          {cats.map((c, i) => (
            <div key={i} className="ccp-context-popover-row">
              <span className="ccp-context-swatch" style={{ background: colorFor(c.name, c.color) }} />
              <span className="ccp-context-cat">{c.name}</span>
              <span className="ccp-context-tokens">{c.tokens.toLocaleString()}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
