import type { ContextSettings } from "@tracyhill-rp/contracts";

/** Whether retrieval runs for a session: every mode except "off". The single
 *  predicate behind ContextEngine.isEnabled, the transcript window's retrieval
 *  reservation and the Injected-text viewer's retrieved-context gate
 *  (chat/turnBlocks.ts). */
export function retrievalRuns(settings: Pick<ContextSettings, "mode">): boolean {
  return settings.mode !== "off";
}
