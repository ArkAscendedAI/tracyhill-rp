import type { CreateSessionRequest, WorkspaceStateResponse } from "@tracyhill-rp/contracts";

import { ApiError } from "../../shared/api/client";

export type ReplaceWizardApi = {
  deleteSession: (sessionId: string) => Promise<WorkspaceStateResponse>;
  createSession: (payload: CreateSessionRequest) => Promise<WorkspaceStateResponse>;
  /** Publish an intermediate workspace state (the shell's cache write). */
  onState: (state: WorkspaceStateResponse) => void;
};

/**
 * The Wizard Slot's Replace, after its confirmation ("Replacing it permanently removes the current
 * wizard conversation"). The server keeps one active wizard session per user and answers a second
 * create with 409 "an active wizard session already exists" (workspaceService.createSession), so the
 * create-first order from June could never succeed and Replace always failed. The old
 * session is deleted first, the emptied slot published, then the new one created. A failed delete
 * changes nothing and its error passes through; a failed create after it says plainly that the old
 * conversation is gone and how to start again (a lapsed sign-in passes through for the re-login overlay).
 * Android does create-first and, on that exact 409, delete-then-create; both end in the same state.
 */
export async function replaceWizardSession(oldWizardId: string, api: ReplaceWizardApi): Promise<WorkspaceStateResponse> {
  api.onState(await api.deleteSession(oldWizardId));
  try {
    return await api.createSession({ sessionType: "wizard" });
  } catch (error) {
    if (error instanceof ApiError && error.authInvalidated) throw error;
    const reason = error instanceof Error ? error.message : "request failed";
    throw new Error(`The old wizard conversation was deleted, but a new one could not be started (${reason}). Start one with New Campaign Wizard.`);
  }
}
