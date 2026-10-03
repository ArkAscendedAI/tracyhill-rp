// Line-level diff for the shared DiffView. The previous "diff"
// listed every old line as a deletion and every new line as an addition, so a
// one-line edit in a 500-line campaign prompt showed 1,000 changed lines.
// Longest-common-subsequence on lines after trimming the common prefix and
// suffix; inputs whose middle exceeds `maxCells` (N×M) fall back to the old
// replace-all rendering rather than allocating an unbounded table.

export type DiffLine = { kind: "same" | "del" | "add"; text: string };
export type DiffRow = DiffLine | { kind: "skip"; count: number };

const DEFAULT_MAX_CELLS = 4_000_000;

export function lineDiff(oldText: string, newText: string, options?: { maxCells?: number }): { lines: DiffLine[]; exact: boolean } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const lines: DiffLine[] = a.slice(0, prefix).map((text) => ({ kind: "same" as const, text }));
  let exact = true;
  if (midA.length * midB.length > (options?.maxCells ?? DEFAULT_MAX_CELLS)) {
    exact = false;
    for (const text of midA) lines.push({ kind: "del", text });
    for (const text of midB) lines.push({ kind: "add", text });
  } else {
    lines.push(...lcsDiff(midA, midB));
  }
  for (const text of a.slice(a.length - suffix)) lines.push({ kind: "same", text });
  return { lines, exact };
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: "add" as const, text }));
  if (m === 0) return a.map((text) => ({ kind: "del" as const, text }));
  // table[i][j] = LCS length of a[i..] and b[j..]
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i]! }); i += 1; j += 1; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { out.push({ kind: "del", text: a[i]! }); i += 1; }
    else { out.push({ kind: "add", text: b[j]! }); j += 1; }
  }
  while (i < n) { out.push({ kind: "del", text: a[i]! }); i += 1; }
  while (j < m) { out.push({ kind: "add", text: b[j]! }); j += 1; }
  return out;
}

/** Keep `context` unchanged lines around each change and fold longer
 * unchanged runs into a `skip` row (unified-diff style hunks). */
export function collapseContext(lines: DiffLine[], context = 3): DiffRow[] {
  const rows: DiffRow[] = [];
  let run: DiffLine[] = [];
  const flushRun = (atEnd: boolean, atStart: boolean) => {
    const keepHead = atStart ? 0 : context;
    const keepTail = atEnd ? 0 : context;
    if (run.length <= keepHead + keepTail + 1) { rows.push(...run); }
    else {
      rows.push(...run.slice(0, keepHead));
      rows.push({ kind: "skip", count: run.length - keepHead - keepTail });
      if (keepTail) rows.push(...run.slice(run.length - keepTail));
    }
    run = [];
  };
  let seenChange = false;
  for (const line of lines) {
    if (line.kind === "same") { run.push(line); continue; }
    if (run.length) flushRun(false, !seenChange);
    seenChange = true;
    rows.push(line);
  }
  if (run.length) flushRun(true, !seenChange);
  return rows;
}
