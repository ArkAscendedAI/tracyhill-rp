import { QueryError } from "../../shared/ui/QueryError";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AUDIT_RULING_MAX_CHARS, AUDIT_RULINGS_PER_SUBMIT_MAX, type AuditFinding } from "@tracyhill-rp/contracts";

import { isUneditedBounce, planRulingsSubmit, rulingDraftFor } from "./auditFindingsUtils";
import { getAuditFindings, submitAuditRulings } from "./pipelineApi";
import { Icon } from "../../shared/ui/Icon";
import { Dialog } from "../../shared/ui/Dialog";
import { AutoTextarea } from "../../shared/ui/AutoTextarea";
import "../../styles/feature-audit.css";

interface AuditFindingsDialogProps {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  sessionId?: string;
}

// Findings review queue: the audit's ambiguous
// residue, one card per finding — the audit's own blurb on WHY it couldn't
// decide, a free-text "User Ruling" beneath. Submitted rulings go to the
// executor run, which adjusts the lorebook (revisioned) or bounces back with
// one specific question. Partial submits are fine; blank rulings stay open,
// and a bounced finding's preserved ruling is re-sent only once it is edited
// (see auditFindingsUtils).
export function AuditFindingsDialog({ open, onClose, campaignId, sessionId }: AuditFindingsDialogProps) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const findingsQuery = useQuery({
    queryKey: ["audit-findings", campaignId],
    queryFn: () => getAuditFindings(campaignId),
    enabled: open,
    // Poll while a ruling run executes. `refetchIntervalInBackground` is
    // ESSENTIAL: the executor runs at the auditModel's effort (max = ~15+ min),
    // and without this the poll pauses on a backgrounded tab — so a run that
    // finishes while you're away never clears `processing`, stranding the
    // submit button disabled.
    refetchInterval: (query) => (query.state.data?.processing ? 3000 : false),
    refetchIntervalInBackground: true,
  });
  // Reopening reconciles to server truth on its own: `enabled` flipping true
  // with the default staleTime 0 fetches — the explicit refetch effect that
  // used to sit here issued a second identical GET per open.
  const data = findingsQuery.data;
  const openFindings = (data?.findings ?? []).filter((f) => f.status === "open");
  const processingFindings = (data?.findings ?? []).filter((f) => f.status === "processing");
  const ruledFindings = (data?.findings ?? []).filter((f) => f.status === "ruled");

  const draftFor = (f: AuditFinding) => rulingDraftFor(f, drafts);
  // The contract's caps are checked before Submit: the first 50 ready rulings go, the rest wait with
  // their drafts, and a ruling over 4,000 characters is named on its card. Only one inside the batch holds Submit;
  // one past the 50th waits with its draft (see planRulingsSubmit).
  const plan = planRulingsSubmit(openFindings, drafts);
  const readyCount = plan.readyCount;
  const waiting = readyCount - plan.batch.length;
  const overLong = new Map(plan.overLong.map((o) => [o.findingId, o.length]));
  const batchOverLong = new Set(plan.batchOverLong.map((o) => o.findingId));
  const firstOverLong = openFindings.find((f) => batchOverLong.has(f.id));

  const submitMutation = useMutation({
    mutationFn: (rulings: typeof plan.batch) => submitAuditRulings(campaignId, {
      rulings,
      ...(sessionId ? { sessionId } : {}),
    }),
    onSuccess: (updated, sent) => {
      queryClient.setQueryData(["audit-findings", campaignId], updated);
      // Only the submitted rulings leave the drafts; those past the per-submit cap stay for the next one.
      setDrafts((d) => {
        const next = { ...d };
        for (const r of sent) delete next[r.findingId];
        return next;
      });
      setError("");
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} label="Audit Findings" eyebrow="Campaign audit" title="Audit Findings — your rulings" icon="scale" size="xl" className="audit-dialog audit-findings-dialog" bodyClassName="dialog-body-stack" dismissOnBackdrop>
        <p className="muted small-copy" style={{ margin: 0 }}>
          The campaign audit couldn't settle these from the transcript, so it never guessed. Write a ruling under each —
          plain language is fine (“that date was a mistake, the real date is June 5 — propagate it everywhere”, or “intentional, leave it; note it as canon”).
          The executor turns rulings into revisioned lorebook changes, or bounces back with one specific question.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <QueryError query={findingsQuery} label="Unable to load audit findings" />
        {findingsQuery.isLoading ? <p className="muted small-copy">Loading audit findings…</p> : null}

        {processingFindings.length > 0 ? (
          <p className="small-copy affd-processing">
            ⏳ {processingFindings.length} ruling{processingFindings.length === 1 ? "" : "s"} being executed — outcomes land here when the run finishes.
          </p>
        ) : null}

        {findingsQuery.isSuccess && openFindings.length === 0 && processingFindings.length === 0 ? (
          <p className="muted small-copy">No findings await a ruling. New flags from future audits appear here.</p>
        ) : null}

        {openFindings.map((f) => (
          <div key={f.id} className="affd-card">
            <div className="affd-head">
              <span className={`affd-kind affd-kind-${f.kind}`}>{f.kind}</span>
              <strong className="small-copy">{f.summary}</strong>
            </div>
            {f.detail ? <p className="small-copy affd-detail">{f.detail}</p> : null}
            {f.reason ? <p className="muted small-copy affd-reason">Why it's undecided: {f.reason}</p> : null}
            {f.entryNames.length > 0 ? (
              <div className="affd-entries">
                {f.entryNames.map((name, i) => <span key={i} className="affd-entry-chip">{name}</span>)}
              </div>
            ) : null}
            {f.executorQuestion ? (
              <p className="small-copy affd-question">↩ Executor: {f.executorQuestion}</p>
            ) : null}
            <label className="lbl affd-ruling-label" htmlFor={`ruling-${f.id}`}>User Ruling</label>
            <AutoTextarea
              id={`ruling-${f.id}`}
              className="affd-ruling"
              minRows={2}
              maxRows={8}
              placeholder="Your ruling — or leave blank to keep it open"
              value={draftFor(f)}
              onChange={(e) => setDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
              disabled={submitMutation.isPending}
            />
            {isUneditedBounce(f, draftFor(f)) ? (
              <p className="muted small-copy" style={{ margin: 0 }}>This is the ruling the executor bounced — edit it to answer the question; unchanged, it is not re-sent.</p>
            ) : null}
            {overLong.has(f.id) ? (
              <p className="error small-copy" style={{ margin: 0 }}>This ruling is {formatCount(overLong.get(f.id)!)} characters; a ruling can be at most {formatCount(AUDIT_RULING_MAX_CHARS)}. Shorten it to submit.</p>
            ) : null}
          </div>
        ))}

        {firstOverLong ? (
          <p className="error small-copy" role="alert" style={{ margin: 0 }}>
            {plan.batchOverLong.length === 1
              ? `Shorten the ruling for “${firstOverLong.summary}” to ${formatCount(AUDIT_RULING_MAX_CHARS)} characters or fewer to submit.`
              : `${plan.batchOverLong.length} rulings in this submit are over ${formatCount(AUDIT_RULING_MAX_CHARS)} characters. Shorten each one marked above to submit.`}
          </p>
        ) : null}
        {waiting > 0 ? (
          <p className="muted small-copy" style={{ margin: 0 }}>
            At most {AUDIT_RULINGS_PER_SUBMIT_MAX} rulings go in one submit. The other {waiting} {waiting === 1 ? "stays" : "stay"} here for the next one.
          </p>
        ) : null}
        {openFindings.length > 0 ? (
          <div className="row end">
            <span className="muted small-copy">{readyCount} of {openFindings.length} ruled — blanks stay open</span>
            <button
              disabled={readyCount === 0 || submitMutation.isPending || processingFindings.length > 0 || plan.batchOverLong.length > 0}
              onClick={() => submitMutation.mutate(plan.batch)}
            >
              {submitMutation.isPending ? "Submitting…" : waiting > 0 ? `Submit ${plan.batch.length} of ${readyCount} rulings` : `Submit ${readyCount || ""} ruling${readyCount === 1 ? "" : "s"}`}
            </button>
          </div>
        ) : null}

        {ruledFindings.length > 0 ? (
          <details>
            <summary className="small-copy"><strong>Recent rulings</strong> ({ruledFindings.length}) — changes are revertible per entry via lorebook History</summary>
            <ul className="audit-list">
              {ruledFindings.map((f) => (
                <li key={f.id} className="small-copy">
                  {f.summary}
                  {f.ruling ? <><br /><span className="muted">Your ruling: {f.ruling}</span></> : null}
                  {f.outcome ? <><br /><span className="affd-outcome">→ {f.outcome}</span></> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
    </Dialog>
  );
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
