import { useMemo } from "react";

import { collapseContext, lineDiff } from "./lineDiff";

// Unified line diff: unchanged lines are context, folded into
// "⋯ N unchanged lines" beyond three lines around each change; deletions
// and additions keep the `ccp-diff-del` / `ccp-diff-add` rows the ClaudeCode
// timeline, the lorebook history, the drives audit and the campaign version
// history all share. Before this the component emitted every old line as a
// deletion and every new line as an addition — a one-line edit in a 500-line
// prompt showed 1,000 changed lines.
export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const { rows, exact } = useMemo(() => {
    const diff = lineDiff(oldText, newText);
    return { rows: collapseContext(diff.lines, 3), exact: diff.exact };
  }, [oldText, newText]);
  return (
    <pre className="ccp-diff">
      {exact ? null : <div className="ccp-diff-skip">⋯ too large to match line by line — showing the old text as removed and the new text as added</div>}
      {rows.map((row, i) => {
        if (row.kind === "skip") return <div key={i} className="ccp-diff-skip">⋯ {row.count} unchanged {row.count === 1 ? "line" : "lines"}</div>;
        if (row.kind === "del") return <div key={i} className="ccp-diff-del">− {row.text}</div>;
        if (row.kind === "add") return <div key={i} className="ccp-diff-add">+ {row.text}</div>;
        return <div key={i}>{"  "}{row.text}</div>;
      })}
    </pre>
  );
}
