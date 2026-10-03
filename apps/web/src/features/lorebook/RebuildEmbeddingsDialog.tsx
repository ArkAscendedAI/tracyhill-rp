import { useState } from "react";

import type { LorebookEmbeddingStatus } from "@tracyhill-rp/contracts";

import { Dialog } from "../../shared/ui/Dialog";

type Props = {
  campaignName: string;
  /** Display name of the embedding model the rebuild writes under. */
  modelLabel: string;
  status: LorebookEmbeddingStatus | undefined;
  pending: boolean;
  onClose: () => void;
  onRebuild: (staleOnly: boolean) => void;
};

/**
 * "Rebuild Embeddings" asks first: stale and missing
 * entries only (the default) or every enabled entry. The button used to start a full
 * rebuild on one click, re-embedding every entry however few had changed. The panel mounts
 * this only while it is open, so every opening starts on the default.
 */
export function RebuildEmbeddingsDialog({ campaignName, modelLabel, status, pending, onClose, onRebuild }: Props) {
  const [staleOnly, setStaleOnly] = useState(true);
  return (
    <Dialog
      open
      onClose={onClose}
      label="Rebuild embeddings"
      eyebrow="Rebuild embeddings"
      title={campaignName}
      icon="refresh"
      size="sm"
      zIndex={300}
      footer={<>
        <button type="button" className="secondary-button" onClick={onClose}>{pending ? "Close" : "Cancel"}</button>
        <button type="button" onClick={() => onRebuild(staleOnly)} disabled={pending}>{pending ? "Rebuilding…" : "Rebuild"}</button>
      </>}
    >
      <p className="muted small-copy">Embeddings let semantic and hybrid retrieval find entries by meaning. This campaign embeds with {modelLabel}.</p>
      {status ? (
        <p className="muted small-copy">
          Now: {status.indexed} of {status.totalEntries} enabled entries embedded{status.stale > 0 ? `, ${status.stale} of them stale` : ""}; {status.missing} missing.
        </p>
      ) : null}
      <div className="lorebook-rebuild-options" role="radiogroup" aria-label="What to rebuild">
        <label className={`lorebook-rebuild-option${staleOnly ? " active" : ""}`}>
          <input type="radio" name="lorebook-rebuild-scope" checked={staleOnly} onChange={() => setStaleOnly(true)} disabled={pending} />
          <span className="lorebook-rebuild-option-text">
            <span>Stale and missing only</span>
            <span className="lorebook-rebuild-option-hint">Embeds the entries that have no vector yet and the ones whose text changed since they were embedded. Unchanged entries are skipped.</span>
          </span>
        </label>
        <label className={`lorebook-rebuild-option${staleOnly ? "" : " active"}`}>
          <input type="radio" name="lorebook-rebuild-scope" checked={!staleOnly} onChange={() => setStaleOnly(false)} disabled={pending} />
          <span className="lorebook-rebuild-option-text">
            <span>Rebuild all</span>
            <span className="lorebook-rebuild-option-hint">Sends every enabled entry to the embedding provider again, changed or not.</span>
          </span>
        </label>
      </div>
      {pending ? <p className="muted small-copy">The rebuild keeps running if you close this; the result appears at the top of the lorebook panel.</p> : null}
    </Dialog>
  );
}
