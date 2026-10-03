import { useState } from "react";

import type { IconName } from "../../../shared/ui/iconSprite";
import { Icon } from "../../../shared/ui/Icon";

// In-place todo checklist (replaces the raw-JSON TodoWrite dump / the old
// "77/86 wall"): collapsible, height-clamped with internal scroll, summary
// header. In-progress lists default open; completed lists collapse to the line.

type TodoStatus = "pending" | "in_progress" | "completed";
type TodoItem = { content: string; status: TodoStatus };

const GLYPH: Record<TodoStatus, IconName> = { pending: "circle", in_progress: "half", completed: "check-circle" };

function parseTodos(input: unknown): TodoItem[] {
  const o = input as Record<string, unknown> | undefined;
  const raw = o && Array.isArray(o.todos) ? o.todos : [];
  return raw
    .map((t) => {
      const r = (t ?? {}) as Record<string, unknown>;
      const status = String(r.status ?? "pending");
      const ok = status === "pending" || status === "in_progress" || status === "completed";
      return { content: String(r.content ?? r.activeForm ?? ""), status: (ok ? status : "pending") as TodoStatus };
    })
    .filter((t) => t.content);
}

// TaskCreate is not a todo list: its input is {subject, description,
// activeForm?, metadata?} with no `todos`, so it rendered as an empty
// checklist. It renders as a task chip instead (ToolChip).
export function isTodoTool(tool: string): boolean {
  const n = tool.toLowerCase();
  return n === "todowrite" || n === "todo_write";
}

export function Todos({ input }: { input: unknown }) {
  const items = parseTodos(input);
  const total = items.length;
  const done = items.filter((t) => t.status === "completed").length;
  const current = items.find((t) => t.status === "in_progress");
  const allDone = total > 0 && done === total;
  const [open, setOpen] = useState(!allDone);
  if (!total) return null;
  const summary = allDone
    ? `all ${total} done`
    : `${done}/${total} done${current ? ` · ${current.content}` : ""}`;
  return (
    <div className={`ccp-todos ${open ? "is-open" : ""}`}>
      <button type="button" className="ccp-todos-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="ccp-todos-caret"><Icon name={open ? "chevron-down" : "chevron-right"} size={12} /></span>
        <span className="ccp-todos-title">Todos</span>
        <span className="ccp-todos-summary">{summary}</span>
      </button>
      {open ? (
        <ul className="ccp-todos-list">
          {items.map((t, i) => (
            <li key={i} className={`ccp-todo ccp-todo-${t.status}`}>
              <span className="ccp-todo-glyph"><Icon name={GLYPH[t.status]} size={13} /></span>
              <span className="ccp-todo-text">{t.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
