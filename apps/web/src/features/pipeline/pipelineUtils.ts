import type { ActivePipelineRun, PipelineRun, PipelineRunStatus } from "@tracyhill-rp/contracts";

// ONE status vocabulary for every pipeline surface (activity bar, drawer,
// campaign editor). The approval-era "Ready for review" / "Approved" labels
// described the sunset campaign_review flow — a completed run is simply
// complete, and nothing can be approved.
export function formatPipelineStatus(status: PipelineRunStatus): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    default: return status;
  }
}

// Labels for the LIVE pipeline kinds — the lane pick in
// pipelineRunRepository + enqueueRecap are the writers. The retired
// `campaign_review` and the never-existent `wizard_v3` (wizard runs live in
// wizard_runs, not this queue) were dropped 2026-09-02. An unknown
// kind renders as its raw id so a new worker kind is visible, never hidden.
const PIPELINE_KIND_LABELS: Record<string, string> = {
  rolling_diff: "Lorebook Sync",
  repetition_detection: "Pattern Scan",
  sysprompt_audit: "Prompt Audit",
  thread_tracker: "Thread Tracker",
  lorebook_consolidation: "Consolidation",
  lorebook_archival: "Archival",
  drive_update: "Drive Update",
  world_tick: "World Tick",
  recap: "Recap",
  campaign_audit: "Campaign Audit",
  audit_ruling: "Audit Rulings",
};

export function formatPipelineKind(kind: string | null | undefined): string | null {
  if (!kind) return null;
  return PIPELINE_KIND_LABELS[kind] ?? kind;
}

// Cancel Run asks first on every surface; Android copies these strings exactly. The body
// follows the pipeline docs: a queued run never starts and a running one aborts its model call, a
// canceled run is terminal and cannot be resumed (status-guarded; an audit's checkpoints end with the run),
// and writes it already committed stand, each revisioned (Living World, the audit's ruling executor).
export type CancelRunTarget = { campaignId: string; runId: string; campaignName: string; kind?: string | null };

export const CANCEL_RUN_TITLE = "Cancel this run?";
export const CANCEL_RUN_CONFIRM = "Cancel run";
export const CANCEL_RUN_KEEP = "Keep running";

export function cancelRunConfirmBody(run: { kind?: string | null; campaignName: string }): string {
  const kind = formatPipelineKind(run.kind);
  return `Canceling stops the ${kind ? `${kind} run` : "pipeline run"} for "${run.campaignName}" and cannot be undone, but anything the run has already saved stays.`;
}

export function cancelTargetOf({ campaignId, campaignName, run }: ActivePipelineRun): CancelRunTarget {
  return { campaignId, campaignName, runId: run.id, kind: run.kind ?? null };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// What the review drawer should show for the run the user clicked.
// The run's OWN row in the campaign history (`/campaigns/:id/runs`, polled
// while the drawer is open) decides; `/api/pipeline/active` is only the
// fresher copy of a live row. Absence from `/active` means nothing: it lists
// ONE row per campaign, so a second queued/running job of the same campaign
// drops out of it while it runs.
//   active  — its own status is queued/running: show the live row from
//             /active when it is there, else the history row.
//   loading — the history has not arrived and the run is not in /active.
//             Show the click-time snapshot WITHOUT the running affordances
//             (no Cancel) rather than pretending it still runs.
//   settled — its own status is terminal: the final row replaces the snapshot.
//   missing — gone from both lists (deleted): the caller closes the drawer.
export type DrawerRunPhase = "active" | "loading" | "settled" | "missing";

export function isRunLive(status: PipelineRunStatus): boolean {
  return status === "queued" || status === "running";
}

/** Live rows by status for the bar's chips — a queued row is not "running". */
export function countActiveRuns(entries: ReadonlyArray<ActivePipelineRun>): { running: number; queued: number } {
  let running = 0;
  let queued = 0;
  for (const { run } of entries) {
    if (run.status === "running") running += 1;
    else if (run.status === "queued") queued += 1;
  }
  return { running, queued };
}

export function resolveDrawerRun(
  watched: ActivePipelineRun | null,
  activeRuns: ActivePipelineRun[],
  campaignRuns: PipelineRun[] | undefined,
): { entry: ActivePipelineRun | null; phase: DrawerRunPhase } {
  if (!watched) return { entry: null, phase: "missing" };
  const live = activeRuns.find((r) => r.run.id === watched.run.id);
  const own = campaignRuns?.find((r) => r.id === watched.run.id);
  if (own) {
    if (isRunLive(own.status)) return { entry: live ?? { ...watched, run: own }, phase: "active" };
    return { entry: { ...watched, run: own }, phase: "settled" };
  }
  if (live) return { entry: live, phase: "active" };
  if (!campaignRuns) return { entry: watched, phase: "loading" };
  return { entry: null, phase: "missing" };
}
