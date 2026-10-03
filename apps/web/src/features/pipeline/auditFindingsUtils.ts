import { AUDIT_RULING_MAX_CHARS, AUDIT_RULINGS_PER_SUBMIT_MAX, type AuditFinding } from "@tracyhill-rp/contracts";

// Which rulings a submit carries.
//
// A finding the executor BOUNCED keeps the ruling it could not implement,
// shown in the textarea beside the executor's question so the owner can
// amend it. Submitting every non-empty textarea re-sent that untouched text
// with any partial submit: the executor re-ran a ruling it had already
// bounced (max effort, ~15 min on the bridge) and bounced it again, and the
// "N of M ruled" counter counted it. A bounced finding counts only once its
// text differs from the preserved ruling. A finding reopened by a failed or
// canceled run carries no `executorQuestion` (a submit nulls it; only a
// bounce sets it), so its preserved ruling still counts — re-sending it
// unchanged is exactly what the owner wants there.
type RulingFinding = Pick<AuditFinding, "id" | "ruling" | "executorQuestion">;

export function rulingDraftFor(finding: Pick<AuditFinding, "id" | "ruling">, drafts: Record<string, string>): string {
  return drafts[finding.id] ?? finding.ruling ?? "";
}

export function isRulingReady(finding: Pick<AuditFinding, "ruling" | "executorQuestion">, draft: string): boolean {
  const text = draft.trim();
  if (!text) return false;
  if (finding.executorQuestion != null && text === (finding.ruling ?? "").trim()) return false;
  return true;
}

/** A bounced finding whose ruling text has not been edited yet. */
export function isUneditedBounce(finding: Pick<AuditFinding, "ruling" | "executorQuestion">, draft: string): boolean {
  return finding.executorQuestion != null && draft.trim().length > 0 && draft.trim() === (finding.ruling ?? "").trim();
}

export function pendingRulings(findings: RulingFinding[], drafts: Record<string, string>): Array<{ findingId: string; ruling: string }> {
  return findings
    .map((finding) => ({ findingId: finding.id, ruling: rulingDraftFor(finding, drafts).trim(), finding }))
    .filter(({ finding, ruling }) => isRulingReady(finding, ruling))
    .map(({ findingId, ruling }) => ({ findingId, ruling }));
}

export type RulingsSubmitPlan = {
  /** What Submit sends: the first AUDIT_RULINGS_PER_SUBMIT_MAX ready rulings, in queue order. */
  batch: Array<{ findingId: string; ruling: string }>;
  /** Every ready ruling: the batch and those that wait for the next submit. */
  readyCount: number;
  /** Ready rulings over AUDIT_RULING_MAX_CHARS after trimming, each marked on its own card. */
  overLong: Array<{ findingId: string; length: number }>;
  /** The over-long rulings inside the batch: Submit waits until they are shortened. One past the batch waits with its
   *  draft and holds nothing. */
  batchOverLong: Array<{ findingId: string; length: number }>;
};

/**
 * What Submit sends, checked against the contract's caps before it goes:
 * submitAuditRulingsRequestSchema takes 1 to 50 rulings, each 1 to 4,000 characters after trimming, and the open
 * queue is unbounded. Every ready ruling used to go at once, so 51 of them, or one pasted past 4,000 characters,
 * came back as the bare 400 "invalid rulings request". Now the first 50 go and the rest keep their drafts for the
 * next submit, and an over-long ruling is named so the owner can shorten it.
 * Submit now waits only for an over-long ruling inside the batch: one past the 50th keeps its marker and waits for
 * a later submit with its draft, and the first 50 go.
 */
export function planRulingsSubmit(findings: RulingFinding[], drafts: Record<string, string>): RulingsSubmitPlan {
  const ready = pendingRulings(findings, drafts);
  const batch = ready.slice(0, AUDIT_RULINGS_PER_SUBMIT_MAX);
  const tooLong = (rulings: typeof ready) => rulings.filter((r) => r.ruling.length > AUDIT_RULING_MAX_CHARS).map((r) => ({ findingId: r.findingId, length: r.ruling.length }));
  return {
    batch,
    readyCount: ready.length,
    overLong: tooLong(ready),
    batchOverLong: tooLong(batch),
  };
}
