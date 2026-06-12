import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { clearPendingRegistration, loadPendingRegistration, savePendingRegistration } from "./registrationStorage";
import { resendRegistration, verifyRegistration } from "./authApi";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

export function RegistrationVerificationPage() {
  const queryClient = useQueryClient();
  const pending = loadPendingRegistration();
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState(pending?.devVerificationCode ?? "");
  const verifyMutation = useMutation({
    mutationFn: verifyRegistration,
    onSuccess: async () => {
      clearPendingRegistration();
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
  const resendMutation = useMutation({
    mutationFn: resendRegistration,
    onSuccess: (response) => {
      savePendingRegistration({
        registrationToken: pending!.registrationToken,
        emailMasked: response.emailMasked,
        ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
      });
      setDevCode(response.devVerificationCode ?? "");
      setCode("");
    },
  });

  if (!pending) {
    return (
      <FullscreenCenter>
        <section className="card stack">
          <img src="/TracyHill-RP-Logo-Horizontal.png" alt="TracyHill RP" className="login-logo" style={{ width: "100%", maxHeight: "60px", objectFit: "contain", marginBottom: "1rem" }} />
          <h1>Verify Email</h1>
          <p className="muted small-copy">No pending registration was found. Start registration again to receive a fresh code.</p>
          <div className="row gap-sm wrap-row">
            <a href="/register" className="ghost-button" style={{ textDecoration: "none" }}>Back To Register</a>
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
        <h1>Verify Email</h1>
        <p className="muted small-copy">Enter the six-digit verification code sent to {pending.emailMasked}.</p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            verifyMutation.mutate({
              registrationToken: pending.registrationToken,
              code,
            });
          }}
        >
          <label className="field">
            <span>Verification Code</span>
            <input aria-label="Registration verification code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} />
          </label>
          {devCode ? <p className="muted small-copy" aria-label="Development verification code">Test code: <code>{devCode}</code></p> : null}
          {verifyMutation.error ? <p className="error">{verifyMutation.error.message}</p> : null}
          {resendMutation.error ? <p className="error">{resendMutation.error.message}</p> : null}
          <button type="submit" disabled={verifyMutation.isPending || !code.trim()}>
            {verifyMutation.isPending ? "Verifying..." : "Verify And Sign In"}
          </button>
          <div className="row gap-sm wrap-row">
            <button type="button" className="secondary-button" disabled={resendMutation.isPending} onClick={() => resendMutation.mutate({ registrationToken: pending.registrationToken })}>
              {resendMutation.isPending ? "Sending..." : "Resend Code"}
            </button>
            <a
              href="/register"
              className="ghost-button"
              style={{ textDecoration: "none" }}
              onClick={() => clearPendingRegistration()}
            >
              Start Over
            </a>
          </div>
        </form>
      </section>
    </FullscreenCenter>
  );
}
