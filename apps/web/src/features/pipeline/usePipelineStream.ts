import { useEffect, useRef, useState } from "react";

import { streamPipelineRun, type PipelineStreamEvent, type PipelineStreamStep } from "./pipelineApi";

export type PipelineStepStreamState = {
  status: "idle" | "running" | "completed" | "failed";
  text: string;
  thinking: string;
  error: string | null;
};

export type PipelineStreamState = {
  connected: boolean;
  currentStep: PipelineStreamStep | null;
  steps: Record<PipelineStreamStep, PipelineStepStreamState>;
  runError: string | null;
  runComplete: boolean;
};

const EMPTY_STEP: PipelineStepStreamState = { status: "idle", text: "", thinking: "", error: null };
const INITIAL: PipelineStreamState = {
  connected: false,
  currentStep: null,
  runError: null,
  runComplete: false,
  steps: {
    analysis: { ...EMPTY_STEP },
    lorebookRefresh: { ...EMPTY_STEP },
    syspromptUpdate: { ...EMPTY_STEP },
  },
};

export function usePipelineStream(runId: string | null) {
  const [state, setState] = useState<PipelineStreamState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!runId) { setState(INITIAL); return; }
    setState({ ...INITIAL });
    const abort = new AbortController();
    abortRef.current = abort;

    const handle = (event: PipelineStreamEvent) => {
      if (event.type === "step_start") {
        setState((c) => ({
          ...c,
          connected: true,
          currentStep: event.step,
          steps: { ...c.steps, [event.step]: { status: "running", text: "", thinking: "", error: null } },
        }));
        return;
      }
      if (event.type === "step_delta") {
        setState((c) => ({
          ...c,
          steps: { ...c.steps, [event.step]: { ...c.steps[event.step], status: "running", text: c.steps[event.step].text + event.delta } },
        }));
        return;
      }
      if (event.type === "step_thinking_delta") {
        setState((c) => ({
          ...c,
          steps: { ...c.steps, [event.step]: { ...c.steps[event.step], status: "running", thinking: c.steps[event.step].thinking + event.delta } },
        }));
        return;
      }
      if (event.type === "step_complete") {
        setState((c) => ({
          ...c,
          steps: { ...c.steps, [event.step]: { ...c.steps[event.step], status: "completed", text: event.result, error: null } },
        }));
        return;
      }
      if (event.type === "step_error") {
        setState((c) => ({
          ...c,
          steps: { ...c.steps, [event.step]: { ...c.steps[event.step], status: "failed", error: event.error } },
        }));
        return;
      }
      if (event.type === "run_complete") {
        setState((c) => ({ ...c, runComplete: true, currentStep: null }));
        return;
      }
      if (event.type === "run_error") {
        setState((c) => ({ ...c, runError: event.error, currentStep: null }));
        return;
      }
    };

    void streamPipelineRun(runId, handle, abort.signal)
      .then(() => {
        if (abort.signal.aborted) return;
        // EOF without a terminal event (proxy timeout, server restart) used to
        // leave the panel on "Streaming…" forever with no error or reconnect.
        setState((c) => (c.runComplete || c.runError
          ? c
          : { ...c, runError: "Stream ended before the run completed — refresh to see the latest state", currentStep: null }));
      })
      .catch((err) => {
        if (abort.signal.aborted) return;
        setState((c) => ({ ...c, runError: err instanceof Error ? err.message : "pipeline stream failed", currentStep: null }));
      });

    return () => { try { abort.abort(); } catch {} };
  }, [runId]);

  return state;
}
