/**
 * Markdown renderer with streaming tolerance + syntax highlighting.
 *
 * - Variable-length fences (3+ backticks); closing must match opening length.
 * - Placeholder substitution handles fences embedded mid-line, not just
 *   placeholder-IS-line.
 * - Sentinel uses Unicode Private Use Area characters ( / ) so
 *   the sentinel cannot collide with arbitrary input text.
 * - attachCodeBlockCopyHandlers wires copy + wrap-toggle idempotently.
 */
import { highlightCode } from "./highlight";

interface CodeBlock {
  lang: string;
  code: string;
  complete: boolean;
}

const SENTINEL_OPEN = "";
const SENTINEL_CLOSE = "";
const SENTINEL_RE = /(\d+)/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeUrl(url: string): string {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : "";
}

// Inline-code sentinels (separate from fenced-code sentinels above so they
// can't collide). Extract inline-code spans BEFORE running bold/italic/link
// regexes -- otherwise `**hello**` inside backticks would get `<strong>` tags
// injected inside the `<code>` tag, breaking the visual contract and producing
// invalid HTML.
const IC_SENTINEL_OPEN = "";
const IC_SENTINEL_CLOSE = "";
const IC_SENTINEL_RE = new RegExp(`${IC_SENTINEL_OPEN}(\\d+)${IC_SENTINEL_CLOSE}`, "g");

// Link sentinels (U+E005/U+E006). Links are lifted out BEFORE the dialogue-quote
// passes: those used to run over the already-built `href="…"` attribute, so a
// URL containing `&quot;`, curly quotes or a backtick pair got a <span>/<code>
// injected inside the attribute and the anchor broke.
const LK_SENTINEL_OPEN = "";
const LK_SENTINEL_CLOSE = "";
const LK_SENTINEL_RE = new RegExp(`${LK_SENTINEL_OPEN}(\\d+)${LK_SENTINEL_CLOSE}`, "g");

function emphasisAndDialogue(s: string): string {
  return s
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/“(.*?)”/g, "<span class='dlg'>“$1”</span>")
    .replace(/&quot;(.*?)&quot;/g, '<span class="dlg">&quot;$1&quot;</span>');
}

function inlineFormat(s: string): string {
  const inlineCodeSpans: string[] = [];
  // Step 1: pull out inline-code spans into sentinel placeholders.
  const withSentinels = s.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodeSpans.push(code);
    return `${IC_SENTINEL_OPEN}${inlineCodeSpans.length - 1}${IC_SENTINEL_CLOSE}`;
  });
  // Step 2: lift links out too. The href is used verbatim (already HTML-escaped
  // by the caller, so `"` is `&quot;` and cannot terminate the attribute); the
  // link text still gets emphasis/dialogue formatting on its own.
  const links: string[] = [];
  const withLinkSentinels = withSentinels.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) => {
    // A backtick pair inside the URL was lifted to an inline-code sentinel in
    // step 1; put the bare characters back so no <code> lands in the href.
    const plainUrl = url.replace(IC_SENTINEL_RE, (__, idx: string) => inlineCodeSpans[Number(idx)] ?? "");
    links.push(`<a href="${safeUrl(plainUrl)}" target="_blank" rel="noopener">${emphasisAndDialogue(text)}</a>`);
    return `${LK_SENTINEL_OPEN}${links.length - 1}${LK_SENTINEL_CLOSE}`;
  });
  // Step 3: apply the remaining inline transforms on the sentinel-bearing text.
  const formatted = emphasisAndDialogue(withLinkSentinels);
  // Step 4: restore links, then inline-code spans (a link text may hold code).
  return formatted
    .replace(LK_SENTINEL_RE, (_, idx: string) => links[Number(idx)] ?? "")
    .replace(IC_SENTINEL_RE, (_, idx: string) => {
      const code = inlineCodeSpans[Number(idx)] ?? "";
      return `<code class="ic">${code}</code>`;
    });
}

function placeholder(idx: number): string {
  return `${SENTINEL_OPEN}${idx}${SENTINEL_CLOSE}`;
}

