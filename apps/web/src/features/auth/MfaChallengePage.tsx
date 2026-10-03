import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { completeSignIn } from "./authCache";
import { clearPendingMfa, loadPendingMfa, savePendingMfa } from "./mfaStorage";
import { resendMfaCode, verifyMfaCode } from "./authApi";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

type MfaChallengePageProps = {
  // Embedded = inside the session-lapsed overlay: no full-screen
  // wrapper, and Cancel returns to the host instead of navigating away.
  embedded?: boolean;
  onCancel?: () => void;
};

// What the code box asks for: the authenticator's code, a recovery code, or the emailed code.
type ChallengeMode = "totp" | "recovery" | "email";

export function MfaChallengePage({ embedded = false, onCancel }: MfaChallengePageProps = {}) {
  const queryClient = useQueryClient();
  const pending = loadPendingMfa();
  // A challenge without methods comes from an older server: the email code alone.
  const methods = pending?.methods ?? ["email"];
  const [mode, setMode] = useState<ChallengeMode>(methods.includes("totp") ? "totp" : "email");
  const [emailMasked, setEmailMasked] = useState(pending?.emailMasked ?? "");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState(pending?.devVerificationCode ?? "");
  const [trustDevice, setTrustDevice] = useState(false);
  const resendMutation = useMutation({
    mutationFn: resendMfaCode,
    onSuccess: (response) => {
      if (!pending) return;
      savePendingMfa({
        mfaSessionToken: pending.mfaSessionToken,
        emailMasked: response.emailMasked,
        ...(pending.methods ? { methods: pending.methods } : {}),
        ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
      });
      setEmailMasked(response.emailMasked);
      setMode("email");
      setDevCode(response.devVerificationCode ?? "");
      setCode("");
    },
  });
  const verifyMutation = useMutation({
    mutationFn: verifyMfaCode,
    onSuccess: (response) => {
      clearPendingMfa();
      completeSignIn(queryClient, response.user); // cache hygiene across identity changes
    },
  });

  const wrap = (card: JSX.Element) => (embedded ? card : <FullscreenCenter>{card}</FullscreenCenter>);
  const cancelControl = onCancel
    ? <button type="button" className="ghost-button" onClick={() => { clearPendingMfa(); onCancel(); }}>Cancel</button>
    : <a href="/" className="ghost-button" style={{ textDecoration: "none" }} onClick={() => clearPendingMfa()}>Cancel</a>;

  if (!pending) {
    return wrap(<>
        <section className="card stack">
          <img src="/brand/logo-horizontal-480.webp" srcSet="/brand/logo-horizontal-480.webp 1x, /brand/logo-horizontal-960.webp 2x" alt="TracyHill RP" className="login-logo" style={{ width: "100%", maxHeight: "60px", objectFit: "contain", marginBottom: "1rem" }} />
          <h1>Two-Step Verification</h1>
          <p className="muted small-copy">No active sign-in challenge was found. Start the login flow again.</p>
          <div className="row gap-sm wrap-row">
            {onCancel
              ? <button type="button" className="ghost-button" onClick={onCancel}>Back To Login</button>
              : <a href="/" className="ghost-button" style={{ textDecoration: "none" }}>Back To Login</a>}
          </div>
        </section>
    </>);
  }

  return wrap(<>
      <section className="card">
        <img src="/brand/logo-horizontal-480.webp" srcSet="/brand/logo-horizontal-480.webp 1x, /brand/logo-horizontal-960.webp 2x" alt="TracyHill RP" className="login-logo" style={{ width: "100%", maxHeight: "60px", objectFit: "contain", marginBottom: "1rem" }} />
        <h1>Two-Step Verification</h1>
        <p className="muted small-copy">
          {mode === "totp"
            ? "Enter the six-digit code from your authenticator app."
            : mode === "recovery"
              ? "Enter one of your recovery codes. Each one works once."
              : emailMasked
                ? `Enter the six-digit sign-in code sent to ${emailMasked}.`
                : "Ask for a sign-in code by email below."}
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            verifyMutation.mutate({ mfaSessionToken: pending.mfaSessionToken, code, trustDevice });
          }}
        >
          <label className="field">
            <span>{mode === "recovery" ? "Recovery Code" : "Verification Code"}</span>
            <input aria-label="MFA verification code" inputMode={mode === "recovery" ? "text" : "numeric"} autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
          </label>
          <label className="row gap-sm wrap-row">
            <input
              aria-label="Trust this device"
              type="checkbox"
              checked={trustDevice}
              onChange={(event) => setTrustDevice(event.target.checked)}
            />
            <span className="muted small-copy">Trust this device for future sign-ins on this browser.</span>
          </label>
          {devCode ? <p className="muted small-copy" aria-label="Development MFA code">Test code: <code>{devCode}</code></p> : null}
          {verifyMutation.error ? <p className="error">{verifyMutation.error.message}</p> : null}
          {resendMutation.error ? <p className="error">{resendMutation.error.message}</p> : null}
          <button type="submit" disabled={verifyMutation.isPending || !code.trim()}>
            {verifyMutation.isPending ? "Verifying..." : "Verify And Sign In"}
          </button>
          <div className="row gap-sm wrap-row">
            {methods.includes("email") ? (
              <button type="button" className="secondary-button" disabled={resendMutation.isPending} onClick={() => resendMutation.mutate({ mfaSessionToken: pending.mfaSessionToken })}>
                {resendMutation.isPending ? "Sending..." : mode === "email" && emailMasked ? "Resend Code" : "Email Me A Code Instead"}
              </button>
            ) : null}
            {methods.includes("recovery") && mode !== "recovery" ? (
              <button type="button" className="ghost-button" onClick={() => { setMode("recovery"); setCode(""); }}>Use A Recovery Code</button>
            ) : null}
            {methods.includes("totp") && mode !== "totp" ? (
              <button type="button" className="ghost-button" onClick={() => { setMode("totp"); setCode(""); }}>Use The Authenticator App</button>
            ) : null}
            {cancelControl}
          </div>
        </form>
      </section>
  </>);
}
