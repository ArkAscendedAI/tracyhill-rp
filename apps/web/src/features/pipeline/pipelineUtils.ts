import type { PipelineRetryMode, PipelineRunStatus, PipelineStepStatus } from "@tracyhill-rp/contracts";

export function formatPipelineStatus(status: PipelineRunStatus | "approved") {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "completed": return "Ready for review";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    case "approved": return "Approved";
    default: return status;
  }
}

export function formatPipelineStepStatus(status: PipelineStepStatus | string) {
  switch (status) {
    case "pending": return "Pending";
    case "running": return "Running…";
    case "completed": return "Complete";
    case "failed": return "Failed";
    default: return status;
  }
}

export function formatRetryMode(mode: PipelineRetryMode | null | undefined) {
  if (!mode) return "full run";
  switch (mode) {
    case "full": return "full run";
    case "fromLorebookRefresh": return "lorebook refresh";
    case "fromSysprompt": return "sysprompt update";
    default: return String(mode);
  }
}
