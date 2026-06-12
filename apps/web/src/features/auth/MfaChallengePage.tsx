import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { clearPendingMfa, loadPendingMfa, savePendingMfa } from "./mfaStorage";
import { resendMfaCode, verifyMfaCode } from "./authApi";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

export function MfaChallengePage() {
  const queryClient = useQueryClient();
  const pending = loadPendingMfa();
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
        ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
      });
      setDevCode(response.devVerificationCode ?? "");
      setCode("");
    },
  });
  const verifyMutation = useMutation({
    mutationFn: verifyMfaCode,
    onSuccess: async () => {
      clearPendingMfa();
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });

  if (!pending) {
    return (
      <FullscreenCenter>
        <section className="card stack">
          <img src="/TracyHill-RP-Logo-Horizontal.png" alt="TracyHill RP" className="login-logo" style={{ width: "100%", maxHeight: "60px", objectFit: "contain", marginBottom: "1rem" }} />
          <h1>Two-Step Verification</h1>
          <p className="muted small-copy">No active sign-in challenge was found. Start the login flow again.</p>
          <div className="row gap-sm wrap-row">
            <a href="/" className="ghost-button" style={{ textDecoration: "none" }}>Back To Login</a>
          </div>
        </section>
      </FullscreenCenter>
    );
  }

  return (
    <FullscreenCenter>
      <section className="card">
        <img src="/TracyHill-RP-Logo-Horizontal.png" alt="TracyHill RP" className="login-logo" style={{ width: "100%", maxHeight: "60px", objectFit: "contain", marginBottom: "1rem" }} />
        <h1>Two-Step Verification</h1>
        <p className="muted small-copy">Enter the six-digit sign-in code sent to {pending.emailMasked}.</p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            verifyMutation.mutate({ mfaSessionToken: pending.mfaSessionToken, code, trustDevice });
          }}
        >
          <label className="field">
            <span>Verification Code</span>
            <input aria-label="MFA verification code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} />
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
            <button type="button" className="secondary-button" disabled={resendMutation.isPending} onClick={() => resendMutation.mutate({ mfaSessionToken: pending.mfaSessionToken })}>
              {resendMutation.isPending ? "Sending..." : "Resend Code"}
            </button>
            <a href="/" className="ghost-button" style={{ textDecoration: "none" }} onClick={() => clearPendingMfa()}>
              Cancel
            </a>
          </div>
        </form>
      </section>
    </FullscreenCenter>
  );
}
