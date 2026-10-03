import { z } from "zod";

export const systemEventSchema = z.object({
  id: z.string(),
  source: z.string(),
  severity: z.enum(["info", "warn", "error"]).catch("warn"),
  message: z.string(),
  campaignId: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  detailsJson: z.string().nullable().default(null),
  acknowledgedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type SystemEvent = z.infer<typeof systemEventSchema>;

// Delivery class (2026-09-27): warn/error = alert (badge), info = notice (quiet).
export const systemEventClassSchema = z.enum(["alert", "notice"]);
export type SystemEventClass = z.infer<typeof systemEventClassSchema>;

export const systemEventsResponseSchema = z.object({
  events: z.array(systemEventSchema),
  // All unacknowledged events (alerts + notices) — kept for older clients.
  unackedCount: z.number().int().nonnegative(),
  // Unacknowledged alerts (warn/error): what the rail badge counts.
  alertCount: z.number().int().nonnegative().default(0),
  // Unacknowledged notices (info): readable in the panel, never counted.
  noticeCount: z.number().int().nonnegative().default(0),
});
export type SystemEventsResponse = z.infer<typeof systemEventsResponseSchema>;

export const ackSystemEventsRequestSchema = z.object({
  ids: z.array(z.string()).max(500).optional(),
  // Acknowledge only one class; omitted = every class (the old behavior).
  class: systemEventClassSchema.optional(),
});
export type AckSystemEventsRequest = z.infer<typeof ackSystemEventsRequestSchema>;

// What POST /api/system-events/ack answers (additive, 2026-10-01): how many it acknowledged and the
// unacknowledged counts after it, as in the list response.
export const ackSystemEventsResponseSchema = z.object({
  acknowledged: z.number().int().nonnegative(),
  unackedCount: z.number().int().nonnegative(),
  alertCount: z.number().int().nonnegative().default(0),
  noticeCount: z.number().int().nonnegative().default(0),
});
export type AckSystemEventsResponse = z.infer<typeof ackSystemEventsResponseSchema>;
