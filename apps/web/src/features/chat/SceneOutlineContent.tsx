import type { SceneOutlineEntry, SceneOutlineResponse } from "@tracyhill-rp/contracts";

import { QueryError } from "../../shared/ui/QueryError";

type OutlineQuery = {
  data: SceneOutlineResponse | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

type Props = {
  query: OutlineQuery;
  /** The outline filtered by `search` and grouped by consecutive date (SessionConversation's `sceneGroups`). */
  groups: Array<{ date: string | null; entries: SceneOutlineEntry[] }>;
  search: string;
  onSearch: (value: string) => void;
  onJump: (entry: SceneOutlineEntry) => void;
  /** A scene jump is loading: every row waits for it. */
  jumpBusy: boolean;
};

/**
 * The body of the Scenes popover: the session's scene breaks, filterable, grouped by date; a row jumps to its scene.
 * A failed re-read keeps the loaded outline (react-query keeps `data` beside the error), so the failure is a line
 * above the list with a Retry; testing the error first used to replace a good outline. Only a first read
 * that failed shows the failure alone.
 */
export function SceneOutlineContent({ query, groups, search, onSearch, onJump, jumpBusy }: Props) {
  if (!query.data) {
    return query.isError
      ? <QueryError query={query} label="Unable to load the scene outline" />
      : <p style={{ margin: 0, color: "var(--text2)" }}>Loading scene outline…</p>;
  }
  const failure = <QueryError query={query} label="Unable to refresh the scene outline (showing the last read)" />;
  return query.data.entries.length === 0 ? (
    <>
      {failure}
      <p style={{ margin: 0, color: "var(--text2)" }}>No scene breaks recorded in this session yet.</p>
    </>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {failure}
      <input
        type="text"
        className="lorebook-search"
        placeholder="Filter scenes by location or date…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        autoFocus
      />
      {groups.length === 0 ? (
        <p style={{ margin: 0, color: "var(--text2)", fontSize: 12 }}>No scenes match “{search.trim()}”.</p>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 380, overflowY: "auto" }}>
      {groups.map((group, gi) => (
        <div key={`${group.date ?? "undated"}-${gi}`} className="popover-section">
          <div className="popover-section-title">{group.date ?? "Undated"}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {group.entries.map((entry) => (
              <div key={entry.messageId}>
                <button
                  type="button"
                  className="ghost-button"
                  style={{ display: "flex", gap: 8, alignItems: "baseline", width: "100%", textAlign: "left" }}
                  onClick={() => onJump(entry)}
                  disabled={jumpBusy}
                  title={entry.date || entry.time ? [entry.date, entry.time].filter(Boolean).join(" — ") : entry.location}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.location}</span>
                  {entry.turns > 1 ? <span className="muted small-copy" style={{ flexShrink: 0 }}>{entry.turns} turns</span> : null}
                  {entry.time ? <span className="muted small-copy" style={{ flexShrink: 0 }}>{entry.time}</span> : null}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}