// GFM tables. Detection is deliberately strict — a header row only becomes a
// table when the NEXT line is a well-formed delimiter row (`---|:--:|--`) with
// a matching column count, so prose containing stray pipes can never
// false-positive. Escaped pipes (\|) are protected with a PUA sentinel
// (U+E004, distinct from the fence/inline-code sentinels above).
const EP_SENTINEL = "";
const EP_SENTINEL_RE = new RegExp(EP_SENTINEL, "g");

function hasUnescapedPipe(line: string): boolean {
  return line.replace(/\\\|/g, "").includes("|");
}

function splitTableRow(line: string): string[] {
  const safe = line.replace(/\\\|/g, EP_SENTINEL);
  let cells = safe.split("|").map((c) => c.trim());
  if (cells.length && cells[0] === "") cells = cells.slice(1);
  if (cells.length && cells[cells.length - 1] === "") cells = cells.slice(0, -1);
  return cells.map((c) => c.replace(EP_SENTINEL_RE, "|"));
}

function isTableDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  if (!/^[\s|:-]+$/.test(t)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function tableAlignAttr(delim: string): string {
  const left = delim.startsWith(":");
  const right = delim.endsWith(":");
  if (left && right) return ' class="md-ac"';
  if (right) return ' class="md-ar"';
  if (left) return ' class="md-al"';
  return "";
}

/**
 * Scan text and replace each fenced code block with a N sentinel.
 * Fences must start at the beginning of a line and have >= 3 backticks.
 * Closing fence must have AT LEAST as many backticks as the opening fence.
 * Unclosed fences at end-of-text are rendered as streaming code blocks.
 */
function extractCodeBlocks(text: string): { processed: string; blocks: CodeBlock[] } {
  const blocks: CodeBlock[] = [];
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const atLineStart = i === 0 || text[i - 1] === "\n";
    if (atLineStart && text[i] === "`") {
      let fenceLen = 0;
      while (i + fenceLen < n && text[i + fenceLen] === "`") fenceLen++;
      if (fenceLen >= 3) {
        let langEnd = i + fenceLen;
        while (langEnd < n && text[langEnd] !== "\n") langEnd++;
        const lang = text.slice(i + fenceLen, langEnd).trim();
        const contentStart = langEnd < n ? langEnd + 1 : n;
        let scan = contentStart;
        let closed = false;
        let closeStart = -1;
        let closeLen = 0;
        while (scan < n) {
          const closingCandidate = (scan === contentStart || text[scan - 1] === "\n") && text[scan] === "`";
          if (closingCandidate) {
            let cl = 0;
            while (scan + cl < n && text[scan + cl] === "`") cl++;
            if (cl >= fenceLen) {
              let after = scan + cl;
              while (after < n && (text[after] === " " || text[after] === "\t")) after++;
              if (after >= n || text[after] === "\n") {
                closed = true;
                closeStart = scan;
                closeLen = cl;
                break;
              }
            }
          }
          scan++;
        }

        if (closed) {
          const code = text.slice(contentStart, closeStart).replace(/\n$/, "");
          blocks.push({ lang, code, complete: true });
          out += placeholder(blocks.length - 1);
          let after = closeStart + closeLen;
          while (after < n && (text[after] === " " || text[after] === "\t")) after++;
          if (after < n && text[after] === "\n") after++;
          if (out[out.length - 1] !== "\n") out += "\n";
          i = after;
          continue;
        } else {
          const code = text.slice(contentStart);
          blocks.push({ lang, code, complete: false });
          out += placeholder(blocks.length - 1);
          i = n;
          break;
        }
      }
    }
    out += text[i]!;
    i++;
  }

  return { processed: out, blocks };
}

function renderCodeBlock(cb: CodeBlock): string {
  const lang = cb.lang || "text";
  const highlighted = highlightCode(cb.code, lang);
  const streamingMarker = cb.complete ? "" : " ···";
  return `<div class="cb-wrap"><div class="cb-header"><span class="cb-lang">${escapeHtml(lang)}${streamingMarker}</span><div class="cb-actions"><button class="cb-wrap-toggle" data-wrap="off" title="Toggle wrap">↵</button><button class="cb-copy" title="Copy">Copy</button></div></div><pre><code>${highlighted}</code></pre></div>`;
}

