import type { WizardRun, WizardRunStatus, WizardStepStatus } from "@tracyhill-rp/contracts";

import { sliceUnits } from "../../shared/text/sliceUnits";

// Shared by CampaignPanel's status card and WizardReviewDialog — the panel's
// private copy lacked the `canceled` branch and labelled a cancelled wizard
// "Failed".
export function formatWizardStatus(status: WizardRunStatus): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "completed": return "Completed";
    case "canceled": return "Canceled";
    case "failed": return "Failed";
    default: return status;
  }
}

export function formatWizardStepStatus(status: WizardStepStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    default: return status;
  }
}

const CORPUS_PREVIEW_UNITS = 200;

/**
 * The review's short preview of a corpus entry: its first 200 characters, "..." when there is more. The cut
 * backs off one unit when it would land between the two halves of a surrogate pair: `slice(0, 200)`
 * kept a lone high surrogate, which renders as a replacement glyph and copies as U+FFFD. The back-off is the
 * shared `sliceUnits`.
 */
export function corpusEntryPreview(content: string): string {
  if (content.length <= CORPUS_PREVIEW_UNITS) return content;
  return `${sliceUnits(content, CORPUS_PREVIEW_UNITS)}...`;
}

/**
 * The Cancel Wizard confirmation (Cancel Run's rule for pipeline runs, applied to wizard runs):
 * one click used to cancel a run that may have worked for minutes. Every Cancel Wizard (the shell's activity panel, the
 * campaign panel's Wizard tab, the review dialog) asks first. The buttons are Cancel Run's ("Keep running", "Cancel
 * run"). Android uses the same text.
 */
export const CANCEL_WIZARD_TITLE = "Cancel this wizard run?";

export type CancelWizardTarget = { runId: string; name: string };

/** The run a confirmation is about, named as its card names it (a run enqueued from a wizard session may have none). */
export function cancelWizardTargetOf(run: Pick<WizardRun, "id"> & { review: Pick<WizardRun["review"], "campaignName"> }): CancelWizardTarget {
  return { runId: run.id, name: run.review.campaignName };
}

export function cancelWizardConfirmBody(name: string): string {
  const shown = name.trim();
  return shown
    ? `Canceling stops the wizard run for "${shown}" and cannot be undone.`
    : "Canceling stops this wizard run and cannot be undone.";
}
