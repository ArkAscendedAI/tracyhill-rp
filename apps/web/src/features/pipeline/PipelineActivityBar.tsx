import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ActivePipelineRun } from "@tracyhill-rp/contracts";

import { getPipelineRuns } from "./pipelineApi";
import { CancelRefusal, CancelRunDialog } from "./CancelRun";
import { cancelTargetOf, countActiveRuns, formatPipelineKind, formatPipelineStatus, isRunLive, resolveDrawerRun } from "./pipelineUtils";
import { PipelineReviewDrawer, useElapsedSince } from "./PipelineReviewDrawer";
import { usePipelineActions } from "./usePipelineActions";
import { QueryError } from "../../shared/ui/QueryError";
import { Icon } from "../../shared/ui/Icon";

// Live cards only (queued and running). `/api/pipeline/active` returns
// queued/running rows, so the "ready to review" bucket, ReviewableCard and the
// localStorage snooze set could never populate — removed 2026-09-02.
export function PipelineActivityBar({ runs }: { runs: ActivePipelineRun[] }) {
  const actions = usePipelineActions();
  const [drawerEntry, setDrawerEntry] = useState<ActivePipelineRun | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("pipeline-bar-collapsed") === "1");

  const toggleCollapsed = () => {
    setCollapsed((v) => { localStorage.setItem("pipeline-bar-collapsed", v ? "0" : "1"); return !v; });
  };

  const active = useMemo(
    () => [...runs].sort((a, b) => (b.run.updatedAt || "").localeCompare(a.run.updatedAt || "")),
    [runs],
  );
  // Queued rows are not running: the chip used to say "N running" for every
  // active row (and for campaigns, since /active carries one row each) while
  // the card beneath read "Queued".
  const counts = countActiveRuns(active);

  // While the drawer is open, poll the campaign history so the watched run's
  // OWN status drives the drawer (Cancel while queued/running, the final row
  // once terminal). Leaving `/active` is not completion — it lists one row per
  // campaign, so a sibling job of the same campaign hides the watched run
  // from it. The run-specific key cannot reuse an empty campaign
  // history fetched before this run existed; polling stops at a terminal row.
  const watchedRunId = drawerEntry?.run.id ?? "";
  const watchedRuns = useQuery({
    queryKey: ["pipeline-runs", drawerEntry?.campaignId ?? "", watchedRunId, "watch"],
    // Only the watched run's own row decides the drawer, so ask for that row alone (2026-09-30).
    queryFn: () => getPipelineRuns(drawerEntry!.campaignId, { runId: watchedRunId }),
    enabled: drawerEntry != null,
    refetchInterval: (query) => {
      const own = query.state.data?.runs.find((r) => r.id === watchedRunId);
      return !own || isRunLive(own.status) ? 3_000 : false;
    },
  });
  const drawer = resolveDrawerRun(drawerEntry, runs, watchedRuns.data?.runs);
  useEffect(() => {
    if (drawerEntry && drawer.phase === "missing") setDrawerEntry(null);
  }, [drawerEntry, drawer.phase]);

  // A refused cancel keeps the bar: the run it named has usually just ended, so nothing else may be live.
  if (active.length === 0 && !drawerEntry && !actions.lastError && !actions.pendingCancel) return null;

  return (
    <>
      {active.length > 0 ? (
        <section className={`pipeline-bar${collapsed ? " is-collapsed" : ""}`}>
          <div className="pipeline-bar-head">
            <div className="pipeline-bar-title">
              {counts.running > 0 ? <span className="pipeline-spinner" aria-hidden="true" /> : null}
              <span className="eyebrow">Pipeline</span>
              {counts.running > 0 ? <span className="pipeline-bar-chip is-running">{counts.running} running</span> : null}
              {counts.queued > 0 ? <span className="pipeline-bar-chip is-queued">{counts.queued} queued</span> : null}
            </div>
            <button type="button" className="ghost-button" onClick={toggleCollapsed} title={collapsed ? "Expand" : "Collapse"}>
              <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={13} />
            </button>
          </div>
          {actions.lastError ? <CancelRefusal message={actions.lastError} onDismiss={actions.clearError} /> : null}
          {!collapsed ? (
            <div className="pipeline-bar-body">
              {active.map((entry) => (
                <RunningCard key={entry.run.id} entry={entry} actions={actions} onOpenReview={() => setDrawerEntry(entry)} />
              ))}
            </div>
          ) : null}
        </section>
      ) : actions.lastError ? (
        <section className="pipeline-bar is-refusal-only">
          <CancelRefusal message={actions.lastError} onDismiss={actions.clearError} />
        </section>
      ) : null}
      <PipelineReviewDrawer
        entry={drawer.entry}
        phase={drawer.phase}
        onClose={() => setDrawerEntry(null)}
        actions={actions}
        refreshError={drawerEntry ? <QueryError query={watchedRuns} label="Unable to load the run's current state" /> : null}
      />
      <CancelRunDialog target={actions.pendingCancel} busy={actions.busy} onConfirm={actions.confirmCancel} onKeep={actions.keepRunning} />
    </>
  );
}

// One card per live row. The run row carries its `kind` (contract, additive
// 2026-09-02); the `/queue-status` join this used to poll for it every 5 s
// per card is gone.
function RunningCard({ entry, actions, onOpenReview }: { entry: ActivePipelineRun; actions: ReturnType<typeof usePipelineActions>; onOpenReview: () => void }) {
  const { run, campaignName } = entry;
  const startAnchor = run.startedAt ?? run.requestedAt;
  const elapsed = useElapsedSince(startAnchor);
  const kindLabel = formatPipelineKind(run.kind);
  const isRunning = run.status === "running";

  return (
    <article className={`pipeline-card is-${run.status}`}>
      <div className="pipeline-card-row">
        <strong>{campaignName}</strong>
        <span className="pipeline-card-status">
          {isRunning ? <span className="pipeline-spinner" aria-hidden="true" /> : null}
          {formatPipelineStatus(run.status)}
        </span>
      </div>
      <p className="muted small-copy pipeline-card-timing">
        Started {new Date(startAnchor).toLocaleTimeString()}
        {elapsed ? <> · <span className="pipeline-card-elapsed">{elapsed}</span> elapsed</> : null}
      </p>
      {/* Real status + kind, not the retired Analysis→Lorebook→Sysprompt
          step strip that never advanced for any live kind. */}
      <div className="pipeline-card-preview">
        <span className="pipeline-card-preview-label">{kindLabel ?? "Job"}:</span>
        <span className="pipeline-card-preview-text">{run.summary || (run.status === "queued" ? "waiting for a worker slot…" : "in progress…")}</span>
      </div>
      <div className="pipeline-card-actions">
        <button type="button" className="secondary-button" onClick={onOpenReview}>Open Details</button>
        <button
          type="button"
          className="danger-button"
          disabled={actions.busy}
          onClick={() => actions.requestCancel(cancelTargetOf(entry))}
        >
          Cancel Run
        </button>
      </div>
    </article>
  );
}