// Render memo. Callers (SessionConversation, the ClaudeCode/Codex timelines)
// call renderMarkdown inline in JSX for every message on every render, and a
// streaming reply re-renders per delta — so every historical message used to be
// re-parsed (and re-highlighted) per keystroke. Keyed by the exact source text:
// a streaming tail misses once per delta while every settled message hits.
// Bounded by entry count AND total source chars so a long transcript of big
// tool outputs can't pin unbounded memory.
const RENDER_CACHE_MAX_ENTRIES = 400;
const RENDER_CACHE_MAX_CHARS = 8_000_000;
const renderCache = new Map<string, string>();
let renderCacheChars = 0;

function rememberRender(text: string, html: string) {
  if (text.length > RENDER_CACHE_MAX_CHARS / 4) return; // never let one message evict everything
  renderCache.set(text, html);
  renderCacheChars += text.length;
  while (renderCache.size > RENDER_CACHE_MAX_ENTRIES || renderCacheChars > RENDER_CACHE_MAX_CHARS) {
    const oldest = renderCache.keys().next().value;
    if (oldest === undefined) break;
    renderCache.delete(oldest);
    renderCacheChars -= oldest.length;
  }
}

export function renderMarkdown(text: string): string {
  if (!text) return "";
  const cached = renderCache.get(text);
  if (cached !== undefined) {
    // Refresh recency so the Map's insertion order doubles as an LRU.
    renderCache.delete(text);
    renderCache.set(text, cached);
    return cached;
  }
  const html = renderMarkdownUncached(text);
  rememberRender(text, html);
  return html;
}

/** Test hook: drop the memo so a spec can measure the uncached path. */
export function clearRenderMarkdownCache() {
  renderCache.clear();
  renderCacheChars = 0;
}

