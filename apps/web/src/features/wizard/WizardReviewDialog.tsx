import { useEffect, useMemo, useRef, useState } from "react";

import { CHAT_MODELS } from "@tracyhill-rp/model-catalog";
import { approveWizardRunRequestSchema } from "@tracyhill-rp/contracts";
import type { ApproveWizardRunRequest, WizardRun, LorebookCorpusEntry } from "@tracyhill-rp/contracts";

import { buildApprovalPrompt, draftConflicts, sectionAFor, seedReviewDrafts, type ReviewDrafts } from "./wizardReviewDraft";
import { cancelWizardTargetOf, corpusEntryPreview, formatWizardStatus, formatWizardStepStatus, type CancelWizardTarget } from "./wizardUtils";
import { CancelWizardDialog } from "./CancelWizardDialog";
import { stringMaxLength } from "../lorebook/contractBounds";
import { overLimitMessage } from "../../shared/text/lengthCap";
import { Icon } from "../../shared/ui/Icon";
import type { IconName } from "../../shared/ui/iconSprite";
import { Dialog } from "../../shared/ui/Dialog";
import "../../styles/feature-wizard.css";

// The approve contract's limits: a longer name or prompt came back as a bare
// "invalid wizard approve request". The name input stops at its limit; an over-long prompt is named and holds Approve.
const APPROVE_FIELDS = approveWizardRunRequestSchema.shape;
const REVIEW_NAME_MAX = stringMaxLength(APPROVE_FIELDS.campaignName);
const REVIEW_PROMPT_MAX = stringMaxLength(APPROVE_FIELDS.systemPromptDraft) ?? Infinity;

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

