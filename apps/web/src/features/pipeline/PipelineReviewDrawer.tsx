import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { ActivePipelineRun, PipelineRun } from "@tracyhill-rp/contracts";

import type { PipelineStreamStep } from "./pipelineApi";
import { PipelineContextModal } from "./PipelineContextModal";
import { PipelineReviewDetails } from "./PipelineReviewDetails";
import { formatPipelineStatus } from "./pipelineUtils";
import type { usePipelineActions } from "./usePipelineActions";
import { usePipelineStream } from "./usePipelineStream";

const STEP_LABELS: Record<PipelineStreamStep, string> = {
  analysis: "Deep Analysis",
  lorebookRefresh: "Lorebook Refresh",
  syspromptUpdate: "System Prompt Update",
};
const STEP_ORDER: PipelineStreamStep[] = ["analysis", "lorebookRefresh", "syspromptUpdate"];

type Actions = ReturnType<typeof usePipelineActions>;

export function PipelineReviewDrawer({
  entry, onClose, actions,
}: {
  entry: ActivePipelineRun | null;
  onClose: () => void;
  actions: Actions;
}) {
  const [contextOpen, setContextOpen] = useState(false);

  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      // The artifacts modal stacks above the drawer and registers its own
      // Escape handler — one keypress used to close BOTH.
      if (e.key === "Escape" && !contextOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose, contextOpen]);

  const run = entry?.run ?? null;
  const isRunning = run ? (run.status === "queued" || run.status === "running") : false;
  const stream = usePipelineStream(isRunning && run ? run.id : null);
  const queryClient = useQueryClient();

  // The stream computes runComplete/runError but nothing consumed them — wire
  // them to a refetch so the drawer (via the re-synced entry) transitions to
  // the reviewable state the moment the run finishes.
  useEffect(() => {
    if (stream.runComplete || stream.runError) {
      void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    }
  }, [stream.runComplete, stream.runError, queryClient]);

  if (!entry || !run) return null;

  const { campaignId, campaignName } = entry;
  const isReviewable = run.status === "completed" && !run.approvedAt;

  const onApprove = (startSession: boolean) =>
    actions.approve.mutate({ campaignId, runId: run.id, startSession }, { onSuccess: onClose });
  const onRetry = (fromStep?: "fromLorebookRefresh" | "fromSysprompt") =>
    actions.retry.mutate({ campaignId, runId: run.id, fromStep });
  const onAbandon = () =>
    actions.abandon.mutate({ campaignId, runId: run.id }, { onSuccess: onClose });
  const onCancel = () =>
    actions.cancel.mutate({ campaignId, runId: run.id });

  return (
    <div className="pipeline-drawer-backdrop" onClick={onClose}>
      <aside className="pipeline-drawer" onClick={(e) => e.stopPropagation()} aria-label="Pipeline review">
        <header className="pipeline-drawer-head">
          <div>
            <p className="eyebrow">Pipeline Review</p>
            <h3>{campaignName}</h3>
            <p className="muted small-copy">
              {formatPipelineStatus(run.status)}
              {run.approvedAt ? ` · Approved ${new Date(run.approvedAt).toLocaleString()}` : ""}
            </p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose} title="Close (Esc)">✕</button>
        </header>
        <div className="pipeline-drawer-body">
          {isRunning ? <LiveStreamPanels currentStep={stream.currentStep} steps={stream.steps} /> : null}
          {!isRunning ? <PipelineReviewDetails run={run} /> : null}
        </div>
        <footer className="pipeline-drawer-actions">
          {isRunning ? (
            <button type="button" className="danger-button" onClick={onCancel} disabled={actions.busy}>
              Cancel Run
            </button>
          ) : null}
          {isReviewable ? (
            <>
              <button type="button" onClick={() => onApprove(false)} disabled={actions.busy}>
                Approve Draft
              </button>
              <button type="button" className="secondary-button" onClick={() => onApprove(true)} disabled={actions.busy}>
                Approve + Start Session
              </button>
            </>
          ) : null}
          {(run.status === "completed" || run.status === "failed") && !run.approvedAt ? (
            <DrawerRetryButtons run={run} busy={actions.busy} onRetry={onRetry} />
          ) : null}
          {!run.approvedAt && !isRunning ? (
            <button type="button" className="danger-button" onClick={onAbandon} disabled={actions.busy}>
              Abandon
            </button>
          ) : null}
          <button type="button" className="ghost-button pipeline-context-button" onClick={() => setContextOpen(true)} title="View submitted context + raw LLM artifacts">
            View Context &amp; Artifacts
          </button>
        </footer>
      </aside>
      {contextOpen ? <PipelineContextModal runId={run.id} onClose={() => setContextOpen(false)} /> : null}
    </div>
  );
}

