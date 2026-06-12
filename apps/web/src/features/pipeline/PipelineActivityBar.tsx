import { useEffect, useMemo, useState } from "react";

import type { ActivePipelineRun } from "@tracyhill-rp/contracts";

import { formatPipelineStatus } from "./pipelineUtils";
import { PipelineReviewDrawer } from "./PipelineReviewDrawer";
import { usePipelineActions } from "./usePipelineActions";
import { usePipelineStream } from "./usePipelineStream";

const STEP_LABELS = {
  analysis: "Analysis", lorebookRefresh: "Lorebook", syspromptUpdate: "Sysprompt",
} as const;

const SNOOZE_KEY = "pipeline-snoozed-runs-v1";

function loadSnoozed(): Set<string> {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}

function saveSnoozed(set: Set<string>) {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(Array.from(set))); } catch {}
}

export function PipelineActivityBar({ runs }: { runs: ActivePipelineRun[] }) {
  const actions = usePipelineActions();
  const [drawerEntry, setDrawerEntry] = useState<ActivePipelineRun | null>(null);
  const [snoozed, setSnoozed] = useState<Set<string>>(() => loadSnoozed());
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("pipeline-bar-collapsed") === "1");

  const toggleSnooze = (runId: string) => {
    setSnoozed((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId); else next.add(runId);
      saveSnoozed(next);
      return next;
    });
  };

  const toggleCollapsed = () => {
    setCollapsed((v) => { localStorage.setItem("pipeline-bar-collapsed", v ? "0" : "1"); return !v; });
  };

  const { running, reviewable, snoozedCount } = useMemo(() => {
    const running: ActivePipelineRun[] = [];
    const reviewable: ActivePipelineRun[] = [];
    let snoozedCount = 0;
    for (const entry of runs) {
      if (snoozed.has(entry.run.id)) { snoozedCount += 1; continue; }
      if (entry.run.status === "queued" || entry.run.status === "running") running.push(entry);
      else if (entry.run.status === "completed" && !entry.run.approvedAt) reviewable.push(entry);
    }
    running.sort((a, b) => (b.run.updatedAt || "").localeCompare(a.run.updatedAt || ""));
    reviewable.sort((a, b) => (b.run.updatedAt || "").localeCompare(a.run.updatedAt || ""));
    return { running, reviewable, snoozedCount };
  }, [runs, snoozed]);

  // Prune snoozed ids that no longer correspond to an active run — the
  // localStorage set used to grow forever.
  useEffect(() => {
    if (!runs.length || !snoozed.size) return;
    const activeIds = new Set(runs.map((entry) => entry.run.id));
    const live = [...snoozed].filter((id) => activeIds.has(id));
    if (live.length !== snoozed.size) {
      const next = new Set(live);
      setSnoozed(next);
      try { localStorage.setItem(SNOOZE_KEY, JSON.stringify([...next])); } catch { /* quota */ }
    }
  }, [runs, snoozed]);

  if (running.length === 0 && reviewable.length === 0 && snoozedCount === 0) return null;

  return (
    <>
      <section className={`pipeline-bar${collapsed ? " is-collapsed" : ""}`}>
        <div className="pipeline-bar-head">
          <div className="pipeline-bar-title">
            {running.length > 0 ? <span className="pipeline-spinner" aria-hidden="true" /> : null}
            <span className="eyebrow">Pipeline</span>
            {running.length > 0 ? <span className="pipeline-bar-chip is-running">{running.length} running</span> : null}
            {reviewable.length > 0 ? <span className="pipeline-bar-chip is-ready">{reviewable.length} ready to review</span> : null}
            {snoozedCount > 0 ? (
              <button
                type="button"
                className="pipeline-bar-chip"
                title="Show hidden runs again"
                onClick={() => { setSnoozed(new Set()); try { localStorage.setItem(SNOOZE_KEY, "[]"); } catch { /* quota */ } }}
              >
                {snoozedCount} hidden — show
              </button>
            ) : null}
          </div>
          <button type="button" className="ghost-button" onClick={toggleCollapsed} title={collapsed ? "Expand" : "Collapse"}>
            {collapsed ? "▸" : "▾"}
          </button>
        </div>
        {actions.lastError ? (
          <div className="pipeline-bar-error" role="alert" onClick={actions.clearError}>
            ⚠ {actions.lastError}
          </div>
        ) : null}
        {!collapsed ? (
          <div className="pipeline-bar-body">
            {running.map((entry) => (
              <RunningCard key={entry.run.id} entry={entry} actions={actions} onOpenReview={() => setDrawerEntry(entry)} />
            ))}
            {reviewable.map((entry) => (
              <ReviewableCard
                key={entry.run.id}
                entry={entry}
                actions={actions}
                onOpenReview={() => setDrawerEntry(entry)}
                onSnooze={() => toggleSnooze(entry.run.id)}
              />
            ))}
          </div>
        ) : null}
      </section>
      <PipelineReviewDrawer
        // Re-sync against the POLLED runs so the drawer transitions when a run
        // finishes while being watched — the click-time snapshot stayed
        // "running" forever and Approve/Retry/Abandon never appeared.
        entry={drawerEntry ? (runs.find((r) => r.run.id === drawerEntry.run.id) ?? drawerEntry) : null}
        onClose={() => setDrawerEntry(null)}
        actions={actions}
      />
    </>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function useElapsedSince(start: string | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!start) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [start]);
  if (!start) return null;
  return formatElapsed(Date.now() - new Date(start).getTime());
}

