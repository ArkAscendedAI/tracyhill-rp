import type { PipelineRun } from "@tracyhill-rp/contracts";

import { formatPipelineStepStatus, formatRetryMode } from "./pipelineUtils";

export function PipelineReviewDetails({ run }: { run: PipelineRun }) {
  const syspromptNote = run.review.syspromptNoChanges
    ? "No durable system-prompt changes were recommended."
    : null;

  return (
    <div className="stack stack-tight">
      <PipelineStepCard
        label="Deep Analysis"
        stepStatus={run.steps.analysis?.status ?? "pending"}
        body={run.review.analysisReport}
        error={run.steps.analysis?.error ?? null}
        defaultCollapsed
      />
      <PipelineStepCard
        label="Lorebook Refresh"
        stepStatus={run.steps.lorebookRefresh?.status ?? "pending"}
        body={run.review.lorebookOperations}
        error={run.steps.lorebookRefresh?.error ?? null}
      />
      <PipelineStepCard
        label="System Prompt Update"
        stepStatus={run.steps.syspromptUpdate?.status ?? "pending"}
        body={syspromptNote || run.review.systemPromptDraft}
        error={run.steps.syspromptUpdate?.error ?? null}
        note={syspromptNote ? null : (run.review.systemPromptDraft ? "Updated system prompt ready for review." : null)}
      />
      {run.models ? (
        <p className="muted small-copy">Model: {run.models.creativeModelId}</p>
      ) : null}
      {run.review.retriedFromRunId ? (
        <p className="muted small-copy">Retried {formatRetryMode(run.review.retriedFromStep)} from run {run.review.retriedFromRunId}</p>
      ) : null}
      {run.review.approvedSessionId ? (
        <p className="muted small-copy">Started session {run.review.approvedSessionId}</p>
      ) : null}
    </div>
  );
}

function PipelineStepCard({
  label, stepStatus, body, error, summary, note, defaultCollapsed,
}: {
  label: string;
  stepStatus: string;
  body: string | null | undefined;
  error: string | null;
  summary?: string | null;
  note?: string | null;
  defaultCollapsed?: boolean;
}) {
  return (
    <details className="placeholder-card stack stack-tight" open={!defaultCollapsed}>
      <summary className="section-head" style={{ cursor: "pointer" }}>
        <strong>{label}</strong>
        <span className="muted small-copy">{formatPipelineStepStatus(stepStatus)}</span>
      </summary>
      {summary ? <p className={`small-copy ${summary.includes("FAIL") ? "error" : "muted"}`}>{summary}</p> : null}
      {note ? <p className="muted small-copy">{note}</p> : null}
      <p className="message-body">{body || "No output yet."}</p>
      {error ? <p className="error">{error}</p> : null}
    </details>
  );
}