export function WizardReviewDialog({ open, run, busy, onClose, onApprove, onRetry, onCancel }: WizardReviewDialogProps) {
  const [tab, setTab] = useState<string>("lorebookCorpus");
  const [drafts, setDrafts] = useState<ReviewDrafts>(() => seedReviewDrafts(run));
  const [elapsed, setElapsed] = useState("");
  const intervalRef = useRef<number | null>(null);
  // Cancel Wizard asks first; closing the review drops an open confirmation.
  const [confirmingCancel, setConfirmingCancel] = useState<CancelWizardTarget | null>(null);
  useEffect(() => {
    if (!open) setConfirmingCancel(null);
  }, [open]);

  useEffect(() => {
    if (!run) return;
    setDrafts((current) => {
      const next = { ...current };
      let changed = false;
      const incoming = seedReviewDrafts(run);
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
      setDrafts(seedReviewDrafts(run));
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
  const hasAnyResult = corpusEntries.length > 0 || Boolean(drafts.systemPromptBody);
  const allComplete = run.steps.systemPrompt.status === "completed" && run.steps.lorebookCorpus.status === "completed";
  const playerCharacterName = run.review.playerCharacterName;
  // A SillyTavern lorebook import: its source replaces the transcript card.
  const importSummary = run.review.importSummary;
  const offCount = corpusEntries.filter((entry) => entry.activation?.enabled === false).length;
  // Section A is rendered read-only OUTSIDE the textarea; the only remaining
  // way to trip the server's 400 is pasting a Section A heading back into the
  // body — surface it here and hold Approve.
  const conflicts = draftConflicts(drafts.systemPromptBody, playerCharacterName);
  // What Approve sends: Section A re-stamped over the edited body, measured as the server does (trimmed).
  const approvalPrompt = buildApprovalPrompt(drafts.systemPromptBody, playerCharacterName);
  const approvalLength = approvalPrompt.trim().length;
  const promptTooLong = approvalLength > REVIEW_PROMPT_MAX ? overLimitMessage("The system prompt", approvalLength, REVIEW_PROMPT_MAX) : null;

  return (
    <Dialog open onClose={onClose} label="Wizard Review" eyebrow="Campaign Wizard" title={drafts.campaignName || run.review.campaignName || "New Campaign"} icon="sparkles" size="wide" className="wizard-review-dialog">
        <div className="stack stack-tight">

          <div className="wizard-review-meta">
            <span>Model: {modelLabel}</span>
            <span>Status: {status}</span>
            <span>Elapsed: {elapsed || "0m 00s"}</span>
          </div>

          <div className="wizard-firmware-note">
            <strong>Canonical player-authority firmware applied</strong>
            <span>Section A is shared, immutable, and kept separate from generated campaign guidance — it is shown read-only under the System Prompt tab and re-stamped at approval; edit only the sections beneath it.</span>
          </div>

          {run.review.autoCorrections.length > 0 ? (
            <div className="wizard-lint-summary" role="status">
              <strong><Icon name="check" size={13} /> Auto-corrected · {run.review.autoCorrections.length}</strong>
              <div className="stack stack-tight">
                {run.review.autoCorrections.map((correction, index) => (
                  <span key={`${correction.code}-${correction.location}-${index}`} className="small-copy wizard-lint-change">
                    <span>{correction.location}: {correction.summary} {correction.verified ? "Verified." : "Guarded."}</span>
                    <span><code>{correction.before}</code> → <code>{correction.after}</code></span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {run.review.lintResidue.length > 0 ? (
            <div className="wizard-lint-residue" role="status">
              <strong>Advisory · {run.review.lintResidue.length} unresolved</strong>
              {run.review.lintResidue.map((finding, index) => (
                <span key={`${finding.code}-${finding.location}-${index}`} className="small-copy">{finding.location}: {finding.message}</span>
              ))}
            </div>
          ) : null}

          <label className="stack stack-tight">
            <span className="muted small-copy">Campaign name</span>
            <input
              aria-label="Wizard review campaign name"
              maxLength={REVIEW_NAME_MAX}
              value={drafts.campaignName}
              onChange={(event) => setDrafts((current) => ({ ...current, campaignName: event.target.value }))}
              disabled={run.approvedAt != null}
            />
          </label>

          <div className="wizard-review-steps">
            {STEP_KEYS.map((key) => {
              const step = run.steps[key];
              return <WizardStepIndicator key={key} label={STEP_LABELS[key] ?? key} status={step.status} error={step.error} progress={step.progress ?? null} />;
            })}
          </div>

          {run.summary ? <p className="message-body">{run.summary}</p> : null}
          {run.error ? <p className="error">{run.error}</p> : null}

          {importSummary ? (
            <div className="placeholder-card stack stack-tight">
              <p className="muted small-copy">Imported lorebook</p>
              <p className="message-body">
                {importSummary.fileName}: {importSummary.imported} of {importSummary.entries} entries carried over{offCount > 0 ? `, ${offCount} of them off as they were in SillyTavern` : ""}. {playerCharacterName} is the player character.
              </p>
              {importSummary.leftOut.length > 0 ? <p className="muted small-copy">Left out: {importSummary.leftOut.join(" ")}</p> : null}
              {importSummary.notes ? <p className="muted small-copy">Your notes: {importSummary.notes}</p> : null}
            </div>
          ) : (
            <div className="placeholder-card stack stack-tight">
              <p className="muted small-copy">Wizard Transcript</p>
              <p className="message-body">{run.review.wizardTranscript || run.review.brief || "No transcript captured."}</p>
            </div>
          )}

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
                            {entry.startingSchemes?.length ? <span className="wizard-sealed-scheme-chip">sealed scheme</span> : null}
                            <EntryOriginChips entry={entry} />
                          </div>
                          <p className="muted small-copy" style={{ margin: "2px 0" }}>{corpusEntryPreview(entry.content)}</p>
                          {entry.origin?.added?.length ? <p className="small-copy wizard-entry-added">Added by the importer: {entry.origin.added.join(", ")}.</p> : null}
                          <span className="muted" style={{ fontSize: 9 }}>Keys: {entry.keys.join(", ")}</span>
                          <details className="wizard-entry-full">
                            <summary className="small-copy">Full text</summary>
                            <p className="message-body small-copy">{entry.content}</p>
                          </details>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted small-copy">No entries generated yet.</p>
                  )}
                  {run.steps.lorebookCorpus.error && <p className="error">{run.steps.lorebookCorpus.error}</p>}
                </div>
              ) : (
                <div className="stack stack-tight">
                  <span className="muted small-copy">
                    System Prompt · {formatWizardStepStatus(run.steps.systemPrompt.status)}
                  </span>
                  <details className="placeholder-card wizard-section-a">
                    <summary className="small-copy" style={{ cursor: "pointer" }}><strong>Section A (canonical, read-only)</strong> — player-character authority for {playerCharacterName}</summary>
                    <pre className="message-body small-copy" aria-label="Wizard review Section A" style={{ marginTop: 8 }}>{sectionAFor(run)}</pre>
                  </details>
                  <label className="stack stack-tight">
                    <span className="muted small-copy">Generated sections (editable)</span>
                    <textarea
                      aria-label="Wizard review System Prompt"
                      className="wizard-review-textarea"
                      value={drafts.systemPromptBody}
                      onChange={(event) => setDrafts((current) => ({ ...current, systemPromptBody: event.target.value }))}
                      spellCheck={false}
                      disabled={run.approvedAt != null}
                    />
                  </label>
                  {conflicts.length > 0 ? (
                    <p className="error small-copy" role="alert">
                      Section A is canonical and re-stamped at approval — the text under your Section A heading would be lost: “{conflicts[0]}”. Remove that heading (Section A is added for you) and keep your text under its own “## ” heading.
                    </p>
                  ) : null}
                </div>
              )}
              {tab === "systemPrompt" && run.steps.systemPrompt.error ? <p className="error">{run.steps.systemPrompt.error}</p> : null}
            </>
          ) : (
            <p className="muted small-copy">No wizard output is available yet.</p>
          )}

          {run.review.retriedFromRunId ? <p className="muted small-copy">Retried from run {run.review.retriedFromRunId}</p> : null}
          {run.review.approvedSessionId ? <p className="muted small-copy">Created Part 1 session {run.review.approvedSessionId}</p> : null}

          {promptTooLong && !run.approvedAt ? <p className="error small-copy" role="alert">{promptTooLong}</p> : null}
          <div className="row gap-sm end wrap-row">
            {(run.status === "queued" || run.status === "running") ? (
              <button type="button" className="danger-button" onClick={() => setConfirmingCancel(cancelWizardTargetOf(run))} disabled={busy}>Cancel Wizard</button>
            ) : null}
            {(run.status === "completed" || run.status === "failed" || run.status === "canceled") && !run.approvedAt ? (
              <button type="button" className="secondary-button" onClick={() => onRetry(run.id)} disabled={busy}>Re-run Wizard</button>
            ) : null}
            {run.status === "completed" && allComplete && !run.approvedAt ? (
              <button
                type="button"
                onClick={() => onApprove(run.id, { campaignName: drafts.campaignName, systemPromptDraft: approvalPrompt })}
                disabled={busy || !drafts.campaignName.trim() || !drafts.systemPromptBody.trim() || corpusEntries.length === 0 || conflicts.length > 0 || promptTooLong != null}
              >
                Approve & Start Campaign
              </button>
            ) : null}
          </div>
        </div>
        <CancelWizardDialog
          target={confirmingCancel}
          busy={busy}
          onConfirm={() => { if (confirmingCancel) onCancel(confirmingCancel.runId); setConfirmingCancel(null); }}
          onKeep={() => setConfirmingCancel(null)}
        />
    </Dialog>
  );
}

/**
 * Where an entry came from, beside the entry: a chip names it and its tooltip says more. An imported entry keeps its
 * title in the lorebook; "new" marks an entry the wizard wrote for this campaign; "off" an entry that was off in
 * SillyTavern and stays off.
 */
function EntryOriginChips({ entry }: { entry: LorebookCorpusEntry }) {
  const origin = entry.origin;
  return (
    <>
      {origin?.kind === "imported" ? <span className="wizard-origin-chip" title={origin.source ? `From "${origin.source}" in the lorebook, its text kept as written` : "From the lorebook, its text kept as written"}>imported</span> : null}
      {origin?.kind === "generated" ? <span className="wizard-origin-chip is-generated" title="Written by the wizard for this campaign">new</span> : null}
      {entry.activation?.enabled === false ? <span className="wizard-origin-chip is-off" title="Off in SillyTavern, so it starts off here; turn it on in the Lorebook panel">off</span> : null}
    </>
  );
}

function WizardStepIndicator({ label, status, error, progress }: { label: string; status: WizardRun["steps"]["systemPrompt"]["status"]; error: string | null; progress?: string | null }) {
  const icon: IconName = status === "completed" ? "check-circle" : status === "failed" ? "x" : status === "running" ? "half" : "circle";
  const tone = status === "completed" ? "wizard-step-complete" : status === "failed" ? "wizard-step-failed" : status === "running" ? "wizard-step-running" : "wizard-step-pending";
  return (
    <div className={`wizard-review-step ${tone}`}>
      <strong><Icon name={icon} size={13} /> {label}</strong>
      <span className="muted small-copy">{status === "running" && progress ? progress : formatWizardStepStatus(status)}</span>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

