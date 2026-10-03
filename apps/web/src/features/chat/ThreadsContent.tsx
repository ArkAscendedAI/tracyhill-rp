import { THREAD_INDEX_ENTRY_NAME } from "@tracyhill-rp/contracts";

import { QueryError } from "../../shared/ui/QueryError";

// --- Thread tracker (read-only render of the "threads"-tagged lorebook entries) ---
type UiThread = {
  id: string; title: string; headline: string; status: string;
  summary: string; nextBeat: string; pendingDates: string;
  involved: string[]; log: string[]; openedDate: string; lastUpdatedDate: string;
};
type ThreadIndexEntry = { name: string; isConstant: boolean; comment: string | null };

const THREAD_PENDING = new Set(["OPEN", "ACTIVE", "STALLED"]);

/** Parse the canonical thread JSON from the constant Thread Index entry's `comment` field. */
export function parseThreadTracker(entries: ThreadIndexEntry[]): { threads: UiThread[]; active: number } {
  const index = entries.find(e => e.name === THREAD_INDEX_ENTRY_NAME && e.isConstant);
  if (!index?.comment) return { threads: [], active: 0 };
  try {
    const parsed = JSON.parse(index.comment);
    const raw = Array.isArray(parsed?.threads) ? parsed.threads : [];
    const threads: UiThread[] = raw.filter((t: any) => t && typeof t.id === "string").map((t: any) => ({
      id: String(t.id), title: String(t.title ?? ""), headline: String(t.headline ?? ""),
      status: String(t.status ?? "").toUpperCase(), summary: String(t.summary ?? ""),
      nextBeat: String(t.nextBeat ?? ""), pendingDates: String(t.pendingDates ?? ""),
      involved: Array.isArray(t.involved) ? t.involved.map(String) : [],
      log: Array.isArray(t.log) ? t.log.map(String) : [],
      openedDate: String(t.openedDate ?? ""), lastUpdatedDate: String(t.lastUpdatedDate ?? ""),
    }));
    return { threads, active: threads.filter(t => THREAD_PENDING.has(t.status)).length };
  } catch { return { threads: [], active: 0 }; }
}

/** The chat's thread-index read, as react-query holds it. */
export type ThreadsQuery = {
  data: { entries: ThreadIndexEntry[] } | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

/**
 * The body of the chat's Threads popover: the tracker's threads, pending ones first. A first read that failed shows the
 * failure alone with Retry, never "No threads tracked yet…"; a failed re-read keeps the last read's threads with the
 * failure above them.
 */
export function ThreadsContent({ query }: { query: ThreadsQuery }) {
  if (!query.data) {
    return query.isError
      ? <QueryError query={query} label="Unable to load the thread tracker" />
      : <p style={{ margin: 0, color: "var(--text2)" }}>Loading the thread tracker…</p>;
  }
  const threadData = parseThreadTracker(query.data.entries);
  const failure = <QueryError query={query} label="Unable to refresh the thread tracker (showing the last read)" />;
  return threadData.threads.length === 0 ? (
    <>
      {failure}
      <p style={{ margin: 0, color: "var(--text2)" }}>
        No threads tracked yet. The thread tracker builds itself as the campaign's pipeline runs.
      </p>
    </>
  ) : (
    <div className="thread-list">
      {failure}
      {[...threadData.threads]
        .sort((a, b) => {
          const pa = THREAD_PENDING.has(a.status) ? 0 : 1;
          const pb = THREAD_PENDING.has(b.status) ? 0 : 1;
          return pa - pb;
        })
        .map((t) => (
          <div key={t.id} className={`thread-card thread-${t.status.toLowerCase()}`}>
            <div className="thread-card-head">
              <span className={`thread-status-badge thread-${t.status.toLowerCase()}`}>{t.status}</span>
              <span className="thread-card-title">{t.title}</span>
              <span className="thread-card-id">{t.id}</span>
            </div>
            <div className="thread-card-summary">{t.summary || t.headline}</div>
            {THREAD_PENDING.has(t.status) && t.nextBeat ? (
              <div className="thread-card-next"><strong>Next:</strong> {t.nextBeat}</div>
            ) : null}
            {t.pendingDates ? <div className="thread-card-dates">⏱ {t.pendingDates}</div> : null}
            <div className="thread-card-meta">
              {t.involved.length > 0 ? <span>{t.involved.join(", ")}</span> : null}
              {t.openedDate ? <span>opened {t.openedDate}</span> : null}
              {t.lastUpdatedDate ? <span>updated {t.lastUpdatedDate}</span> : null}
            </div>
            {t.log.length > 0 ? (
              <details className="thread-card-log">
                <summary>{t.log.length} log entries</summary>
                <ul>{t.log.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </details>
            ) : null}
          </div>
        ))}
    </div>
  );
}
