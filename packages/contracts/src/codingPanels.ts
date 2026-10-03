import { z } from "zod";

// Which coding panels this server has set up. The panels need agent services
// outside this app and are never set up automatically; the web greys out the coding section, or the panels in it,
// that are not. "configured" means the connection settings (host and secret) are present, not that the service answers.
export const codingPanelReadinessSchema = z.object({
  configured: z.boolean(),
});

export const codingPanelsResponseSchema = z.object({
  claudeCode: codingPanelReadinessSchema,
  codex: codingPanelReadinessSchema,
  kimi: codingPanelReadinessSchema,
});

export type CodingPanelsResponse = z.infer<typeof codingPanelsResponseSchema>;
