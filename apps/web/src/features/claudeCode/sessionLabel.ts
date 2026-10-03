import type { ClaudeCodeSessionSummary } from "@tracyhill-rp/contracts";

import { sliceUnits } from "../../shared/text/sliceUnits";

/**
 * A Claude or Kimi session's name in the rail and the command palette: its title, else the start of its last
 * prompt, else the first 8 characters of its id. The prompt's cut never splits an emoji.
 */
export function sessionLabel(session: Pick<ClaudeCodeSessionSummary, "title" | "lastPrompt" | "sessionId">): string {
  return session.title || (session.lastPrompt && sliceUnits(session.lastPrompt, 60)) || session.sessionId.slice(0, 8);
}
