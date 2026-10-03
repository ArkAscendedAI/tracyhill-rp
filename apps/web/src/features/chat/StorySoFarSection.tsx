import type { RecapStatusResponse } from "@tracyhill-rp/contracts";

import { renderMarkdown } from "../../shared/markdown/renderMarkdown";
import { QueryError } from "../../shared/ui/QueryError";

type RecapQuery = {
  data: RecapStatusResponse | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

/** The toast after the Recap button queued a run (plain sentences, no dash pause). */
export const RECAP_QUEUED_TOAST = "Recap queued. The story so far will appear in the Campaign popover.";

type Props = {
  /** The session's latest recap run (GET …/recap), read while the Campaign popover is open. */
  query: RecapQuery;
  /** A recap is being enqueued, queued or running. */
  busy: boolean;
  onRecap: () => void;
};

/**
 * The Campaign popover's "Story So Far" section: the newest "Previously on…" recap and the Recap button.
 * "No recap yet" is claimed only after a read that found none. A failed status read used to fall through to that
 * line, although a recap may exist and a click spends a model run; it now names the failure with a Retry,
 * and a failed re-read keeps the loaded recap with the failure above it.
 */
export function StorySoFarSection({ query, busy, onRecap }: Props) {
  const data = query.data;
  return (
    <div className="popover-section">
      <div className="popover-section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1 }}>Story So Far</span>
        <button
          type="button"
          className="ghost-button"
          style={{ fontSize: 11 }}
          onClick={onRecap}
          disabled={busy}
          title="Generate a 'Previously on…' recap from the recent transcript (uses the campaign's rolling model)"
        >
          {busy ? "Generating…" : "Recap"}
        </button>
      </div>
      <QueryError query={query} label={data ? "Unable to refresh the recap status (showing the last read)" : "Unable to load the recap status"} />
      {busy ? (
        <p className="muted small-copy" style={{ margin: 0 }}>Recap {data?.status === "running" ? "running" : "queued"} — this can take a minute…</p>
      ) : data?.status === "failed" ? (
        <p className="error" style={{ margin: 0, fontSize: 12 }}>Recap failed: {data.error ?? "unknown error"}</p>
      ) : data?.recap ? (
        <div
          className="msg-body"
          style={{ maxHeight: 260, overflowY: "auto", fontSize: 12 }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(data.recap) }}
        />
      ) : data ? (
        <p className="muted small-copy" style={{ margin: 0 }}>No recap yet. Click Recap to generate a "Previously on…" summary of recent events.</p>
      ) : query.isError ? null : (
        <p className="muted small-copy" style={{ margin: 0 }}>Loading the recap…</p>
      )}
      {!busy && data?.recap && data.completedAt ? (
        <p className="muted small-copy" style={{ margin: "4px 0 0" }}>generated {new Date(data.completedAt).toLocaleString()}</p>
      ) : null}
    </div>
  );
}
