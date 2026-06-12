import { useState } from "react";

import type { TaskItem } from "../useClaudeCodeStream";

// CLI-style task/todo strip fed by task_started/progress/updated/notification.

export function TaskPanel({ tasks }: { tasks: TaskItem[] }) {
  const [open, setOpen] = useState(() => localStorage.getItem("ccp-tasks-open") === "1");
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.find((t) => t.status === "running");
  const toggle = () => setOpen((o) => { localStorage.setItem("ccp-tasks-open", o ? "0" : "1"); return !o; });
  const dot = (status: string) =>
    status === "completed" ? "ccp-task-dot is-done"
    : status === "failed" || status === "stopped" ? "ccp-task-dot is-failed"
    : "ccp-task-dot is-running";
  const glyph = (status: string) => (status === "completed" ? "✓" : status === "failed" || status === "stopped" ? "✕" : "●");
  return (
    <div className={`ccp-task-panel ${open ? "is-open" : ""}`}>
      <button type="button" className="ccp-task-head" onClick={toggle}>
        <span className="ccp-task-caret">{open ? "▾" : "▸"}</span>
        <span className="ccp-task-summary">☑ {done}/{tasks.length} tasks{active?.description ? ` · ${active.description}` : ""}</span>
      </button>
      {open ? (
        <div className="ccp-task-list">
          {tasks.map((t) => (
            <div key={t.taskId} className="ccp-task-row">
              <span className={dot(t.status)}>{glyph(t.status)}</span>
              <span className="ccp-task-desc">{t.description || t.subagentType || t.taskId}</span>
              {t.subagentType ? <span className="ccp-task-agent">{t.subagentType}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
