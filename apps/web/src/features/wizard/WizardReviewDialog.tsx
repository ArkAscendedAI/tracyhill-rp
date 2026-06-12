import { useEffect, useMemo, useRef, useState } from "react";

import { CHAT_MODELS } from "@tracyhill-rp/model-catalog";
import type { ApproveWizardRunRequest, WizardRun, WizardRunStatus, LorebookCorpusEntry } from "@tracyhill-rp/contracts";

const STEP_KEYS = ["systemPrompt", "lorebookCorpus"] as const;
const STEP_LABELS: Record<string, string> = {
  systemPrompt: "System Prompt",
  lorebookCorpus: "Lorebook Corpus",
};

type WizardReviewDialogProps = {
  open: boolean;
  run: WizardRun | null;
  busy: boolean;
  onClose: () => void;
  onApprove: (runId: string, payload: ApproveWizardRunRequest) => void;
  onRetry: (runId: string) => void;
  onCancel: (runId: string) => void;
};

type ReviewDrafts = {
  campaignName: string;
  systemPromptDraft: string;
};

function createReviewDrafts(run: WizardRun | null): ReviewDrafts {
  return {
    campaignName: run?.review.campaignName ?? "",
    systemPromptDraft: run?.review.systemPromptDraft ?? run?.steps.systemPrompt.result ?? "",
  };
}

