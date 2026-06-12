import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { getClaudeCodeDoctor, listClaudeCodeMemory, readClaudeCodeMemory, writeClaudeCodeMemory } from "./claudeCodeApi";

// ─── Doctor modal ────────────────────────────────────────────────────────────

export function DoctorModal({ sessionId, open, onClose }: { sessionId: string | null; open: boolean; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["claude-code-doctor", sessionId],
    queryFn: () => getClaudeCodeDoctor(sessionId!),
    enabled: !!sessionId && open,
  });

  if (!open) return null;

  const d = q.data;

  return (
    <div className="ccp-modal-backdrop" onClick={onClose}>
      <div className="ccp-modal ccp-modal-doctor" onClick={(e) => e.stopPropagation()}>
        <div className="ccp-modal-head">
          <span className="ccp-modal-title">🩺 Session Doctor</span>
          <button type="button" className="ccp-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ccp-modal-body">
          {!sessionId ? <div className="ccp-modal-muted">No active session.</div> : null}
          {q.isLoading ? <div className="ccp-modal-muted">Loading…</div> : null}
          {q.error ? <div className="ccp-modal-error">{q.error.message}</div> : null}
          {d ? (
            <dl className="ccp-doctor-grid">
              <dt>Session ID</dt><dd>{d.sessionId}</dd>
              <dt>Status</dt><dd>{d.status ?? "—"}</dd>
              <dt>Mode</dt><dd>{d.mode ?? "—"}</dd>
              <dt>Permission Mode</dt><dd>{d.permissionMode}</dd>
              <dt>Model</dt><dd>{d.model ?? "—"}</dd>
              <dt>Effort</dt><dd>{d.effort ?? "—"}</dd>
              <dt>Thinking</dt><dd>{d.thinking ?? "—"}</dd>
              <dt>CWD</dt><dd><code>{d.cwd}</code></dd>
              <dt>Additional dirs</dt><dd><code>{d.additionalDirectories.join(", ")}</code></dd>
              <dt>Disallowed tools</dt><dd><code>{d.disallowedTools?.length ? d.disallowedTools.join(", ") : "(none)"}</code></dd>
              <dt>Research-allowed</dt><dd><code>{d.researchAllowedTools.join(", ")}</code></dd>
              <dt>SDK version</dt><dd>{d.sdkVersion}</dd>
              <dt>Started</dt><dd>{d.startedAt ?? "—"}</dd>
              <dt>Last event</dt><dd>{d.lastEventAt ? new Date(d.lastEventAt).toLocaleString() : "—"}</dd>
              <dt>Event count</dt><dd>{d.eventCount ?? 0}</dd>
              <dt>Subscribers</dt><dd>{d.subscribers}</dd>
              <dt>Pinned</dt><dd>{d.pinned ? "yes" : "no"}</dd>
              {d.title ? (<><dt>Title</dt><dd>{d.title}</dd></>) : null}
              {d.lastError ? (<><dt>Last error</dt><dd className="ccp-doctor-err">{d.lastError}</dd></>) : null}
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Memory modal ────────────────────────────────────────────────────────────

export function MemoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const listQuery = useQuery({ queryKey: ["claude-code-memory-list"], queryFn: listClaudeCodeMemory, enabled: open });
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const readQuery = useQuery({
    queryKey: ["claude-code-memory-read", selected],
    queryFn: () => readClaudeCodeMemory(selected!),
    enabled: !!selected && open,
  });

  useEffect(() => {
    if (readQuery.data && !dirty) { setDraft(readQuery.data.content); }
  }, [readQuery.data, dirty]);

  useEffect(() => {
    if (!open) { setSelected(null); setDraft(null); setDirty(false); setSaveError(null); }
  }, [open]);

  const writeMut = useMutation({
    mutationFn: writeClaudeCodeMemory,
    onSuccess: async () => {
      setDirty(false); setSaving(false); setSaveError(null);
      await queryClient.invalidateQueries({ queryKey: ["claude-code-memory-list"] });
      if (selected) await queryClient.invalidateQueries({ queryKey: ["claude-code-memory-read", selected] });
    },
    onError: (e: Error) => { setSaveError(e.message); setSaving(false); },
  });

  if (!open) return null;

  const save = () => {
    if (!selected || draft == null) return;
    setSaving(true); setSaveError(null);
    writeMut.mutate({ path: selected, content: draft });
  };

  return (
    <div className="ccp-modal-backdrop" onClick={onClose}>
      <div className="ccp-modal ccp-modal-memory" onClick={(e) => e.stopPropagation()}>
        <div className="ccp-modal-head">
          <span className="ccp-modal-title">📚 Memory Files</span>
          <button type="button" className="ccp-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ccp-modal-body ccp-memory-body">
          <div className="ccp-memory-list">
            {listQuery.isLoading ? <div className="ccp-modal-muted">Loading…</div> : null}
            {listQuery.data?.files.map((f) => (
              <button
                key={f.path}
                type="button"
                className={`ccp-memory-row ${selected === f.path ? "is-sel" : ""}`}
                onClick={() => { setSelected(f.path); setDraft(null); setDirty(false); setSaveError(null); }}
              >
                <div className="ccp-memory-name">{f.name}</div>
                <div className="ccp-memory-path">{f.path.replace(/^\/home\/claude\//, "~/")}</div>
                <div className="ccp-memory-size">{f.size} bytes</div>
              </button>
            ))}
            {!listQuery.isLoading && !listQuery.data?.files.length ? <div className="ccp-modal-muted">No memory files found.</div> : null}
          </div>
          <div className="ccp-memory-editor">
            {!selected ? <div className="ccp-modal-muted">Select a file to view/edit.</div> : null}
            {selected && readQuery.isLoading ? <div className="ccp-modal-muted">Loading…</div> : null}
            {selected && draft != null ? (
              <>
                <div className="ccp-memory-editor-head">
                  <code>{selected}</code>
                  {dirty ? <span className="ccp-memory-dirty">• unsaved</span> : null}
                  <span className="ccp-memory-editor-spacer" />
                  <button type="button" className="ccp-memory-save" disabled={!dirty || saving} onClick={save}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
                {saveError ? <div className="ccp-modal-error">{saveError}</div> : null}
                <textarea
                  className="ccp-memory-textarea"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
                  spellCheck={false}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
