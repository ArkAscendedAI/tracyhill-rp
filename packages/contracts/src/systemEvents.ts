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

export const systemEventsResponseSchema = z.object({
  events: z.array(systemEventSchema),
  unackedCount: z.number().int().nonnegative(),
});
export type SystemEventsResponse = z.infer<typeof systemEventsResponseSchema>;

export const ackSystemEventsRequestSchema = z.object({
  ids: z.array(z.string()).max(500).optional(),
});
export type AckSystemEventsRequest = z.infer<typeof ackSystemEventsRequestSchema>;
