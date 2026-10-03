import type { SystemEvent, SystemEventClass } from "@tracyhill-rp/contracts";

import { ackSystemEvents } from "./systemEventsApi";

/**
 * The popover's "Acknowledge alerts" / "Mark notices read": acknowledges exactly the listed events of the open tab,
 * by id within their class. The list holds at most 50 events as of its last read, and the class form
 * (`{ class }`) acknowledged every unacknowledged event of the class when the server ran it, so an alert recorded
 * after the read, or one past the 50 listed, was acknowledged unseen. Anything newer stays unacknowledged and shows
 * on the next read. The route caps `ids` at 500; the list asks for 50.
 */
export function ackShownEvents(tab: SystemEventClass, shown: ReadonlyArray<Pick<SystemEvent, "id">>) {
  return ackSystemEvents(tab, shown.map((event) => event.id));
}

/** The acknowledge button's label for the open tab; when the tab counts more events than the list holds, it says
 *  how many the click covers. */
export function ackButtonLabel(tab: SystemEventClass, shownCount: number, total: number): string {
  if (shownCount < total) return tab === "alert" ? `Acknowledge the ${shownCount} shown` : `Mark the ${shownCount} shown read`;
  return tab === "alert" ? "Acknowledge alerts" : "Mark notices read";
}
