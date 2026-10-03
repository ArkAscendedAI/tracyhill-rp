import type { PipelineRunRepository } from "../../../api/src/domain/pipeline/pipelineRunRepository";

/**
 * Guarded completion. `markCompleted` refuses a row that is
 * no longer `running` (the owner canceled it, or the stale sweep failed it) and
 * says so by returning false; `approvedAt` is stamped only when it returned
 * true. Archival, consolidation and the tracker's side paths used to stamp it
 * unconditionally, so a canceled row could carry an `approved_at`, which has
 * live consumers (the cancel route refuses an approved run; the campaign panel
 * shows "Approved"). The rolling diff and the tracker's main path stamp inside
 * their write transaction instead and throw when the completion is refused.
 */
export function completeRun(
  runs: Pick<PipelineRunRepository, "markCompleted" | "updateRun">,
  runId: string,
  at: string,
  summary: string,
  detailsJson: string | null,
): boolean {
  const completed = runs.markCompleted(runId, at, summary, detailsJson);
  if (completed) runs.updateRun(runId, { approvedAt: at });
  return completed;
}
