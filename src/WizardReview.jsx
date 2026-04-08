import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";

const STEP_LABELS = ["State Seed", "System Prompt", "Seed Update Prompt", "Sys Prompt Update"];
const STEP_KEYS = ["step1", "step2", "step3", "step4"];

function StepIndicator({ step, label, pipelineDone }) {
  const stuck = step.status === "running" && pipelineDone;
  const status = stuck ? "failed" : step.status;
  const icon = status === "complete" ? "✓" : status === "failed" || status === "cancelled" ? "✗" : status === "running" ? "●" : "○";
  const color = status === "complete" ? "var(--green)" : status === "failed" || status === "cancelled" ? "var(--red)" : status === "running" ? "var(--accent)" : "var(--text2)";
  return <div className="pipe-step" style={{ color }}><span className="pipe-step-icon">{icon}</span> {label} {status === "running" && <span className="pipe-spinner" />}{step.error && <span className="pipe-step-error"> — {step.error}</span>}</div>;
}

export default function WizardReview({ pipeline, onClose, onApprove, onRetry, onCancel }) {
  const [tab, setTab] = useState("step1");
  const [edited, setEdited] = useState({ step1: "", step2: "", step3: "", step4: "" });
  const [elapsed, setElapsed] = useState("");
  const intervalRef = useRef(null);
  // Initialize edited content from pipeline results — each step individually as results arrive
  useEffect(() => {
    setEdited(prev => {
      const next = { ...prev };
      let changed = false;
      for (const k of STEP_KEYS) { if (pipeline?.[k]?.result && !prev[k]) { next[k] = pipeline[k].result; changed = true; } }
      return changed ? next : prev;
    });
  }, [pipeline?.step1?.result, pipeline?.step2?.result, pipeline?.step3?.result, pipeline?.step4?.result]);

  // Elapsed timer
  useEffect(() => {
    if (!pipeline?.startedAt) return;
    function tick() {
      const start = new Date(pipeline.startedAt).getTime();
      const end = pipeline.completedAt ? new Date(pipeline.completedAt).getTime() : Date.now();
      const secs = Math.floor((end - start) / 1000);
      setElapsed(`${Math.floor(secs / 60)}m ${(secs % 60).toString().padStart(2, "0")}s`);
    }
    tick();
    if (!pipeline.completedAt) { intervalRef.current = setInterval(tick, 1000); return () => clearInterval(intervalRef.current); }
  }, [pipeline?.startedAt, pipeline?.completedAt]);

  if (!pipeline) return null;

  const isRunning = pipeline.status === "running";
  const isComplete = pipeline.status === "complete";
  const isFailed = pipeline.status === "failed";
  const isCancelled = pipeline.status === "cancelled";
  const hasAnyResult = STEP_KEYS.some(k => pipeline[k]?.result);
  const allComplete = STEP_KEYS.every(k => pipeline[k]?.status === "complete");
  const doneCount = STEP_KEYS.filter(k => pipeline[k]?.status === "complete" || pipeline[k]?.status === "skipped").length;

  return (<div className="pipeline-view">
    <div className="pipe-header">
      <h2>🪄 Campaign Wizard — {pipeline.campaignName || "New Campaign"}</h2>
      <button className="icon-btn" onClick={onClose}><X size={18} /></button>
    </div>

    <div className="pipe-meta">
      <span>Model: {pipeline.model}</span>
      <span>Elapsed: {elapsed}</span>
      {isRunning && <span style={{ color: "var(--accent)" }}>Phase {doneCount < 2 ? "1" : "2"}/2 — {doneCount}/4 steps</span>}
    </div>

    <div className="pipe-steps">
      {STEP_KEYS.map((k, i) => <StepIndicator key={k} step={pipeline[k] || {}} label={STEP_LABELS[i]} pipelineDone={!isRunning} />)}
    </div>

    {pipeline.error && <div className="pipe-error">{pipeline.error}</div>}

    {(isComplete || isFailed || isCancelled) && hasAnyResult && <>
      <div className="pipe-tabs">
        {STEP_KEYS.map((k, i) => pipeline[k]?.result && (
          <button key={k} className={`pipe-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {STEP_LABELS[i]} {pipeline[k]?.status === "complete" && <span style={{ color: "var(--green)" }}>✓</span>}
            {pipeline[k]?.status === "failed" && <span style={{ color: "var(--red)" }}>✗</span>}
          </button>
        ))}
      </div>

      <div className="pipe-tab-content">
        <div className="pipe-seed">
          <div className="pipe-seed-header">
            <span className="pipe-seed-version">{STEP_LABELS[STEP_KEYS.indexOf(tab)]}</span>
            {pipeline[tab]?.usage && <span style={{ fontSize: 10, color: "var(--text2)" }}>↓{(pipeline[tab].usage.input_tokens || 0).toLocaleString()} ↑{(pipeline[tab].usage.output_tokens || 0).toLocaleString()}</span>}
          </div>
          <textarea className="pipe-textarea" value={edited[tab] || ""} onChange={e => setEdited(p => ({ ...p, [tab]: e.target.value }))} spellCheck={false} />
        </div>
      </div>

      <div className="pipe-actions">
        {isComplete && allComplete && <button className="btn accent" onClick={() => onApprove(edited)}>Approve & Start Campaign</button>}
        <button className="btn" onClick={onRetry}>Re-run Pipeline</button>
        <button className="btn red" onClick={onCancel || onClose}>Dismiss</button>
      </div>
    </>}

    {(isComplete || isFailed || isCancelled) && !hasAnyResult && <div style={{ padding: 20, textAlign: "center", color: "var(--text2)" }}>No output was produced.</div>}

    {isRunning && <div style={{ padding: 20, textAlign: "center" }}>
      <div style={{ color: "var(--text2)", marginBottom: 12 }}>Generating campaign documents... You can close this and come back later.</div>
      <button className="btn red" onClick={onCancel}>Cancel</button>
    </div>}
  </div>);
}
