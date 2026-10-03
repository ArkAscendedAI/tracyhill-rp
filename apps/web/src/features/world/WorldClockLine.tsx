import type { WorldStatusQuery } from "./ScheduledBeatsList";
import { QueryError } from "../../shared/ui/QueryError";

/**
 * The Campaign popover's world line: where the world clock stands against the story. A first read that failed shows the
 * failure alone with Retry, never "World clock not initialized…", which is true only of a read that succeeded without a
 * clock; a failed re-read keeps the last read's line with the failure above it (as the Beats list does with the same
 * query).
 */
export function WorldClockLine({ query }: { query: WorldStatusQuery }) {
  if (!query.data) {
    return query.isError
      ? <QueryError query={query} label="Unable to load the world clock" />
      : <p className="muted small-copy" style={{ margin: 0 }}>Loading the world clock…</p>;
  }
  const { worldClock, gapDays } = query.data;
  return (
    <>
      <QueryError query={query} label="Unable to refresh the world clock (showing the last read)" />
      <p className="muted small-copy" style={{ margin: 0 }}>
        {worldClock
          ? <>Simulated through <strong>{worldClock.simulatedThrough}</strong>{gapDays != null && gapDays > 0 ? ` · ${gapDays}d behind the story` : " · caught up"}</>
          : <>World clock not initialized. The first tick sets it.</>}
      </p>
    </>
  );
}
