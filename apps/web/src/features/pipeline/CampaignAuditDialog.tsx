import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { CampaignAuditMode, ProviderKeyListResponse } from "@tracyhill-rp/contracts";
import type { AvailableChatModel } from "../auth/providerKeyApi";
import { ModelDialOptions } from "../chat/modelDialOptions";

import { enqueueCampaignAudit, getCampaignAuditStatus } from "./pipelineApi";
import { Icon } from "../../shared/ui/Icon";
import { Dialog } from "../../shared/ui/Dialog";
import { QueryError } from "../../shared/ui/QueryError";
import "../../styles/feature-audit.css";

interface CampaignAuditDialogProps {
  open: boolean;
  onClose: () => void;
  campaignId: string;
  campaignName: string;
  // Present when launched from a session (composer) — resolves the Engine
  // dials through that session; absent from the campaign editor.
  sessionId?: string;
  // The caller's resolved default for the model picker: the session's
  // auditModel dial from the composer, the contract default from the campaign
  // editor (which has no session). Empty when no keyed model is available —
  // the run button is disabled rather than POSTing a blank modelId.
  defaultModelId: string;
  availableModels: AvailableChatModel[];
  // The caller's provider-key status: with it the model select says why a saved audit model is
  // missing from the keyed list (no key, or not in this build's catalog), as the Engine dials do.
  config: ProviderKeyListResponse | undefined;
}

