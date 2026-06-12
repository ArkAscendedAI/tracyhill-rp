import { useEffect, useMemo, useState } from "react";

import type { PipelineArtifactKind, PipelineRunArtifact } from "@tracyhill-rp/contracts";

import { getPipelineRunArtifacts } from "./pipelineApi";

const KIND_ORDER: PipelineArtifactKind[] = ["prompt", "thinking", "response", "edits", "rendered", "registry"];
const KIND_LABELS: Record<PipelineArtifactKind, string> = {
  prompt: "Prompt",
  thinking: "Thinking",
  response: "Response",
  edits: "Edits",
  rendered: "Rendered",
  registry: "Registry",
};

export function PipelineContextModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; artifacts: PipelineRunArtifact[] }>({ loading: true, error: null, artifacts: [] });
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<PipelineArtifactKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPipelineRunArtifacts(runId)
      .then((r) => { if (!cancelled) setState({ loading: false, error: null, artifacts: r.artifacts }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e instanceof Error ? e.message : "failed to load artifacts", artifacts: [] }); });
    return () => { cancelled = true; };
  }, [runId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const stages = useMemo(() => Array.from(new Set(state.artifacts.map((a) => a.stage))), [state.artifacts]);
  const stage = activeStage ?? stages[0] ?? null;
  const stageArtifacts = useMemo(() => state.artifacts.filter((a) => a.stage === stage), [state.artifacts, stage]);
  const availableKinds = useMemo(() => KIND_ORDER.filter((k) => stageArtifacts.some((a) => a.kind === k)), [stageArtifacts]);
  const kind = activeKind && availableKinds.includes(activeKind) ? activeKind : (availableKinds[0] ?? null);
  const artifact = stageArtifacts.find((a) => a.kind === kind) ?? null;

  function copyContent() {
    if (!artifact) return;
    navigator.clipboard?.writeText(artifact.content).catch(() => {});
  }

  function downloadContent() {
    if (!artifact) return;
    const blob = new Blob([artifact.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${runId.slice(0, 8)}-${artifact.stage}-${artifact.kind}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pipeline-drawer-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="pipeline-context-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pipeline context & artifacts">
        <header className="pipeline-context-head">
          <div>
            <p className="eyebrow">Context &amp; Artifacts</p>
            <h3>Submitted to LLM</h3>
            <p className="muted small-copy">Run {runId.slice(0, 8)}… · {state.artifacts.length} artifact{state.artifacts.length === 1 ? "" : "s"}</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose} title="Close (Esc)">✕</button>
        </header>

        {state.loading ? <p className="muted small-copy">Loading artifacts…</p> : null}
        {state.error ? <p className="error small-copy">{state.error}</p> : null}
        {!state.loading && !state.error && state.artifacts.length === 0 ? (
          <p className="muted small-copy">No artifacts persisted for this run. They populate as new runs execute.</p>
        ) : null}

        {state.artifacts.length > 0 ? (
          <>
            <div className="pipeline-context-tabs">
              {stages.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`pipeline-context-tab ${s === stage ? "is-active" : ""}`}
                  onClick={() => { setActiveStage(s); setActiveKind(null); }}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="pipeline-context-subtabs">
              {availableKinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`pipeline-context-subtab ${k === kind ? "is-active" : ""}`}
                  onClick={() => setActiveKind(k)}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
            {artifact ? (
              <>
                <div className="pipeline-context-meta">
                  <span className="muted small-copy">{artifact.bytes.toLocaleString()} bytes · {new Date(artifact.createdAt).toLocaleString()}</span>
                  <div className="pipeline-context-actions">
                    <button type="button" className="secondary-button" onClick={copyContent}>Copy</button>
                    <button type="button" className="secondary-button" onClick={downloadContent}>Download</button>
                  </div>
                </div>
                <pre className="pipeline-context-pre">{artifact.content}</pre>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