function renderMarkdownUncached(text: string): string {
  const { processed, blocks } = extractCodeBlocks(text);
  const lines = processed.split("\n");
  let html = "";
  let inList = false;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (inList) { html += listType === "ul" ? "</ul>" : "</ol>"; inList = false; listType = null; }
  };

  const hasSentinel = (line: string) => line.includes(SENTINEL_OPEN);

  const renderMixedLine = (line: string): string | null => {
    if (!hasSentinel(line)) return null;
    const re = new RegExp(SENTINEL_RE.source, SENTINEL_RE.flags);
    const matches = [...line.matchAll(re)];
    if (matches.length === 0) return null;
    if (matches.length === 1 && matches[0]![0] === line) {
      const cb = blocks[+matches[0]![1]!];
      return cb ? renderCodeBlock(cb) : "";
    }
    let cursor = 0;
    let out = "";
    for (const m of matches) {
      const start = m.index!;
      const end = start + m[0].length;
      if (start > cursor) {
        const prefix = line.slice(cursor, start);
        if (prefix.trim()) out += `<p>${inlineFormat(escapeHtml(prefix))}</p>`;
      }
      const cb = blocks[+m[1]!];
      if (cb) out += renderCodeBlock(cb);
      cursor = end;
    }
    if (cursor < line.length) {
      const suffix = line.slice(cursor);
      if (suffix.trim()) out += `<p>${inlineFormat(escapeHtml(suffix))}</p>`;
    }
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (hasSentinel(line)) {
      const mixed = renderMixedLine(line);
      if (mixed != null) { closeList(); html += mixed; continue; }
    }

    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = line.match(/^(#+)/)![1]!.length;
      html += `<h${level}>${inlineFormat(escapeHtml(line.replace(/^#+\s*/, "")))}</h${level}>`;
      continue;
    }

    if (/^>\s/.test(line)) {
      closeList();
      let bq = inlineFormat(escapeHtml(line.replace(/^>\s*/, "")));
      while (i + 1 < lines.length && /^>\s/.test(lines[i + 1]!)) {
        i++;
        bq += "<br>" + inlineFormat(escapeHtml(lines[i]!.replace(/^>\s*/, "")));
      }
      html += `<blockquote>${bq}</blockquote>`;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      closeList();
      html += "<hr>";
      continue;
    }

    const ulMatch = line.match(/^(\s*)[-*]\s+(.*)/);
    if (ulMatch) {
      if (!inList || listType !== "ul") { closeList(); html += "<ul>"; inList = true; listType = "ul"; }
      html += `<li>${inlineFormat(escapeHtml(ulMatch[2]!))}</li>`;
      continue;
    }

    // CommonMark: a marker is at most nine digits, and the list starts at the
    // first item's number. The number used to be discarded, so a sentence
    // opening with a year ("2026. That was…") rendered as "1. That was…" and a
    // list written 3., 4. showed 1., 2.
    const olMatch = line.match(/^(\s*)(\d{1,9})\.\s+(.*)/);
    if (olMatch) {
      if (!inList || listType !== "ol") {
        closeList();
        const start = Number(olMatch[2]);
        html += start === 1 ? "<ol>" : `<ol start="${start}">`;
        inList = true; listType = "ol";
      }
      html += `<li>${inlineFormat(escapeHtml(olMatch[3]!))}</li>`;
      continue;
    }

    if (
      line.trim() !== "" &&
      hasUnescapedPipe(line) &&
      i + 1 < lines.length &&
      isTableDelimiterRow(lines[i + 1]!) &&
      !hasSentinel(line)
    ) {
      const headerCells = splitTableRow(line);
      const delimCells = splitTableRow(lines[i + 1]!);
      if (headerCells.length > 0 && delimCells.length === headerCells.length) {
        closeList();
        const aligns = delimCells.map(tableAlignAttr);
        let j = i + 2;
        const bodyRows: string[][] = [];
        while (j < lines.length) {
          const bl = lines[j]!;
          if (bl.trim() === "" || !hasUnescapedPipe(bl) || hasSentinel(bl)) break;
          bodyRows.push(splitTableRow(bl));
          j++;
        }
        let table = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        headerCells.forEach((c, k) => { table += `<th${aligns[k] ?? ""}>${inlineFormat(escapeHtml(c))}</th>`; });
        table += "</tr></thead>";
        if (bodyRows.length) {
          table += "<tbody>";
          for (const row of bodyRows) {
            table += "<tr>";
            for (let k = 0; k < headerCells.length; k++) {
              table += `<td${aligns[k] ?? ""}>${inlineFormat(escapeHtml(row[k] ?? ""))}</td>`;
            }
            table += "</tr>";
          }
          table += "</tbody>";
        }
        table += "</table></div>";
        html += table;
        i = j - 1;
        continue;
      }
    }

    closeList();

    if (line.trim() === "") html += "<br>";
    else html += `<p>${inlineFormat(escapeHtml(line))}</p>`;
  }

  closeList();
  return html;
}

/**
 * Attach copy-button + wrap-toggle click handlers within a container.
 * Call after mounting/updating markdown content. Idempotent.
 */
export function attachCodeBlockCopyHandlers(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>(".cb-copy").forEach((btn) => {
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";
    btn.onclick = () => {
      const code = btn.closest(".cb-wrap")?.querySelector("code")?.textContent ?? "";
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      }).catch(() => {
        // Insecure context / denied permission: say so instead of an unhandled
        // rejection in the console.
        btn.textContent = "Copy failed";
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      });
    };
  });
  container.querySelectorAll<HTMLButtonElement>(".cb-wrap-toggle").forEach((btn) => {
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";
    btn.onclick = () => {
      const pre = btn.closest(".cb-wrap")?.querySelector("pre");
      if (!pre) return;
      const wrap = btn.dataset.wrap === "on";
      btn.dataset.wrap = wrap ? "off" : "on";
      pre.classList.toggle("cb-wrap-on", !wrap);
    };
  });
}
