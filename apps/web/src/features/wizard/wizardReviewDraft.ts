import {
  buildCanonicalPcProtectionBlock,
  findNonCanonicalStrippedLines,
  stampCanonicalPcProtectionBlock,
  stripWizardPcProtectionSections,
  type WizardRun,
} from "@tracyhill-rp/contracts";

// Review-dialog draft model. Section A
// is canonical: the server re-stamps it at approval and REFUSES (400) a draft
// whose Section A block carries non-canonical text. The dialog therefore
// edits only the generated BODY and shows Section A read-only beside it, so
// the user cannot type into the block that would trip the 400.
export type ReviewDrafts = {
  campaignName: string;
  // The prompt with every Section A block / PLAYER_CHARACTER marker removed.
  systemPromptBody: string;
};

export function seedReviewDrafts(run: WizardRun | null): ReviewDrafts {
  const raw = run?.review.systemPromptDraft ?? run?.steps.systemPrompt.result ?? "";
  return {
    campaignName: run?.review.campaignName ?? "",
    systemPromptBody: raw ? stripWizardPcProtectionSections(raw) : "",
  };
}

// The immutable block exactly as approval will stamp it.
export function sectionAFor(run: WizardRun): string {
  return buildCanonicalPcProtectionBlock(run.review.playerCharacterName);
}

// Lines the server would drop from this body — non-empty means approval
// would 400. Only reachable if the user pastes a `## Section A:` heading
// back into the body textarea and writes under it.
export function draftConflicts(body: string, playerCharacterName: string | null | undefined): string[] {
  return findNonCanonicalStrippedLines(body, playerCharacterName);
}

// The full prompt sent on approve: canonical Section A + the edited body.
// Identical to what the server produces, so the re-stamp is a no-op.
export function buildApprovalPrompt(body: string, playerCharacterName: string | null | undefined): string {
  return stampCanonicalPcProtectionBlock(body, playerCharacterName);
}
