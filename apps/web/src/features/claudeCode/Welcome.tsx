import { useCodingBackend } from "./backend";
import { Icon } from "../../shared/ui/Icon";

// CLI-style welcome / intro box, echoing the real Claude Code startup banner.
// Shown when a session opens with no transcript yet. Branded per backend —
// the Kimi panel shares this tree.

export function Welcome({ model, mode, cwd }: { model: string; mode: "research" | "execute"; cwd?: string }) {
  const { title } = useCodingBackend();
  return (
    <div className="ccp-welcome">
      <div className="ccp-welcome-box">
        <div className="ccp-welcome-logo"><Icon name="sparkles" size={16} /> {title}</div>
        <div className="ccp-welcome-meta">
          <div><span className="ccp-welcome-key">cwd</span> {cwd ?? "~"}</div>
          <div><span className="ccp-welcome-key">model</span> {model}</div>
          <div><span className="ccp-welcome-key">mode</span> {mode === "research" ? <><Icon name="search" size={13} /> Research & Planning (read-only)</> : <><Icon name="zap" size={13} /> Full Execution</>}</div>
        </div>
        <div className="ccp-welcome-tip">
          Type <code>/</code> for commands, <code>@</code> to reference a file, or just ask. <code>Shift+Tab</code> cycles the permission mode.
        </div>
      </div>
    </div>
  );
}
