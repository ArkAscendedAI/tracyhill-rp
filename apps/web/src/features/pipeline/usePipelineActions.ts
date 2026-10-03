import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { cancelPipelineRun } from "./pipelineApi";
import type { CancelRunTarget } from "./pipelineUtils";

// Cancel is the only run ACTION left: the campaign-review approve/retry/abandon
// surface sunset with the monolith (campaign-audit redesign) — audits auto-apply
// behind their adversarial tail and need no per-run decisions.
export function usePipelineActions() {
  const queryClient = useQueryClient();
  // The refusal stays until dismissed or replaced by the next cancel's result: `onMutate` clears it.
  const [lastError, setLastError] = useState<string | null>(null);
  // Cancel Run asks first: the run awaiting the answer.
  const [pendingCancel, setPendingCancel] = useState<CancelRunTarget | null>(null);
  const surface = (error: unknown) => setLastError(error instanceof Error ? error.message : "pipeline action failed");
  // Cancel touches the run row only — the approve-era `workspace-state` /
  // `campaign-versions` invalidations were dropped 2026-09-02.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    void queryClient.invalidateQueries({ queryKey: ["pipeline-runs"] });
    void queryClient.invalidateQueries({ queryKey: ["pipeline-queue-status"] });
  };

  const cancel = useMutation({
    mutationFn: (p: { campaignId: string; runId: string }) => cancelPipelineRun(p.campaignId, p.runId),
    onSettled: invalidate,
    onError: surface,
    onMutate: () => setLastError(null),
  });
  const busy = cancel.isPending;
  const confirmCancel = () => {
    if (!pendingCancel) return;
    setPendingCancel(null);
    cancel.mutate({ campaignId: pendingCancel.campaignId, runId: pendingCancel.runId });
  };

  return {
    cancel, busy, lastError, clearError: () => setLastError(null),
    pendingCancel, requestCancel: (target: CancelRunTarget) => setPendingCancel(target), keepRunning: () => setPendingCancel(null), confirmCancel,
  };
}
