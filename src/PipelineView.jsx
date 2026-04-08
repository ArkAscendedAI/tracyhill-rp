import { useState, useEffect, useRef } from "react";
import { X, ChevronDown, ChevronRight } from "lucide-react";

function StepIndicator({ step, label, pipelineDone }) {
  const stuck = step.status === "running" && pipelineDone; // pipeline ended but step still says running — treat as failed
  const status = stuck ? "failed" : step.status;
  const icon = status === "complete" ? "✓" : status === "failed" || status === "cancelled" ? "✗" : status === "running" ? "●" : status === "skipped" ? "—" : "○";
  const color = status === "complete" ? "var(--green)" : status === "failed" || status === "cancelled" ? "var(--red)" : status === "running" ? "var(--accent)" : "var(--text2)";
  const err = stuck ? (step.error || "Interrupted") : step.error;
  return <div className="pipe-step" style={{ color }}><span className="pipe-step-icon">{icon}</span> {label} {status === "running" && <span className="pipe-spinner" />}{err && <span className="pipe-step-error"> — {err}</span>}</div>;
}

export default function PipelineView({ pipeline, onClose, onApprove, onReject, onRetry, onCancel, campaignName }) {
  const [tab, setTab] = useState("validation");
  const [editedSeed, setEditedSeed] = useState("");
  const [editedSysPrompt, setEditedSysPrompt] = useState("");
  const [elapsed, setElapsed] = useState("");
  const [valExpanded, setValExpanded] = useState(true);
  const [fixEditsExpanded, setFixEditsExpanded] = useState(false);
  const [diffsExpanded, setDiffsExpanded] = useState(false);
  const intervalRef = useRef(null);

  // Seed: prefer auto-fixed version, fall back to step1 result
  useEffect(() => {
    const seed = pipeline?.step2?.fixedSeed || pipeline?.step1?.result;
    if (seed && !editedSeed) setEditedSeed(seed);
  }, [pipeline?.step1?.result, pipeline?.step2?.fixedSeed]);

  // System prompt: only set from applied result (not raw diffs)
  useEffect(() => {
    if (pipeline?.step3?.appliedResult && !editedSysPrompt) setEditedSysPrompt(pipeline.step3.appliedResult);
  }, [pipeline?.step3?.appliedResult]);

  // Elapsed timer
  useEffect(() => {
    if (!pipeline?.startedAt) return;
    function tick() {
      const start = new Date(pipeline.startedAt).getTime();
      const end = pipeline.completedAt ? new Date(pipeline.completedAt).getTime() : Date.now();
      const secs = Math.floor((end - start) / 1000);
      const m = Math.floor(secs / 60), s = secs % 60;
      setElapsed(`${m}m ${s.toString().padStart(2, "0")}s`);
    }
    tick();
    if (!pipeline.completedAt) { intervalRef.current = setInterval(tick, 1000); return () => clearInterval(intervalRef.current); }
  }, [pipeline?.startedAt, pipeline?.completedAt]);

  if (!pipeline) return null;

  const isRunning = ["running", "running_step1", "running_step2", "running_step3"].includes(pipeline.status);
  const isComplete = pipeline.status === "complete";
  const isFailed = pipeline.status === "failed";
  const isCancelled = pipeline.status === "cancelled";
  const hasAnyResult = !!(pipeline.step1?.result || pipeline.step2?.result || pipeline.step3?.result);

  const valPassed = pipeline.step2?.passed;
  const valFailed = pipeline.step2?.passed === false;
  const valAutoFixed = pipeline.step2?.fixApplyStatus === "complete";
  const valFixEditsReady = pipeline.step2?.autoFixStatus === "complete";
  const valFixRunning = pipeline.step2?.autoFixStatus === "running" || pipeline.step2?.fixApplyStatus === "running";
  const valFixFailed = pipeline.step2?.autoFixStatus === "failed" || pipeline.step2?.fixApplyStatus === "failed";
  const step1Truncated = pipeline.step1?.truncated;
  const step3HasResults = pipeline.step3?.status === "complete" && pipeline.step3?.result;
  const step3NoChanges = step3HasResults && /no changes needed/i.test(pipeline.step3.result);
  const step3Applied = pipeline.step3?.applyStatus === "complete";
  const step3Applying = pipeline.step3?.applyStatus === "running";

  // For step indicators: validation shows green if passed OR auto-fixed
  const step2Display = { ...pipeline.step2 };
  if (valAutoFixed) step2Display.status = "complete";

  return (<div className="pipeline-view">
    <div className="pipe-header">
      <h2>State Seed Update Pipeline</h2>
      <button className="icon-btn" onClick={onClose}><X size={18} /></button>
    </div>

    <div className="pipe-meta">
      <span>Campaign: <strong>{campaignName}</strong></span>
      <span>v{pipeline.fromVersion} → v{pipeline.toVersion}</span>
      <span>Model: {pipeline.model}{pipeline.model?.startsWith("custom:") ? " (Beta)" : ""}</span>
      <span>Elapsed: {elapsed}</span>
      {pipeline.sessionName && <span>Source: {pipeline.sessionName}</span>}
    </div>

    {/* Progress steps */}
    <div className="pipe-steps">
      <StepIndicator step={pipeline.step1 || {}} label="Seed generation" pipelineDone={!isRunning} />
      <StepIndicator step={step2Display || {}} label={`Validation${valAutoFixed ? " (auto-fixed)" : pipeline.step2?.fixApplyStatus === "running" ? " (applying fix...)" : pipeline.step2?.autoFixStatus === "running" ? " (generating fix...)" : valFixFailed ? " (fix failed)" : ""}`} pipelineDone={!isRunning} />
      <StepIndicator step={pipeline.step3 || {}} label={`System prompt check${step3Applied ? " (applied)" : step3Applying ? " (applying...)" : ""}`} pipelineDone={!isRunning} />
    </div>

    {/* Warnings */}
    {step1Truncated && <div className="pipe-warning">⚠ Output was truncated — the model hit its max output token limit. The state seed may be incomplete. Review carefully or re-run with a model that supports higher output.</div>}
    {pipeline.error && <div className="pipe-error">{pipeline.error}</div>}

    {/* Review tabs — show when complete, failed, or cancelled (any terminal state with potential results) */}
    {(isComplete || isFailed || isCancelled) && <>
      {hasAnyResult && <div className="pipe-tabs">
        {pipeline.step1?.result && <button className={`pipe-tab ${tab === "seed" ? "active" : ""}`} onClick={() => setTab("seed")}>New State Seed {pipeline.step1?.status === "complete" && <span style={{ color: "var(--green)" }}>✓</span>}</button>}
        {(pipeline.step2?.result || pipeline.step2?.status === "failed") && <button className={`pipe-tab ${tab === "validation" ? "active" : ""}`} onClick={() => setTab("validation")}>
          Validation {(valPassed || valAutoFixed) && <span style={{ color: "var(--green)" }}>✓</span>}{valFailed && !valAutoFixed && <span style={{ color: "var(--red)" }}>✗</span>}
        </button>}
        <button className={`pipe-tab ${tab === "sysprompt" ? "active" : ""}`} onClick={() => setTab("sysprompt")}>
          System Prompt {(step3NoChanges || pipeline.step3?.status === "skipped" || step3Applied) && <span style={{ color: "var(--green)" }}>✓</span>}{step3HasResults && !step3NoChanges && !step3Applied && <span style={{ color: "var(--amber)" }}>!</span>}{pipeline.step3?.status === "failed" && <span style={{ color: "var(--red)" }}>✗</span>}
        </button>
      </div>}

      {hasAnyResult && <div className="pipe-tab-content">
        {tab === "validation" && <div className="pipe-validation">
          {pipeline.step2?.status === "failed" && <div className="pipe-error">Validation step failed: {pipeline.step2.error}</div>}
          {pipeline.step2?.result && <>
            <div className={`pipe-val-summary ${valPassed ? "pass" : valAutoFixed ? "pass" : "fail"}`}>
              {valPassed ? "VALIDATION: PASS" : valAutoFixed ? "VALIDATION: FAIL → AUTO-FIXED" : "VALIDATION: FAIL"}
            </div>
            {valAutoFixed && <div style={{ color: "var(--green)", fontSize: 12, marginBottom: 8 }}>Issues identified below were surgically corrected in the state seed.</div>}
            {pipeline.step2?.autoFixStatus === "failed" && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 8 }}>Fix generation failed: {pipeline.step2.autoFixError}. Review the issues below and fix manually in the State Seed tab.</div>}
            {pipeline.step2?.fixApplyStatus === "failed" && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 8 }}>Fix apply failed: {pipeline.step2.fixApplyError}. Review the surgical edits below and apply manually in the State Seed tab.</div>}
            <button className="pipe-expand-btn" onClick={() => setValExpanded(!valExpanded)}>{valExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Full Report</button>
            {valExpanded && <pre className="pipe-pre">{pipeline.step2.result}</pre>}
            {pipeline.step2?.fixEdits && <>
              <button className="pipe-expand-btn" style={{ marginTop: 6 }} onClick={() => setFixEditsExpanded(!fixEditsExpanded)}>{fixEditsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Surgical Edits{valAutoFixed ? " (applied)" : ""}</button>
              {fixEditsExpanded && <pre className="pipe-pre">{pipeline.step2.fixEdits}</pre>}
            </>}
          </>}
          {!pipeline.step2?.result && pipeline.step2?.status !== "failed" && <div style={{ color: "var(--text2)", fontSize: 12 }}>Validation did not run (seed generation failed)</div>}
        </div>}

        {tab === "seed" && <div className="pipe-seed">
          <div className="pipe-seed-header">
            <span className="pipe-seed-version">STATE_SEED v{pipeline.toVersion}{valAutoFixed ? " (auto-fixed)" : ""}</span>
            {pipeline.step1?.usage && <span style={{ fontSize: 10, color: "var(--text2)" }}>↓{(pipeline.step1.usage.input_tokens || 0).toLocaleString()} ↑{(pipeline.step1.usage.output_tokens || 0).toLocaleString()}</span>}
          </div>
          <textarea className="pipe-textarea" value={editedSeed} onChange={e => setEditedSeed(e.target.value)} spellCheck={false} />
        </div>}

        {tab === "sysprompt" && <div className="pipe-sysprompt">
          {pipeline.step3?.status === "skipped" && <div className="pipe-val-summary pass">No system prompt update template configured — skipped ✓</div>}
          {step3NoChanges && <div className="pipe-val-summary pass">No system prompt changes needed ✓</div>}
          {step3HasResults && !step3NoChanges && <>
            <div className={`pipe-val-summary ${step3Applied ? "pass" : "fail"}`}>
              {step3Applied ? "System prompt changes applied" : "System prompt changes recommended"}
            </div>
            <button className="pipe-expand-btn" onClick={() => setDiffsExpanded(!diffsExpanded)}>{diffsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Recommended Changes</button>
            {diffsExpanded && <pre className="pipe-pre">{pipeline.step3.result}</pre>}
            {step3Applied && pipeline.step3.appliedResult && <textarea className="pipe-textarea" value={editedSysPrompt} onChange={e => setEditedSysPrompt(e.target.value)} spellCheck={false} style={{ marginTop: 8 }} />}
            {step3Applying && <div style={{ color: "var(--accent)", fontSize: 12, marginTop: 8 }}>Applying changes to system prompt... <span className="pipe-spinner" /></div>}
            {pipeline.step3?.applyStatus === "failed" && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>Failed to apply changes: {pipeline.step3.applyError}. Review the diffs above and apply manually in Campaign Manager.</div>}
          </>}
          {pipeline.step3?.status === "failed" && <div className="pipe-error">System prompt assessment failed: {pipeline.step3.error}</div>}
          {pipeline.step3?.status === "running" && <div style={{ color: "var(--text2)", fontSize: 12 }}>System prompt assessment still running...</div>}
          {pipeline.step3?.status === "pending" && <div style={{ color: "var(--text2)", fontSize: 12 }}>Did not run</div>}
          {pipeline.step3?.status === "cancelled" && <div style={{ color: "var(--text2)", fontSize: 12 }}>Cancelled</div>}
        </div>}
      </div>}

      {!hasAnyResult && (isFailed || isCancelled) && <div style={{ padding: 20, textAlign: "center", color: "var(--text2)" }}>No output was produced before the pipeline {isCancelled ? "was cancelled" : "failed"}.</div>}

      {/* Action buttons — always show on terminal states */}
      <div className="pipe-actions">
        {isComplete && pipeline.step1?.result && <button className="btn accent" onClick={() => onApprove(editedSeed, editedSysPrompt, true)}>Approve & Start New Session</button>}
        {isComplete && pipeline.step1?.result && <button className="btn" onClick={() => onApprove(editedSeed, editedSysPrompt, false)}>Approve & Save</button>}
        {/* Contextual retry buttons */}
        {valFailed && valFixFailed && pipeline.step1?.result && <button className="btn" onClick={() => onRetry("2fix")}>Retry Fix</button>}
        {valFailed && !valAutoFixed && !valFixRunning && !valFixFailed && pipeline.step1?.result && <button className="btn" onClick={() => onRetry(2)}>Re-run Validation</button>}
        {pipeline.step3?.status === "failed" && <button className="btn" onClick={() => onRetry(3)}>Re-run System Prompt Check</button>}
        {pipeline.step3?.applyStatus === "failed" && <button className="btn" onClick={() => onRetry(3)}>Retry System Prompt Apply</button>}
        <button className="btn" onClick={() => onRetry()}>Re-run Pipeline</button>
        <button className="btn red" onClick={onReject}>Dismiss</button>
      </div>
    </>}

    {/* Running state — cancel button */}
    {isRunning && <div style={{ padding: 20, textAlign: "center" }}><div style={{ color: "var(--text2)", marginBottom: 12 }}>Pipeline is running... You can close this and come back later.</div><button className="btn red" onClick={onCancel}>Cancel Pipeline</button></div>}
  </div>);
}