function RunningCard({ entry, actions, onOpenReview }: { entry: ActivePipelineRun; actions: ReturnType<typeof usePipelineActions>; onOpenReview: () => void }) {
  const { run, campaignName, campaignId } = entry;
  const stream = usePipelineStream(run.id);
  const startAnchor = run.startedAt ?? run.requestedAt;
  const elapsed = useElapsedSince(startAnchor);
  const steps = [
    { key: "analysis" as const, label: "Analysis", status: run.steps.analysis?.status ?? "pending" },
    { key: "lorebookRefresh" as const, label: "Lorebook", status: run.steps.lorebookRefresh?.status ?? "pending" },
    { key: "syspromptUpdate" as const, label: "Sysprompt", status: run.steps.syspromptUpdate?.status ?? "pending" },
  ];

  // Live preview: the tail of the currently-streaming step's text
  const liveStep = stream.currentStep;
  const liveTail = liveStep ? stream.steps[liveStep].text.slice(-140).replace(/\s+/g, " ").trim() : "";
  const fallbackLine = (() => {
    const currentIdx = steps.findIndex((s) => s.status === "running" || s.status === "pending");
    const current = currentIdx >= 0 ? steps[currentIdx]! : steps[steps.length - 1]!;
    if (currentIdx > 0 && steps[currentIdx - 1]?.status === "completed") {
      const prev = run.steps[steps[currentIdx - 1]!.key]?.result?.split("\n").find((l) => l.trim())?.slice(0, 120);
      if (prev) return prev;
    }
    return `${current.label}…`;
  })();
  const previewLine = liveTail || fallbackLine;
  const previewLabel = liveStep ? STEP_LABELS[liveStep] : "Now";

  return (
    <article className="pipeline-card is-running">
      <div className="pipeline-card-row">
        <strong>{campaignName}</strong>
        <span className="pipeline-card-status">
          <span className="pipeline-spinner" aria-hidden="true" />
          {formatPipelineStatus(run.status)}
        </span>
      </div>
      <p className="muted small-copy pipeline-card-timing">
        Started {new Date(startAnchor).toLocaleTimeString()}
        {elapsed ? <> · <span className="pipeline-card-elapsed">{elapsed}</span> elapsed</> : null}
      </p>
      <div className="pipeline-progress-steps">
        {steps.map((step, i) => (
          <div key={step.key} className={`pipeline-step is-${step.status}`}>
            <span className="pipeline-step-dot" aria-hidden="true" />
            <span>{step.label}</span>
            {i < steps.length - 1 ? (
              <span className={`pipeline-step-connector${step.status === "completed" ? " is-filled" : ""}`} aria-hidden="true" />
            ) : null}
          </div>
        ))}
      </div>
      <div className="pipeline-card-preview">
        <span className="pipeline-card-preview-label">{previewLabel}:</span>
        <span className="pipeline-card-preview-text">{previewLine || "warming up…"}</span>
      </div>
      <div className="pipeline-card-actions">
        <button type="button" className="secondary-button" onClick={onOpenReview}>Open Review</button>
        <button
          type="button"
          className="danger-button"
          disabled={actions.busy}
          onClick={() => actions.cancel.mutate({ campaignId, runId: run.id })}
        >
          Cancel Run
        </button>
      </div>
    </article>
  );
}

function ReviewableCard({ entry, actions, onOpenReview, onSnooze }: {
  entry: ActivePipelineRun;
  actions: ReturnType<typeof usePipelineActions>;
  onOpenReview: () => void;
  onSnooze: () => void;
}) {
  const { run, campaignName, campaignId } = entry;
  return (
    <article className="pipeline-card is-ready">
      <div className="pipeline-card-row">
        <strong>{campaignName}</strong>
        <span className="pipeline-card-status is-ready">
          ✓ Ready to review
        </span>
      </div>
      <p className="muted small-copy">
        Completed {new Date(run.completedAt ?? run.updatedAt).toLocaleString()}
      </p>
      {run.summary ? <p className="pipeline-card-summary">{run.summary}</p> : null}
      <div className="pipeline-card-actions">
        <button
          type="button"
          onClick={() => actions.approve.mutate({ campaignId, runId: run.id, startSession: true })}
          disabled={actions.busy}
          title="Approve and start a new session"
        >
          ✓ Approve + Start Session
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => actions.approve.mutate({ campaignId, runId: run.id, startSession: false })}
          disabled={actions.busy}
        >
          Approve Only
        </button>
        <button type="button" className="secondary-button" onClick={onOpenReview}>
          Open Review
        </button>
        <button type="button" className="secondary-button" onClick={() => actions.retry.mutate({ campaignId, runId: run.id })} disabled={actions.busy}>
          Retry
        </button>
        <button type="button" className="danger-button" onClick={() => actions.abandon.mutate({ campaignId, runId: run.id })} disabled={actions.busy}>
          Abandon
        </button>
        <button type="button" className="ghost-button" onClick={onSnooze} title="Hide this run from the bar (use the hidden-runs chip to bring it back)">
          Snooze
        </button>
      </div>
    </article>
  );
}
