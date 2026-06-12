import { useEffect, useMemo, useRef } from "react";

import { renderMarkdown, attachCodeBlockCopyHandlers } from "../../../shared/markdown/renderMarkdown";

// ─── Markdown wrapper (with copy + wrap handlers) ────────────────────────────

export function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  useEffect(() => { if (ref.current) attachCodeBlockCopyHandlers(ref.current); }, [html]);
  return <div ref={ref} className="ccp-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ─── Incremental streaming renderer ──────────────────────────────────────────

/**
 * Find the split point after the LAST blank line that is outside any open
 * code fence. Everything before it is "stable" (only changes when a new
 * paragraph completes); the remainder is the live tail. In this renderer no
 * block construct survives a blank line (lists close, tables can't contain
 * blank lines), so the boundary is render-equivalent to a full parse.
 */
function findStableSplit(text: string): number {
  let fenceLen = 0;
  let split = 0;
  let pos = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^(`{3,})/);
    if (m) {
      if (fenceLen === 0) fenceLen = m[1]!.length;
      else if (m[1]!.length >= fenceLen) fenceLen = 0;
    }
    if (fenceLen === 0 && line.trim() === "" && i < lines.length - 1) {
      split = pos + line.length + 1;
    }
    pos += line.length + 1;
  }
  return split;
}

/**
 * Markdown for LIVE streaming text. The full document used to be re-parsed on
 * every delta; here the stable prefix is parsed once per completed paragraph
 * (useMemo) and only the trailing paragraph re-parses per frame. On
 * consolidation the block re-renders through <Markdown> for canonical output.
 */
export function StreamMarkdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const split = findStableSplit(text);
  // Drop the final newline of the boundary blank line — the stable chunk's own
  // trailing blank line renders the same <br> a full parse would produce.
  const stable = split > 0 ? text.slice(0, split - 1) : "";
  const tail = text.slice(split);
  const stableHtml = useMemo(() => renderMarkdown(stable), [stable]);
  useEffect(() => { if (ref.current) attachCodeBlockCopyHandlers(ref.current); }, [stableHtml]);
  return (
    <div ref={ref} className="ccp-markdown">
      {stable ? <div className="ccp-md-stable" dangerouslySetInnerHTML={{ __html: stableHtml }} /> : null}
      {tail ? <div className="ccp-md-tail" dangerouslySetInnerHTML={{ __html: renderMarkdown(tail) }} /> : null}
    </div>
  );
}
