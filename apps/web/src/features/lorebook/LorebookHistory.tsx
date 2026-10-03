import { QueryError } from "../../shared/ui/QueryError";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { LorebookEntry, LorebookRevision } from "@tracyhill-rp/contracts";

import { DiffView } from "../../shared/ui/DiffView";
import { getRevisions, revertEntry } from "./lorebookApi";

/** What wrote a revision (shared with the Recently deleted view). */
export const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  rolling_diff: "Rolling diff",
  consolidation: "Consolidation",
  archival: "Archival",
  thread_tracker: "Thread tracker",
  world_tick: "World tick",
  campaign_audit: "Campaign audit",
  campaign_audit_ruling: "Audit ruling",
  import: "Import",
};

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Version-history view for a single lorebook entry. Lists captured pre-write
 * revisions (newest first) with a source badge + relative time, shows a unified
 * diff (revision content → current content) for the expanded revision, and a
 * two-click inline Revert that mirrors LorebookPanel's confirm pattern.
 * `readOnly` (tracker-owned entries): the history and diffs stay readable,
 * Revert is not offered (the tracker would overwrite a reverted text).
 */
export function LorebookHistory({ entry, campaignId, readOnly = false }: { entry: LorebookEntry; campaignId: string | null; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmRevertId, setConfirmRevertId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const revisions = useQuery({
    queryKey: ["lorebook-revisions", entry.id],
    queryFn: () => getRevisions(entry.id),
  });

  const revertMutation = useMutation({
    mutationFn: (revisionId: string) => revertEntry(entry.id, revisionId),
    onSuccess: () => {
      setConfirmRevertId(null);
      queryClient.invalidateQueries({ queryKey: ["lorebook-revisions", entry.id] });
      queryClient.invalidateQueries({ queryKey: ["lorebook-entries", campaignId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "revert failed"),
  });

  const list: LorebookRevision[] = revisions.data?.revisions ?? [];

  return (
    <div className="lorebook-history">
      <QueryError query={revisions} label="Unable to load revision history" />
      {error ? <div className="error" style={{ marginBottom: 8 }}>{error}</div> : null}
      {readOnly ? <p className="muted small-copy">Kept by the thread tracker: the history is shown, reverting is not offered.</p> : null}
      {revisions.isLoading ? (
        <p className="muted small-copy">Loading history…</p>
      ) : list.length === 0 ? (
        revisions.isSuccess ? <p className="muted small-copy">No prior revisions. Edits, rolling-diff updates, and other rewrites of this entry will appear here.</p> : null
      ) : (
        <ul className="lorebook-history-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {list.map((rev) => {
            const expanded = expandedId === rev.id;
            const confirming = confirmRevertId === rev.id;
            return (
              <li key={rev.id} className="lorebook-history-item" style={{ borderBottom: "1px solid var(--surface-border)", padding: "8px 0" }}>
                <div className="row gap-sm" style={{ alignItems: "center", justifyContent: "space-between" }}>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setExpandedId(expanded ? null : rev.id)}
                    style={{ textAlign: "left", flex: 1 }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 600 }}>#{rev.revisionNo}</span>{" "}
                    <span className="lorebook-source-badge" style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--surface)", border: "1px solid var(--surface-border)", color: "var(--muted)" }}>
                      {SOURCE_LABELS[rev.source] ?? rev.source}
                    </span>{" "}
                    <span className="muted" style={{ fontSize: 11 }}>{relativeTime(rev.createdAt)}</span>
                    {rev.pipelineRunId ? <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>run {rev.pipelineRunId.slice(0, 8)}</span> : null}
                  </button>
                  {readOnly ? null : confirming ? (
                    <span className="row gap-sm">
                      <button type="button" className="danger-button" disabled={revertMutation.isPending} onClick={() => revertMutation.mutate(rev.id)} style={{ fontSize: 11 }}>
                        Confirm revert
                      </button>
                      <button type="button" className="ghost-button" onClick={() => setConfirmRevertId(null)} style={{ fontSize: 11 }}>Cancel</button>
                    </span>
                  ) : (
                    <button type="button" className="ghost-button" onClick={() => { setConfirmRevertId(rev.id); setError(""); }} style={{ fontSize: 11 }} title="Restore this version (the current version is saved first)">
                      ↶ Revert
                    </button>
                  )}
                </div>
                {expanded ? (
                  <div style={{ marginTop: 6 }}>
                    <p className="muted" style={{ fontSize: 10, margin: "0 0 4px" }}>This revision → current content</p>
                    <DiffView oldText={rev.content} newText={entry.content} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