export function WizardReviewDialog({ open, run, busy, onClose, onApprove, onRetry, onCancel }: WizardReviewDialogProps) {
  const [tab, setTab] = useState<string>("lorebookCorpus");
  const [drafts, setDrafts] = useState<ReviewDrafts>(() => createReviewDrafts(run));
  const [elapsed, setElapsed] = useState("");
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!run) return;
    setDrafts((current) => {
      const next = { ...current };
      let changed = false;
      const incoming = createReviewDrafts(run);
      for (const [key, value] of Object.entries(incoming) as Array<[keyof ReviewDrafts, string]>) {
        if (!current[key]) {
          next[key] = value;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [
    run?.id,
    run?.review.campaignName,
    run?.review.systemPromptDraft,
    run?.steps.systemPrompt.result,
  ]);

  // Reset drafts only when reviewing a DIFFERENT run — resetting on every
  // reopen silently discarded hand-edits to the prompt/name when the user
  // closed the dialog to check something and came back.
  const lastRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    if (lastRunIdRef.current !== (run?.id ?? null)) {
      lastRunIdRef.current = run?.id ?? null;
      setTab("lorebookCorpus");
      setDrafts(createReviewDrafts(run));
    }
  }, [open, run?.id, run]);

  useEffect(() => {
    if (!open || !run?.startedAt) return;
    const updateElapsed = () => {
      const start = new Date(run.startedAt!).getTime();
      const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
      const seconds = Math.max(0, Math.floor((end - start) / 1000));
      setElapsed(`${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, "0")}s`);
    };
    updateElapsed();
    if (!run.completedAt) {
      intervalRef.current = window.setInterval(updateElapsed, 1000);
      return () => {
        if (intervalRef.current != null) window.clearInterval(intervalRef.current);
      };
    }
  }, [open, run?.startedAt, run?.completedAt]);

  const modelLabel = useMemo(
    () => CHAT_MODELS.find((entry) => entry.id === run?.modelId)?.label ?? run?.modelId ?? "Unknown model",
    [run?.modelId],
  );

  if (!open || !run) return null;

  const status = formatWizardStatus(run.status);
  const corpusEntries: LorebookCorpusEntry[] = run.review.lorebookCorpusDraft ?? [];
  const hasAnyResult = corpusEntries.length > 0 || Boolean(drafts.systemPromptDraft);
  const allComplete = run.steps.systemPrompt.status === "completed" && run.steps.lorebookCorpus.status === "completed";

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-card wizard-review-dialog" role="dialog" aria-modal="true" aria-label="Wizard Review">
        <div className="stack stack-tight">
          <div className="section-head">
            <div>
              <p className="eyebrow">Campaign Wizard</p>
              <h3>{drafts.campaignName || run.review.campaignName || "New Campaign"}</h3>
            </div>
            <button type="button" className="secondary-button" onClick={onClose}>Close</button>
          </div>

          <div className="wizard-review-meta">
            <span>Model: {modelLabel}</span>
            <span>Status: {status}</span>
            <span>Elapsed: {elapsed || "0m 00s"}</span>
          </div>

          <label className="stack stack-tight">
            <span className="muted small-copy">Campaign name</span>
            <input
              aria-label="Wizard review campaign name"
              value={drafts.campaignName}
              onChange={(event) => setDrafts((current) => ({ ...current, campaignName: event.target.value }))}
              disabled={run.approvedAt != null}
            />
          </label>

          <div className="wizard-review-steps">
            {STEP_KEYS.map((key) => {
              const step = run.steps[key];
              return <WizardStepIndicator key={key} label={STEP_LABELS[key] ?? key} status={step.status} error={step.error} />;
            })}
          </div>

          {run.summary ? <p className="message-body">{run.summary}</p> : null}
          {run.error ? <p className="error">{run.error}</p> : null}

          <div className="placeholder-card stack stack-tight">
            <p className="muted small-copy">Wizard Transcript</p>
            <p className="message-body">{run.review.wizardTranscript || run.review.brief || "No transcript captured."}</p>
          </div>

          {hasAnyResult ? (
            <>
              <div className="wizard-review-tabs">
                {STEP_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`secondary-button wizard-review-tab${tab === key ? " is-active" : ""}`}
                    onClick={() => setTab(key)}
                  >
                    {STEP_LABELS[key] ?? key}
                  </button>
                ))}
              </div>

              {tab === "lorebookCorpus" ? (
                <div className="wizard-lorebook-preview">
                  <span className="muted small-copy">
                    Lorebook Corpus · {corpusEntries.length} entries · {formatWizardStepStatus(run.steps.lorebookCorpus.status)}
                  </span>
                  {corpusEntries.length > 0 ? (
                    <div className="wizard-lorebook-list">
                      {corpusEntries.map((entry, i) => (
                        <div key={i} className="wizard-lorebook-entry">
                          <div className="wizard-lorebook-entry-header">
                            <strong>{entry.name}</strong>
                            {entry.tag && <span className="muted" style={{ fontSize: 10 }}>{entry.tag}</span>}
                            {entry.isConstant && <span style={{ fontSize: 9, color: "var(--amber)", border: "1px solid var(--amber)", borderRadius: 3, padding: "0 3px" }}>const</span>}
                          </div>
                          <p className="muted small-copy" style={{ margin: "2px 0" }}>{entry.content.slice(0, 200)}{entry.content.length > 200 ? "..." : ""}</p>
                          <span className="muted" style={{ fontSize: 9 }}>Keys: {entry.keys.join(", ")}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted small-copy">No entries generated yet.</p>
                  )}
                  {run.steps.lorebookCorpus.error && <p className="error">{run.steps.lorebookCorpus.error}</p>}
                </div>
              ) : (
                <label className="stack stack-tight">
                  <span className="muted small-copy">
                    System Prompt · {formatWizardStepStatus(run.steps.systemPrompt.status)}
                  </span>
                  <textarea
                    aria-label="Wizard review System Prompt"
                    className="wizard-review-textarea"
                    value={drafts.systemPromptDraft}
                    onChange={(event) => setDrafts((current) => ({ ...current, systemPromptDraft: event.target.value }))}
                    spellCheck={false}
                    disabled={run.approvedAt != null}
                  />
                </label>
              )}
              {tab === "systemPrompt" && run.steps.systemPrompt.error ? <p className="error">{run.steps.systemPrompt.error}</p> : null}
            </>
          ) : (
            <p className="muted small-copy">No wizard output is available yet.</p>
          )}

          {run.review.retriedFromRunId ? <p className="muted small-copy">Retried from run {run.review.retriedFromRunId}</p> : null}
          {run.review.approvedSessionId ? <p className="muted small-copy">Created Part 1 session {run.review.approvedSessionId}</p> : null}

          <div className="row gap-sm end wrap-row">
            {(run.status === "queued" || run.status === "running") ? (
              <button type="button" className="danger-button" onClick={() => onCancel(run.id)} disabled={busy}>Cancel Wizard</button>
            ) : null}
            {(run.status === "completed" || run.status === "failed" || run.status === "canceled") && !run.approvedAt ? (
              <button type="button" className="secondary-button" onClick={() => onRetry(run.id)} disabled={busy}>Re-run Wizard</button>
            ) : null}
            {run.status === "completed" && allComplete && !run.approvedAt ? (
              <button
                type="button"
                onClick={() => onApprove(run.id, drafts)}
                disabled={busy || !drafts.campaignName.trim() || !drafts.systemPromptDraft.trim() || corpusEntries.length === 0}
              >
                Approve & Start Campaign
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function WizardStepIndicator({ label, status, error }: { label: string; status: WizardRun["steps"]["systemPrompt"]["status"]; error: string | null }) {
  const icon = status === "completed" ? "✓" : status === "failed" ? "✗" : status === "running" ? "●" : "○";
  const tone = status === "completed" ? "wizard-step-complete" : status === "failed" ? "wizard-step-failed" : status === "running" ? "wizard-step-running" : "wizard-step-pending";
  return (
    <div className={`wizard-review-step ${tone}`}>
      <strong>{icon} {label}</strong>
      <span className="muted small-copy">{formatWizardStepStatus(status)}</span>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function formatWizardStatus(status: WizardRunStatus) {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "canceled") return "Canceled";
  return "Failed";
}

function formatWizardStepStatus(status: WizardRun["steps"]["systemPrompt"]["status"]) {
  if (status === "pending") return "Pending";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  return "Failed";
}