function LiveStreamPanels({
  currentStep, steps,
}: {
  currentStep: PipelineStreamStep | null;
  steps: Record<PipelineStreamStep, { status: string; text: string; thinking: string; error: string | null }>;
}) {
  const visibleSteps = STEP_ORDER.filter((step) => steps[step].status !== "idle" || step === currentStep);
  if (visibleSteps.length === 0) {
    return <p className="muted small-copy">Waiting for the pipeline to start…</p>;
  }
  return (
    <div className="stack stack-tight">
      {visibleSteps.map((step) => {
        const s = steps[step];
        const isActive = step === currentStep;
        return (
          <StreamPanel
            key={step}
            label={STEP_LABELS[step]}
            status={s.status}
            text={s.text}
            thinking={s.thinking}
            error={s.error}
            active={isActive}
          />
        );
      })}
    </div>
  );
}

function StreamPanel({ label, status, text, thinking, error, active }: { label: string; status: string; text: string; thinking: string; error: string | null; active: boolean }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const thinkingRef = useRef<HTMLPreElement | null>(null);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  useEffect(() => {
    if (active && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [text, active]);
  useEffect(() => {
    if (active && thinkingOpen && thinkingRef.current) thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight;
  }, [thinking, active, thinkingOpen]);
  const hasThinking = thinking.length > 0;
  const isThinkingOnly = hasThinking && text.length === 0 && status === "running";
  return (
    <div className={`pipeline-stream-panel is-${status}${active ? " is-active" : ""}`}>
      <div className="pipeline-stream-panel-head">
        <strong>{label}</strong>
        <span className="muted small-copy">
          {status === "running" ? <span className="pipeline-spinner" aria-hidden="true" /> : null}
          {" "}{isThinkingOnly ? "Thinking…" : formatStreamStatus(status)}
        </span>
      </div>
      {error ? <p className="error small-copy">{error}</p> : null}
      {hasThinking ? (
        <details className="pipeline-stream-thinking" open={thinkingOpen} onToggle={(e) => setThinkingOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="muted small-copy">Thinking ({thinking.length.toLocaleString()} chars)</summary>
          <pre ref={thinkingRef} className="pipeline-stream-panel-pre pipeline-stream-panel-pre-thinking">{thinking}</pre>
        </details>
      ) : null}
      <pre ref={preRef} className="pipeline-stream-panel-pre">{text || (status === "running" && !hasThinking ? "Reasoning…" : "")}</pre>
    </div>
  );
}

function DrawerRetryButtons({ run, busy, onRetry }: {
  run: PipelineRun;
  busy: boolean;
  onRetry: (fromStep?: "fromLorebookRefresh" | "fromSysprompt") => void;
}) {
  return (
    <>
      {run.review.analysisReport ? (
        <button type="button" className="secondary-button" onClick={() => onRetry("fromLorebookRefresh")} disabled={busy}>Retry from Lorebook</button>
      ) : null}
      {run.review.lorebookOperations ? (
        <button type="button" className="secondary-button" onClick={() => onRetry("fromSysprompt")} disabled={busy}>Retry from Sysprompt</button>
      ) : null}
      <button type="button" className="secondary-button" onClick={() => onRetry()} disabled={busy}>Retry Full Run</button>
    </>
  );
}

function formatStreamStatus(s: string) {
  if (s === "running") return "Streaming…";
  if (s === "completed") return "Complete";
  if (s === "failed") return "Failed";
  return s;
}
