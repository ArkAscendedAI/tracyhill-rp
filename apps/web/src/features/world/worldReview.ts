import { proposedWorldEventSchema, type ProposedWorldEvent } from "@tracyhill-rp/contracts";

import { describeContractIssues } from "../lorebook/contractBounds";

// Contract field names of a proposed world event → the words the review shows.
const EVENT_FIELD_LABELS: Record<string, string> = {
  actors: "Actors", summary: "Summary", detail: "Detail", knownBy: "Known by", visibility: "Visibility",
  surfaceHints: "Surface hints", scheduledBeat: "Scheduled beat", supersedesEntryId: "Superseded entry", driveEffects: "Drive effects",
};

function eventFieldLabel(path: ReadonlyArray<string | number>): string {
  const [head, index] = path;
  const base = EVENT_FIELD_LABELS[String(head)] ?? (head == null ? "Event" : String(head));
  return typeof index === "number" ? `${base} #${index + 1}` : base;
}

/**
 * What keeps each kept event of a world-tick review from applying, by its place in the review list.
 * The review edits summaries and details, and nothing checked them: an emptied or over-long
 * summary went to the server, which answered "invalid apply request". Each event not vetoed is checked
 * against the apply contract here, so its card can name the field before Apply.
 */
export function reviewedEventProblems(events: ReadonlyArray<ProposedWorldEvent & { vetoed?: boolean }>): Map<number, string> {
  const problems = new Map<number, string>();
  events.forEach((event, index) => {
    if (event.vetoed) return;
    const { vetoed: _vetoed, ...candidate } = event;
    const parsed = proposedWorldEventSchema.safeParse(candidate);
    if (!parsed.success) problems.set(index, describeContractIssues(parsed.error.issues, eventFieldLabel));
  });
  return problems;
}
