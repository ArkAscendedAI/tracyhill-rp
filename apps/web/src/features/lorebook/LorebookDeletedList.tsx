import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import type { LorebookDeletedEntry } from "@tracyhill-rp/contracts";

import { Icon } from "../../shared/ui/Icon";
import { QueryError } from "../../shared/ui/QueryError";
import { getDeletedLorebookEntries, revertEntry } from "./lorebookApi";
import { SOURCE_LABELS, relativeTime } from "./LorebookHistory";

type Props = {
  campaignId: string;
  campaignName: string;
  /** Called after a restore with the campaign it ran on; the panel refreshes that campaign's lists. */
  onRestored: (entry: LorebookDeletedEntry, campaignId: string) => void;
};

/**
 * The lorebook panel's "Recently deleted" view: a campaign's deleted entries,
 * newest first, each restorable from the snapshot taken when it was deleted. The API could
 * always bring an entry back (revert recreates a deleted row) but nothing listed them. Restore
 * asks for a second click, like History's Revert.
 */
export function LorebookDeletedList({ campaignId, campaignName, onRestored }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const deleted = useQuery({
    queryKey: ["lorebook-deleted", campaignId],
    queryFn: () => getDeletedLorebookEntries(campaignId),
  });
  // The campaign is pinned at click time, so a switch while it runs refreshes the right lists.
  const restore = useMutation({
    mutationFn: ({ entry }: { entry: LorebookDeletedEntry; campaignId: string }) => revertEntry(entry.entryId, entry.revisionId),
    onSuccess: (_result, vars) => { setConfirmId(null); setError(""); onRestored(vars.entry, vars.campaignId); },
    onError: (e) => setError(e instanceof Error ? e.message : "restore failed"),
  });
  const list = deleted.data?.entries ?? [];

  return (
    <div className="lorebook-deleted">
      <p className="muted small-copy">
        Entries deleted from {campaignName}, newest first. Restore brings one back as it was when it was deleted, under the
        same id, and embeds it again.
      </p>
      <QueryError query={deleted} label="Unable to load the deleted entries" />
      {error ? <div role="alert" className="error small-copy">{error}</div> : null}
      {deleted.isLoading ? <p className="muted small-copy">Loading…</p> : null}
      {deleted.isSuccess && list.length === 0 ? <p className="muted small-copy">No deleted entry of this campaign can be restored.</p> : null}
      {list.length > 0 ? (
        <ul className="lorebook-deleted-list">
          {list.map((entry) => (
            <li key={entry.entryId} className="lorebook-deleted-item">
              <div className="lorebook-deleted-head">
                <span className="lorebook-deleted-name">{entry.name}</span>
                {entry.tag ? <span className="lorebook-tag-badge">{entry.tag}</span> : null}
                <span className="muted lorebook-deleted-meta" title={new Date(entry.deletedAt).toLocaleString()}>
                  deleted {relativeTime(entry.deletedAt)} · {SOURCE_LABELS[entry.source] ?? entry.source}{entry.wasEnabled ? "" : " · was disabled"}
                </span>
                {confirmId === entry.entryId ? (
                  <span className="row gap-sm">
                    <button type="button" className="secondary-button" onClick={() => restore.mutate({ entry, campaignId })} disabled={restore.isPending}>
                      {restore.isPending ? "Restoring…" : "Confirm restore"}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setConfirmId(null)} disabled={restore.isPending}>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="ghost-button" onClick={() => { setConfirmId(entry.entryId); setError(""); }} title="Bring this entry back as it was when it was deleted">
                    <Icon name="archive-restore" size={13} /> Restore
                  </button>
                )}
              </div>
              <p className="lorebook-deleted-preview">
                {entry.contentPreview}{entry.contentChars > entry.contentPreview.length ? "…" : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
