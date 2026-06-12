/**
 * Lightweight syntax highlighter. No dependencies. ~2kb.
 * Supports: ts/js/tsx/jsx, py, sh/bash, json, diff, md.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Pattern = { type: string; re: RegExp };

const LANG_PATTERNS: Record<string, Pattern[]> = {
  typescript: [
    { type: "comment", re: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g },
    { type: "string", re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.|\$\{[^}]*\})*`)/g },
    { type: "keyword", re: /\b(const|let|var|function|class|interface|type|enum|export|import|from|as|return|if|else|for|while|do|switch|case|break|continue|default|try|catch|finally|throw|new|this|super|extends|implements|public|private|protected|static|readonly|async|await|yield|void|null|undefined|true|false|typeof|keyof|in|of|instanceof)\b/g },
    { type: "number", re: /\b(0x[\da-fA-F]+|\d+\.?\d*([eE][+-]?\d+)?)\b/g },
  ],
  python: [
    { type: "comment", re: /(#[^\n]*)/g },
    { type: "string", re: /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g },
    { type: "keyword", re: /\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|lambda|pass|yield|global|nonlocal|True|False|None|and|or|not|in|is|async|await)\b/g },
    { type: "number", re: /\b(0x[\da-fA-F]+|\d+\.?\d*([eE][+-]?\d+)?)\b/g },
  ],
  shell: [
    { type: "comment", re: /(#[^\n]*)/g },
    { type: "string", re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g },
    { type: "keyword", re: /\b(if|then|else|elif|fi|for|do|done|while|case|esac|function|in|break|continue|return|export|local|source|declare|readonly|echo|printf)\b/g },
    { type: "number", re: /\b(\d+)\b/g },
  ],
  json: [
    { type: "string", re: /("(?:[^"\\]|\\.)*")\s*:/g },
    { type: "value-string", re: /("(?:[^"\\]|\\.)*")/g },
    { type: "keyword", re: /\b(true|false|null)\b/g },
    { type: "number", re: /-?\b(\d+\.?\d*([eE][+-]?\d+)?)\b/g },
  ],
};

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "typescript", jsx: "typescript", javascript: "typescript",
  py: "python",
  sh: "shell", bash: "shell", zsh: "shell",
};

export function highlightCode(code: string, lang: string): string {
  const normalized = LANG_ALIASES[lang.toLowerCase()] || lang.toLowerCase();
  if (normalized === "diff") return highlightDiff(code);
  if (normalized === "md" || normalized === "markdown") return escapeHtml(code);
  const patterns = LANG_PATTERNS[normalized];
  if (!patterns) return escapeHtml(code);
  return applyPatterns(code, patterns);
}

function applyPatterns(code: string, patterns: Pattern[]): string {
  type Span = { start: number; end: number; type: string };
  const spans: Span[] = [];
  const overlaps = (s: Span) => spans.some((x) => (s.start >= x.start && s.start < x.end) || (s.end > x.start && s.end <= x.end) || (s.start <= x.start && s.end >= x.end));
  for (const { type, re } of patterns) {
    const r = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(code)) !== null) {
      const span = { start: m.index, end: m.index + m[0].length, type };
      if (!overlaps(span)) spans.push(span);
      if (m[0].length === 0) r.lastIndex++;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    out += escapeHtml(code.slice(cursor, s.start));
    out += `<span class="tok-${s.type}">${escapeHtml(code.slice(s.start, s.end))}</span>`;
    cursor = s.end;
  }
  out += escapeHtml(code.slice(cursor));
  return out;
}

function highlightDiff(code: string): string {
  return code.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      return `<span class="tok-diff-meta">${escapeHtml(line)}</span>`;
    }
    if (line.startsWith("+")) return `<span class="tok-diff-add">${escapeHtml(line)}</span>`;
    if (line.startsWith("-")) return `<span class="tok-diff-del">${escapeHtml(line)}</span>`;
    return escapeHtml(line);
  }).join("\n");
}
