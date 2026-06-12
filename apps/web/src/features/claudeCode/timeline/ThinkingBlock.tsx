import { useRef, useState } from "react";

import { Markdown, StreamMarkdown } from "./Markdown";

// ─── Thinking block (collapsible; auto-expanded while streaming) ─────────────

function thinkingSummary(content: string): { line: string; words: number } {
  const trimmed = content.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const first = content.split("\n").find((l) => l.trim()) ?? "";
  // Strip leading markdown furniture so the summary reads as a sentence.
  let line = first.replace(/^[#>*\-`_\s]+/, "").trim();
  if (line.length > 100) {
    const cut = line.lastIndexOf(" ", 100);
    line = line.slice(0, cut > 60 ? cut : 100) + "…";
  }
  return { line, words };
}

export function ThinkingBlock({ content, live, collapsedByDefault = true }: { content: string; live?: boolean; collapsedByDefault?: boolean }) {
  const [open, setOpen] = useState(!collapsedByDefault);
  // Lazy-mount the body on first open, then KEEP it mounted so the grid-rows
  // collapse animates and re-expanding is instant (Markdown memoizes parses).
  const everOpenedRef = useRef(false);
  if (!content) return null;
  // Live thinking streams expanded; when the block consolidates (live → false,
  // same component position) it falls back to the user's toggle state, so it
  // collapses automatically unless they explicitly opened it.
  const effectiveOpen = open || !!live;
  if (effectiveOpen) everOpenedRef.current = true;
  const { line, words } = thinkingSummary(content);
  return (
    <div className={`ccp-thinking ${effectiveOpen ? "is-open" : ""} ${live ? "is-live" : ""}`}>
      <button type="button" className="ccp-thinking-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="ccp-thinking-caret">{effectiveOpen ? "▾" : "▸"}</span>
        <span className="ccp-thinking-icon">🧠</span>
        <span className="ccp-thinking-summary">{live ? "Thinking…" : effectiveOpen ? "Reasoning" : line || "Reasoning"}</span>
        {!live ? <span className="ccp-thinking-words">{words} words</span> : null}
      </button>
      <div className="ccp-thinking-clip">
        <div className="ccp-thinking-inner">
          {everOpenedRef.current ? (
            <div className="ccp-thinking-body">
              {live ? <StreamMarkdown text={content} /> : <Markdown text={content} />}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
