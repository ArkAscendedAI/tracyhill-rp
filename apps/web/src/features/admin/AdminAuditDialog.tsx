import { useQuery } from "@tanstack/react-query";

import { getAdminAuditEvents } from "./adminApi";
import { Dialog } from "../../shared/ui/Dialog";

type AdminAuditDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function AdminAuditDialog({ open, onClose }: AdminAuditDialogProps) {
  const auditQuery = useQuery({
    queryKey: ["admin-audit-events"],
    queryFn: () => getAdminAuditEvents(100),
    enabled: open,
  });

  if (!open) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      label="Audit"
      eyebrow="Admin"
      title="Audit"
      icon="list"
      size="lg"
      headerExtra={<button type="button" className="secondary-button" onClick={() => auditQuery.refetch()} disabled={auditQuery.isFetching}>Refresh</button>}
    >
        <div className="stack stack-tight">
          <p className="muted small-copy">Recent security-sensitive and operator-sensitive events from the `audit_events` table.</p>
          {auditQuery.isLoading ? <p className="muted small-copy">Loading audit events...</p> : null}
          {auditQuery.isError ? <p className="error">{auditQuery.error.message}</p> : null}
          <div className="stack stack-tight" style={{ maxHeight: 420, overflowY: "auto" }}>
            {(auditQuery.data?.events ?? []).map((event) => (
              <article key={event.id} className="card stack stack-tight">
                <div className="section-head">
                  <div>
                    <strong>{event.action}</strong>
                    <p className="muted small-copy" style={{ margin: 0 }}>
                      {new Date(event.createdAt).toLocaleString()}
                      {event.actorUsername ? ` · ${event.actorUsername}` : event.actorUserId ? ` · ${event.actorUserId}` : ""}
                    </p>
                  </div>
                  <span className="muted small-copy">{event.targetType ?? "event"}</span>
                </div>
                <div className="row gap-sm wrap-row">
                  {event.targetId ? <span className="pill">target {event.targetId}</span> : null}
                  {event.sessionId ? <span className="pill">session {event.sessionId}</span> : null}
                  {event.campaignId ? <span className="pill">campaign {event.campaignId}</span> : null}
                  {event.runId ? <span className="pill">run {event.runId}</span> : null}
                  {event.requestId ? <span className="pill">request {event.requestId}</span> : null}
                </div>
                {Object.keys(event.metadata).length ? (
                  <pre className="code-block" style={{ margin: 0 }}>{JSON.stringify(event.metadata, null, 2)}</pre>
                ) : null}
              </article>
            ))}
            {/* Empty-state copy only for a successful read — a failed one already shows its error above. */}
            {auditQuery.isSuccess && auditQuery.data.events.length === 0 ? <p className="muted small-copy">No audit events yet.</p> : null}
          </div>
        </div>
    </Dialog>
  );
}
