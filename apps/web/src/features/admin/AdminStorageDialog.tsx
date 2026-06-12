import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getAdminStorage, purgeAdminImages } from "./adminApi";

type AdminStorageDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function AdminStorageDialog({ open, onClose }: AdminStorageDialogProps) {
  const queryClient = useQueryClient();
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const storageQuery = useQuery({
    queryKey: ["admin-storage"],
    queryFn: getAdminStorage,
    enabled: open,
  });
  const purgeMutation = useMutation({
    mutationFn: purgeAdminImages,
    onSuccess: async () => {
      setConfirmingPurge(false);
      await queryClient.invalidateQueries({ queryKey: ["admin-storage"] });
      await queryClient.invalidateQueries({ queryKey: ["session-detail"] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
    },
  });

  if (!open) return null;

  const busy = storageQuery.isLoading || purgeMutation.isPending;
  const data = storageQuery.data;
  const lowSpace = data ? data.diskTotal > 0 && data.diskFree / data.diskTotal < 0.1 : false;

  return (
    <div className="dialog-backdrop">
      <div className="dialog-card" role="dialog" aria-modal="true" aria-label="Storage">
        <div className="stack stack-tight">
          <div className="section-head">
            <div>
              <p className="eyebrow">Admin</p>
              <h3>Storage</h3>
            </div>
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              Close
            </button>
          </div>
          {storageQuery.isLoading ? <p className="muted small-copy">Loading storage stats…</p> : null}
          {storageQuery.error ? <p className="error">{storageQuery.error.message}</p> : null}
          {data ? (
            <div className="stack stack-tight">
              <div className="stack stack-tight" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                <div className="section-head"><span className="muted">Disk Total</span><span>{formatGiB(data.diskTotal)}</span></div>
                <div className="section-head"><span className="muted">Disk Used</span><span style={{ color: lowSpace ? "var(--red)" : undefined }}>{formatGiB(data.diskUsed)} ({formatPercent(data.diskUsed, data.diskTotal)})</span></div>
                <div className="section-head"><span className="muted">Disk Free</span><span style={{ color: lowSpace ? "var(--red)" : "var(--green)" }}>{formatGiB(data.diskFree)}</span></div>
                <div className="section-head"><span className="muted">Images</span><span>{data.dataDir.imageCount} files ({formatMiB(data.dataDir.images)})</span></div>
                <div className="section-head"><span className="muted">User Data</span><span>{formatMiB(data.dataDir.users)}</span></div>
                <div className="section-head"><span className="muted">Data Total</span><span>{formatMiB(data.dataDir.total)}</span></div>
              </div>
              {confirmingPurge ? (
                <div className="stack stack-tight">
                  <p className="error">Purge all generated images across all users? This cannot be undone.</p>
                  <div className="row gap-sm end">
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingPurge(false)}>
                      Cancel
                    </button>
                    <button type="button" className="danger-button" disabled={busy} onClick={() => purgeMutation.mutate()}>
                      {purgeMutation.isPending ? "Purging..." : "Confirm Purge Images"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {purgeMutation.error ? <p className="error">{purgeMutation.error.message}</p> : null}
          <div className="row gap-sm end wrap-row">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => storageQuery.refetch()}>
              Refresh
            </button>
            <button type="button" className="danger-button" disabled={busy || !data?.dataDir.imageCount || confirmingPurge} onClick={() => setConfirmingPurge(true)}>
              Purge Images
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatGiB(value: number) {
  return `${(value / 1073741824).toFixed(2)} GB`;
}

function formatMiB(value: number) {
  return `${(value / 1048576).toFixed(1)} MB`;
}

function formatPercent(value: number, total: number) {
  if (!total) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}
