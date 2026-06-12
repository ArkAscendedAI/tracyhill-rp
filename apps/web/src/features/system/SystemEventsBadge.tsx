import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Popover } from "../../shared/ui/Popover";
import { ackSystemEvents, getSystemEvents } from "./systemEventsApi";

// Global no-silent-failures surface: shows a warning pill whenever any passive
// subsystem (embeddings, HyDE, researcher, validators, background workers) has
// recorded an unacknowledged failure. Renders nothing when all is well.
export function SystemEventsBadge() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const queryClient = useQueryClient();

  const eventsQuery = useQuery({
    queryKey: ["system-events"],
    queryFn: () => getSystemEvents(true, 50),
    refetchInterval: 60_000,
  });

  const ackMutation = useMutation({
    mutationFn: () => ackSystemEvents(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["system-events"] });
      setOpen(false);
    },
  });

  const unacked = eventsQuery.data?.unackedCount ?? 0;
  if (unacked === 0) return null;

  const events = eventsQuery.data?.events ?? [];

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="system-events-badge"
        onClick={() => setOpen((o) => !o)}
        title="Background system failures — click for details"
      >
        ⚠ {unacked} system {unacked === 1 ? "event" : "events"}
      </button>
      <Popover
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        title={`System Events · ${unacked} unacknowledged`}
        width={460}
      >
        <div className="system-events-list">
          {events.map((event) => (
            <div key={event.id} className={`system-event severity-${event.severity}`}>
              <div className="system-event-head">
                <span className="system-event-source">{event.source.replace(/_/g, " ")}</span>
                <span className="system-event-time">{formatEventTime(event.createdAt)}</span>
              </div>
              <div className="system-event-message">{event.message}</div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="secondary-button system-events-ack"
          onClick={() => ackMutation.mutate()}
          disabled={ackMutation.isPending}
        >
          {ackMutation.isPending ? "Acknowledging…" : "Acknowledge all"}
        </button>
      </Popover>
    </>
  );
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = Date.now();
  const diffMin = Math.round((now - date.getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h ago`;
  return date.toLocaleString();
}
