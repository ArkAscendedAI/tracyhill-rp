import { useState } from "react";

import { LoginPage } from "./LoginPage";
import { MfaChallengePage } from "./MfaChallengePage";

/**
 * Re-authentication overlay for a session that died mid-app. App keeps
 * AppShell MOUNTED underneath so every component's
 * state — above all the composer draft in SessionConversation — survives the
 * bounce; swapping the shell for LoginPage used to destroy ten paragraphs of
 * unsent text on the first background poll after a 3 AM expiry / secret
 * rotation / admin force-logout. Login (and an MFA challenge, if the account
 * needs one) run inline; a successful unlock as the SAME user simply lifts the
 * overlay and refetches, a different account purges the caches and remounts
 * the shell (authCache.completeSignIn).
 */
export function SessionLapsedOverlay() {
  const [stage, setStage] = useState<"login" | "mfa">("login");
  return (
    <div className="dialog-backdrop session-lapsed-overlay" role="presentation">
      <div className="stack stack-tight" style={{ width: "min(26rem, 100%)" }}>
        <div role="dialog" aria-modal="true" aria-label="Session expired">
          <p className="muted small-copy" style={{ textAlign: "center", marginBottom: "0.75rem" }}>
            Your sign-in expired. Unlock again to keep working — anything you have typed is still here.
          </p>
          {stage === "login"
            ? <LoginPage embedded onMfaRequired={() => setStage("mfa")} />
            : <MfaChallengePage embedded onCancel={() => setStage("login")} />}
        </div>
      </div>
    </div>
  );
}