// Campaign Audit: pick Quick or Full, pick
// the model, run. Findings auto-apply behind the adversarial tail; this dialog
// shows progress and then the REPORT — there is nothing to approve.
export function CampaignAuditDialog({ open, onClose, campaignId, campaignName, sessionId, defaultModelId, availableModels, config }: CampaignAuditDialogProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<CampaignAuditMode>("quick");
  const [modelId, setModelId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const effectiveModelId = modelId ?? defaultModelId;

  const statusQuery = useQuery({
    queryKey: ["campaign-audit", campaignId],
    queryFn: () => getCampaignAuditStatus(campaignId),
    enabled: open,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "queued" || s === "running" ? 2000 : false;
    },
  });
  const status = statusQuery.data;
  const busy = status?.status === "queued" || status?.status === "running";
  const report = status?.status === "completed" ? status.report : null;

  const runMutation = useMutation({
    mutationFn: () => enqueueCampaignAudit(campaignId, {
      mode,
      modelId: effectiveModelId,
      ...(sessionId ? { sessionId } : {}),
    }),
    onSuccess: (data) => {
      queryClient.setQueryData(["campaign-audit", campaignId], data);
      setError("");
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} label="Campaign Audit" eyebrow="Campaign" title={<>Campaign Audit — {campaignName}</>} icon="search" size="lg" className="audit-dialog" bodyClassName="dialog-body-stack" dismissOnBackdrop>
        <p className="muted small-copy" style={{ margin: 0 }}>
          Reconciles the lorebook against the whole story from message 1 — no watermarks, nothing is ever “past review.”
          Fixes auto-apply after an adversarial check (every write is revisioned and revertible); ambiguous findings are flagged, never guessed.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {/* A failed status read is not "no audit has run": it says so, with Retry, above the form, or above the
            progress a re-read failure keeps. */}
        <QueryError query={statusQuery} label="Unable to load the audit status" />

        {!busy ? (
          <div className="audit-form">
            <div className="row gap-sm wrap-row">
              <label className={`world-mode ${mode === "quick" ? "active" : ""}`}>
                <input type="radio" checked={mode === "quick"} onChange={() => setMode("quick")} />
                Quick — lorebook coherence only (minutes)
              </label>
              <label className={`world-mode ${mode === "full" ? "active" : ""}`}>
                <input type="radio" checked={mode === "full"} onChange={() => setMode("full")} />
                Full — re-read the entire story first (long)
              </label>
            </div>
            <div className="row gap-sm">
              <span className="lbl">Model</span>
              <select aria-label="Audit model" value={effectiveModelId} onChange={(e) => setModelId(e.target.value)} style={{ flex: 1 }}>
                {/* A saved dial absent from the key-filtered list (its provider key removed) used to render
                    as the browser's first option while the POST carried the saved id. */}
                <ModelDialOptions models={availableModels} value={effectiveModelId} config={config} />
                {availableModels.length === 0 ? <option value="">No models available</option> : null}
              </select>
            </div>
            <div className="row end">
              <span className="muted small-copy">
                {status?.status === "failed" ? `Last audit failed: ${status.error ?? "unknown"}` :
                  status?.completedAt ? `Last audit (${status.mode ?? "?"}${status.auto ? ", auto" : ""}) ${new Date(status.completedAt).toLocaleString()}` : ""}
              </span>
              <button disabled={runMutation.isPending || !effectiveModelId} title={effectiveModelId ? undefined : "No chat model is available — add a provider key first"} onClick={() => runMutation.mutate()}>
                {runMutation.isPending ? "Starting…" : "Run audit"}
              </button>
            </div>
          </div>
        ) : (
          <div className="audit-progress">
            <p className="small-copy">
              Auditing ({status?.mode ?? "?"})… {status?.progress ? <strong>{stageLabel(status.progress.stage)} {status.progress.current}/{status.progress.total}</strong> : "starting"}
            </p>
            <p className="muted small-copy" style={{ margin: 0 }}>A full audit on a long campaign can take an hour — you can close this dialog; the run continues and the report lands here.</p>
          </div>
        )}

        {report && !busy ? (
          <div className="audit-report">
            <p className="small-copy" style={{ margin: 0 }}>
              <strong>{report.applied.creates + report.applied.updates + report.applied.disables} applied</strong>
              {" "}({report.applied.creates} created / {report.applied.updates} updated / {report.applied.disables} disabled)
              {" · "}{report.refuted.length} refuted · {report.ambiguous.length} flagged
              {report.held.length > 0 ? <span className="error"> · {report.held.map((h) => `${h.count} ${h.opClass}s HELD`).join(", ")}</span> : null}
            </p>
            {report.analysis ? (
              <details open>
                <summary className="small-copy"><strong>State of the campaign</strong></summary>
                <p className="small-copy audit-analysis">{report.analysis}</p>
              </details>
            ) : null}
            {report.appliedDetails.length > 0 ? (
              <details>
                <summary className="small-copy"><strong>Applied changes</strong> ({report.appliedDetails.length}) — revertible per entry via lorebook History</summary>
                <ul className="audit-list">
                  {report.appliedDetails.map((a, i) => <li key={i} className="small-copy">{a.op} — {a.name}</li>)}
                </ul>
              </details>
            ) : null}
            {report.held.length > 0 ? (
              <details open>
                {/* A held row is a blast-radius cap, a mid-audit collision or a write the server refused, and
                    each carries its own reason; the heading names none of them. */}
                <summary className="small-copy error"><strong>Held</strong> ({report.held.length}) — each with its reason</summary>
                <ul className="audit-list">
                  {report.held.map((h, i) => <li key={i} className="small-copy">{h.reason}</li>)}
                </ul>
              </details>
            ) : null}
            {report.ambiguous.length > 0 ? (
              <details>
                <summary className="small-copy"><strong>Flagged for you</strong> ({report.ambiguous.length}) — ambiguous or unverdicted; never auto-applied. Rule on them via the <Icon name="scale" size={12} /> Findings chip in the status strip.</summary>
                <ul className="audit-list">
                  {report.ambiguous.map((a, i) => <li key={i} className="small-copy">{a}</li>)}
                </ul>
              </details>
            ) : null}
            {report.refuted.length > 0 ? (
              <details>
                <summary className="small-copy"><strong>Refuted findings</strong> ({report.refuted.length}) — what the verifier killed, with reasons</summary>
                <ul className="audit-list">
                  {report.refuted.map((r, i) => <li key={i} className="small-copy">{r.finding} — <span className="muted">{r.reason}</span></li>)}
                </ul>
              </details>
            ) : null}
            <p className="muted small-copy" style={{ margin: 0 }}>
              Read {report.stats.messagesRead.toLocaleString()} messages / {report.stats.entriesRead} entries · {report.stats.phase1Chunks} sweep chunks · {report.stats.phase2Clusters} coherence clusters · {report.stats.findings} findings
            </p>
            {report.usage && report.usage.calls > 0 ? (
              <p className="muted small-copy" style={{ margin: 0 }}>
                {report.usage.calls} LLM calls · {((report.usage.inputTokens + report.usage.outputTokens) / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}K tokens
                {" "}({(report.usage.inputTokens / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}K in / {(report.usage.outputTokens / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })}K out)
                {report.usage.elapsedMs > 0 ? <> · {Math.round(report.usage.elapsedMs / 60000)}m · {Math.round((report.usage.inputTokens + report.usage.outputTokens) / (report.usage.elapsedMs / 1000))} tok/s</> : null}
                {report.resumedFrom ? <> · {report.resumedFrom}</> : null}
              </p>
            ) : null}
          </div>
        ) : null}
    </Dialog>
  );
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "phase1": return "reading the story";
    case "phase2": return "checking coherence";
    case "reduce": return "cross-referencing";
    case "refute": return "adversarial verify";
    case "validate": return "validating fixes";
    case "apply": return "applying";
    default: return stage;
  }
}
