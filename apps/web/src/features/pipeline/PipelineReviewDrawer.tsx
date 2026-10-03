import { useEffect, useState } from "react";

import type { ActivePipelineRun } from "@tracyhill-rp/contracts";

import { CancelRefusal } from "./CancelRun";
import { cancelTargetOf, formatElapsed, formatPipelineKind, formatPipelineStatus, type DrawerRunPhase } from "./pipelineUtils";
import type { usePipelineActions } from "./usePipelineActions";
import { Icon } from "../../shared/ui/Icon";

type Actions = ReturnType<typeof usePipelineActions>;

// Read-only run viewer fed by POLLED state (the campaign's run history decides
// the phase from the run's own status; `/active` is the fresher copy while it
// runs — see `resolveDrawerRun`). The
// live SSE panels ("Waiting for the pipeline to start…") and the retired
// step cards were removed 2026-09-02: the stream bus had
// no publishers and no live kind writes the campaign_review step slots. The
// "View Context & Artifacts" modal went the same day with the artifacts
// plumbing (the table has had no writer since 2026-07-10).
export function PipelineReviewDrawer({
  entry, phase, onClose, actions, refreshError,
}: {
  entry: ActivePipelineRun | null;
  phase: DrawerRunPhase;
  onClose: () => void;
  actions: Actions;
  refreshError?: React.ReactNode;
}) {
  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, onClose]);

  const run = entry?.run ?? null;
  const isActive = phase === "active";
  const elapsed = useElapsedSince(isActive ? (run?.startedAt ?? run?.requestedAt ?? null) : null);

  if (!entry || !run) return null;

  const { campaignName } = entry;
  // The run row carries its kind on both /active and the campaign history, so
  // a settled run keeps its label too.
  const kindLabel = formatPipelineKind(run.kind);
  // Asks first; the bar owns the confirmation.
  const onCancel = () => actions.requestCancel(cancelTargetOf(entry));
  const finishedMs = run.completedAt && run.startedAt ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime() : null;

  return (
    <div className="pipeline-drawer-backdrop" onClick={onClose}>
      <aside className="pipeline-drawer" onClick={(e) => e.stopPropagation()} aria-label="Pipeline run">
        <header className="pipeline-drawer-head">
          <div>
            <p className="eyebrow">Pipeline Run{kindLabel ? ` · ${kindLabel}` : ""}</p>
            <h3>{campaignName}</h3>
            <p className="muted small-copy">
              {isActive ? <span className="pipeline-spinner" aria-hidden="true" /> : null}
              {" "}{formatPipelineStatus(run.status)}
              {phase === "loading" ? " · fetching the run's current state…" : ""}
            </p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose} title="Close (Esc)"><Icon name="x" size={16} /></button>
        </header>
        <div className="pipeline-drawer-body stack stack-tight">
          {refreshError}
          {/* A refused cancel shows where it was pressed as well as in the bar under this drawer. */}
          {actions.lastError ? <CancelRefusal message={actions.lastError} onDismiss={actions.clearError} /> : null}
          <p className="muted small-copy pipeline-card-timing">
            Requested {new Date(run.requestedAt).toLocaleString()}
            {run.startedAt ? <> · started {new Date(run.startedAt).toLocaleTimeString()}</> : null}
            {elapsed ? <> · <span className="pipeline-card-elapsed">{elapsed}</span> elapsed</> : null}
            {run.completedAt ? <> · finished {new Date(run.completedAt).toLocaleTimeString()}{finishedMs != null ? ` (${formatElapsed(finishedMs)})` : ""}</> : null}
          </p>
          <p className="message-body">
            {run.summary || (isActive ? "The worker has not reported a summary yet — it lands when the run finishes." : "No summary was recorded for this run.")}
          </p>
          {run.error ? <p className="error">{run.error}</p> : null}
        </div>
        <footer className="pipeline-drawer-actions">
          {isActive ? (
            <button type="button" className="danger-button" onClick={onCancel} disabled={actions.busy}>
              Cancel Run
            </button>
          ) : null}
        </footer>
      </aside>
    </div>
  );
}

export function useElapsedSince(start: string | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!start) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [start]);
  if (!start) return null;
  return formatElapsed(Date.now() - new Date(start).getTime());
}
