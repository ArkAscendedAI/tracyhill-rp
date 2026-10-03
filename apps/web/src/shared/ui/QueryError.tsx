type FailedQuery = { isError: boolean; error: unknown; refetch: () => Promise<unknown> };

/** A failed background read is distinct from a successful empty result. */
export function QueryError({ query, label = "Unable to load data" }: { query: FailedQuery; label?: string }) {
  if (!query.isError) return null;
  return <div role="alert" className="error small-copy">
    {label}: {query.error instanceof Error ? query.error.message : "Request failed"}{" "}
    <button type="button" className="ghost-button" onClick={() => void query.refetch()}>Retry</button>
  </div>;
}
