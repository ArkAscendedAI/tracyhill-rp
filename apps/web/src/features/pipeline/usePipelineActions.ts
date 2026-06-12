import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  abandonPipelineRun,
  approvePipelineRun,
  cancelPipelineRun,
  enqueuePipelineRun,
  retryPipelineRun,
} from "./pipelineApi";

export function usePipelineActions() {
  const queryClient = useQueryClient();
  // Shared error surface — Approve/Cancel/Retry/Abandon used to fail with
  // zero feedback (the button blinked and nothing happened).
  const [lastError, setLastError] = useState<string | null>(null);
  const surface = (error: unknown) => setLastError(error instanceof Error ? error.message : "pipeline action failed");
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    void queryClient.invalidateQueries({ queryKey: ["pipeline-runs"] });
    void queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
    void queryClient.invalidateQueries({ queryKey: ["campaign-versions"] });
  };

  const approve = useMutation({
    mutationFn: (p: { campaignId: string; runId: string; startSession?: boolean }) =>
      approvePipelineRun(p.campaignId, p.runId, p.startSession),
    onSettled: invalidate,
    onError: surface,
    onMutate: () => setLastError(null),
  });
  const cancel = useMutation({
    mutationFn: (p: { campaignId: string; runId: string }) => cancelPipelineRun(p.campaignId, p.runId),
    onSettled: invalidate,
    onError: surface,
    onMutate: () => setLastError(null),
  });
  const retry = useMutation({
    mutationFn: (p: { campaignId: string; runId: string; fromStep?: "fromLorebookRefresh" | "fromSysprompt" }) =>
      retryPipelineRun(p.campaignId, p.runId, p.fromStep),
    onSettled: invalidate,
    onError: surface,
    onMutate: () => setLastError(null),
  });
  const abandon = useMutation({
    mutationFn: (p: { campaignId: string; runId: string }) => abandonPipelineRun(p.campaignId, p.runId),
    onSettled: invalidate,
    onError: surface,
    onMutate: () => setLastError(null),
  });
  const enqueue = useMutation({
    mutationFn: (campaignId: string) => enqueuePipelineRun(campaignId),
    onSettled: invalidate,
    onError: surface,
    onMutate: () => setLastError(null),
  });

  const busy =
    approve.isPending || cancel.isPending || retry.isPending || abandon.isPending || enqueue.isPending;

  return { approve, cancel, retry, abandon, enqueue, busy, lastError, clearError: () => setLastError(null) };
}
