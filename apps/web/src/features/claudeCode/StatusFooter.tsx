import { useMemo } from "react";

import type { ClaudeCodeEffort } from "@tracyhill-rp/contracts";

import type { ClaudeCodeStreamState } from "./useClaudeCodeStream";
import { Icon } from "../../shared/ui/Icon";

// CLI-style bottom status bar: model · permission mode (shift+tab to cycle) ·
// context-left % · cwd · live cost · ? shortcuts. No banners — purely informational.

export function StatusFooter({ state, model, effort, mode, onCycleMode, onShortcuts, connHealth }: {
  state: ClaudeCodeStreamState;
  model: string;
  // The effort the next send carries (always a value the backend honours).
  effort: ClaudeCodeEffort;
  mode: "research" | "execute";
  onCycleMode: () => void;
  onShortcuts: () => void;
  connHealth: ClaudeCodeStreamState["connHealth"];
}) {
  const servedModel = state.sessionMeta?.model;
  const ctx = state.context;
  const ctxLeft = ctx && ctx.maxTokens > 0
    ? Math.max(0, Math.round(100 - (ctx.percentage ?? (ctx.totalTokens / ctx.maxTokens) * 100)))
    : null;
  const cost = useMemo(() => {
    const last = [...state.messages].reverse().find((m) => m.type === "result");
    return typeof last?.cost === "number" ? last.cost : null;
  }, [state.messages]);

  return (
    <footer className="ccp-statusbar">
      <span className="ccp-status-item" title="Model">{servedModel ?? model}</span>
      <span className="ccp-status-sep">·</span>
      <span className="ccp-status-item" title="Effort for the next send">{effort}</span>
      <span className="ccp-status-sep">·</span>
      <button
        type="button"
        className={`ccp-status-mode ccp-mode-${mode}`}
        onClick={onCycleMode}
        title="Shift+Tab to cycle permission mode"
      >
        {mode === "research" ? <><Icon name="search" size={12} /> research</> : <><Icon name="zap" size={12} /> execute</>} <span className="ccp-status-hint">⇧⇥</span>
      </button>
      {ctxLeft != null ? (
        <>
          <span className="ccp-status-sep">·</span>
          <span className="ccp-status-item" title={`${Math.round((ctx!.totalTokens) / 1000)}k / ${Math.round((ctx!.maxTokens) / 1000)}k tokens`}>
            {ctxLeft}% ctx left
          </span>
        </>
      ) : null}
      {cost != null ? (
        <>
          <span className="ccp-status-sep">·</span>
          <span className="ccp-status-item" title="Session cost">${cost.toFixed(4)}</span>
        </>
      ) : null}
      <span className="ccp-status-sep">·</span>
      <span className="ccp-status-item ccp-status-cwd" title={state.sessionMeta?.cwd ?? undefined}>{state.sessionMeta?.cwd ?? "~"}</span>

      <span className="ccp-status-spacer" />

      {connHealth ? (
        <span className={`ccp-status-conn is-${connHealth}`}>{connHealth === "reconnecting" ? "reconnecting…" : connHealth === "offline" ? "offline" : "stale"}</span>
      ) : null}
      <button type="button" className="ccp-status-shortcuts" onClick={onShortcuts} title="Keyboard shortcuts">? shortcuts</button>
    </footer>
  );
}
