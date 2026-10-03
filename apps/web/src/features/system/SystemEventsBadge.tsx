import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SystemEvent, SystemEventClass } from "@tracyhill-rp/contracts";

import { Popover } from "../../shared/ui/Popover";
import { QueryError } from "../../shared/ui/QueryError";
import { getSystemEvents } from "./systemEventsApi";
import { ackButtonLabel, ackShownEvents } from "./systemEventsAck";
import { Icon } from "../../shared/ui/Icon";

// Global no-silent-failures surface, with two delivery paths (2026-09-27), so
// notices do not cause alert fatigue for the actual failures:
// - ALERTS (warn/error): something failed or degraded. The rail button turns
//   amber and carries their count — that badge means "look at this" and
//   nothing else.
// - NOTICES (info): the system handled it (a hold that kept newer canon, a
//   recovered run, findings waiting in their own chip). Readable in the same
//   panel, never counted; with notices only, the button is neutral.
// Renders nothing when neither is waiting. A failed read with nothing counted
// still shows: the button turns amber and says the feed could not be read, and
// the panel names the failure with Retry (both counts used to default to 0,
// so the badge hid its own failure). A failed acknowledgement says why above its
// button, which stays ready for another try, until a new try, a tab switch or
// closing the panel (Android's `ackError`).
export function SystemEventsBadge({ compact = false }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [chosenTab, setChosenTab] = useState<SystemEventClass | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const queryClient = useQueryClient();

  const alertsQuery = useQuery({
    queryKey: ["system-events", "alert"],
    queryFn: () => getSystemEvents({ unackedOnly: true, limit: 50, eventClass: "alert" }),
    refetchInterval: 60_000,
  });
  const alertCount = alertsQuery.data?.alertCount ?? 0;
  const noticeCount = alertsQuery.data?.noticeCount ?? 0;
  const unreadable = alertsQuery.isError && alertCount === 0 && noticeCount === 0;
  const tab: SystemEventClass = chosenTab ?? (alertCount > 0 ? "alert" : "notice");

  const noticesQuery = useQuery({
    queryKey: ["system-events", "notice"],
    queryFn: () => getSystemEvents({ unackedOnly: true, limit: 50, eventClass: "notice" }),
    enabled: open && tab === "notice" && !unreadable,
  });

  const ackMutation = useMutation({
    mutationFn: ({ tab: eventClass, shown }: { tab: SystemEventClass; shown: SystemEvent[] }) => ackShownEvents(eventClass, shown),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["system-events"] });
      setOpen(false);
      setChosenTab(null);
    },
  });
  const forgetAckFailure = () => { if (ackMutation.isError) ackMutation.reset(); };
  // Every close, the popover's own (a click outside, Escape) and the rail button's, forgets the chosen tab and an
  // acknowledgement failure, so the next open lands on the tab the counts pick. The rail button used to close with
  // `setOpen` alone and keep the tab.
  const closePanel = () => { setOpen(false); setChosenTab(null); forgetAckFailure(); };

  if (alertCount === 0 && noticeCount === 0 && !unreadable) return null;

  const hasAlerts = alertCount > 0;
  const events: SystemEvent[] = (tab === "alert" ? alertsQuery.data?.events : noticesQuery.data?.events) ?? [];
  const loading = tab === "notice" && noticesQuery.isLoading;
  // A list whose read failed shows the failure, never its empty line.
  const listFailed = tab === "alert" ? alertsQuery.isError : noticesQuery.isError;
  const ackFailure = ackMutation.isError && ackMutation.variables?.tab === tab
    ? `Acknowledge failed: ${ackMutation.error instanceof Error ? ackMutation.error.message : "Request failed"}`
    : null;
  const title = unreadable
    ? `System events could not be read: ${alertsQuery.error instanceof Error ? alertsQuery.error.message : "Request failed"}. Click for details.`
    : hasAlerts
      ? `${alertCount} ${alertCount === 1 ? "alert" : "alerts"}: something failed or degraded. Click for details.`
      : `${noticeCount} ${noticeCount === 1 ? "notice" : "notices"}: nothing failed. Click to read.`;
  const buttonClass = compact
    ? (hasAlerts || unreadable ? "rail-btn rail-btn-alert" : "rail-btn")
    : (hasAlerts || unreadable ? "system-events-badge" : "system-events-badge system-events-badge-quiet");

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={buttonClass}
        onClick={() => (open ? closePanel() : setOpen(true))}
        title={title}
        aria-label={unreadable ? "System events could not be read" : hasAlerts ? `${alertCount} system ${alertCount === 1 ? "alert" : "alerts"}` : `${noticeCount} system ${noticeCount === 1 ? "notice" : "notices"}`}
      >
        {compact
          ? <><Icon name="alert" size={20} />{hasAlerts ? <span className="rail-badge">{alertCount > 99 ? "99+" : alertCount}</span> : null}<span className="rail-label">Events</span></>
          : <><Icon name="alert" size={14} /> {unreadable ? "Events could not be read" : hasAlerts ? `${alertCount} ${alertCount === 1 ? "alert" : "alerts"}` : `${noticeCount} ${noticeCount === 1 ? "notice" : "notices"}`}</>}
      </button>
      <Popover
        open={open}
        anchorRef={anchorRef}
        onClose={closePanel}
        title="System events"
        width={460}
      >
        {/* A failed feed read shows first. With nothing counted no counts are known, so it is all the panel shows. */}
        <QueryError query={alertsQuery} label="Unable to read system events" />
        {unreadable ? null : <div className="system-events-tabs" role="tablist" aria-label="Event type">
          <TabChip label={`Alerts (${alertCount})`} active={tab === "alert"} onClick={() => { setChosenTab("alert"); forgetAckFailure(); }} />
          <TabChip label={`Notices (${noticeCount})`} active={tab === "notice"} onClick={() => { setChosenTab("notice"); forgetAckFailure(); }} />
        </div>}
        {unreadable ? null : <p className="muted small-copy system-events-explainer">
          {tab === "alert" ? "Something failed or degraded. These are what the badge counts." : "Handled by the system: holds that kept newer canon, recovered runs, things waiting in their own chips. Never counted on the badge."}
        </p>}
        {unreadable ? null : <div className="system-events-list">
          {loading ? <p className="muted small-copy">Loading notices…</p> : null}
          {tab === "notice" ? <QueryError query={noticesQuery} label="Unable to read notices" /> : null}
          {!loading && !listFailed && events.length === 0 ? <p className="muted small-copy">{tab === "alert" ? "No alerts. Nothing has failed." : "No unread notices."}</p> : null}
          {events.map((event) => (
            <div key={event.id} className={`system-event severity-${event.severity}`}>
              <div className="system-event-head">
                <span className="system-event-source">{event.source.replace(/_/g, " ")}</span>
                <span className="system-event-time">{formatEventTime(event.createdAt)}</span>
              </div>
              <div className="system-event-message">{event.message}</div>
            </div>
          ))}
        </div>}
        {ackFailure && !unreadable ? <p role="alert" className="error small-copy">{ackFailure}</p> : null}
        {events.length > 0 && !unreadable ? (
          <button
            type="button"
            className="secondary-button system-events-ack"
            onClick={() => ackMutation.mutate({ tab, shown: events })}
            disabled={ackMutation.isPending}
          >
            {ackMutation.isPending ? "Acknowledging…" : ackButtonLabel(tab, events.length, tab === "alert" ? alertCount : noticeCount)}
          </button>
        ) : null}
      </Popover>
    </>
  );
}

function TabChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`system-events-tab${active ? " is-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
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
