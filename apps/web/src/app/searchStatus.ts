// The workspace search panel's status line and result list (AppShell).

export type SearchView = {
  /** At least two characters typed. */
  active: boolean;
  loading: boolean;
  /** The search request failed. */
  failed: boolean;
  resultCount: number;
};

/**
 * The status line beside the panel's heading. A failed search prints no count: "0 matches" above the error read as a
 * search that found nothing (Android's `searchStatusLabel`). It shows only its error.
 */
export function searchStatusLabel(view: SearchView): string {
  if (!view.active) return "Type 2+ characters";
  if (view.failed) return "";
  return view.loading ? "Searching..." : `${view.resultCount} matches`;
}

/** Whether the result list shows: only for a search that answered, never beside a failure. */
export function searchShowsResults(view: SearchView): boolean {
  return view.active && !view.failed && !view.loading && view.resultCount > 0;
}
