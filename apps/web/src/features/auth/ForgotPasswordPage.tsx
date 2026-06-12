import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { clearPendingPasswordReset, loadPendingPasswordReset, savePendingPasswordReset } from "./forgotPasswordStorage";
import { forgotPassword, resendPasswordReset, resetPassword, verifyPasswordReset } from "./authApi";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

export function ForgotPasswordPage() {
  const pending = loadPendingPasswordReset();
  const [username, setUsername] = useState("");
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState(pending?.devVerificationCode ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const requestMutation = useMutation({
    mutationFn: forgotPassword,
    onSuccess: (response) => {
      setLocalError("");
      setMessage(response.message);
      // Constant-shape response: resetToken + emailMasked are always present (even
      // for non-existent users -- those are server-side dummies). Always advance
      // to the verify screen so the flow looks identical from outside.
      savePendingPasswordReset({
        resetToken: response.resetToken,
        emailMasked: response.emailMasked,
        ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
      });
      window.location.assign("/forgot-password");
    },
  });
  const resendMutation = useMutation({
    mutationFn: resendPasswordReset,
    onSuccess: (response) => {
      if (!pending) return;
      savePendingPasswordReset({
        resetToken: pending.resetToken,
        emailMasked: response.emailMasked,
        ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
        ...(pending.verified ? { verified: true } : {}),
      });
      setDevCode(response.devVerificationCode ?? "");
      setCode("");
    },
  });
  const verifyMutation = useMutation({
    mutationFn: verifyPasswordReset,
    onSuccess: () => {
      if (!pending) return;
      savePendingPasswordReset({
        resetToken: pending.resetToken,
        emailMasked: pending.emailMasked,
        verified: true,
        ...(devCode ? { devVerificationCode: devCode } : {}),
      });
      window.location.assign("/forgot-password");
    },
  });
  const resetMutation = useMutation({
    mutationFn: resetPassword,
    onSuccess: () => {
      clearPendingPasswordReset();
      window.location.assign("/");
    },
  });

  const resetStage = pending?.verified ? "reset" : pending ? "verify" : "request";

  return (
    <FullscreenCenter>
      <section className="card">
        <img src="/TracyHill-RP-Logo-Horizontal.png" alt="TracyHill RP" className="login-logo" style={{ width: "100%", maxHeight: "60px", objectFit: "contain", marginBottom: "1rem" }} />
        <h1>Forgot Password</h1>
        {resetStage === "request" ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              setLocalError("");
              requestMutation.mutate({ username });
            }}
          >
            <p className="muted small-copy">Enter your username. If the account exists, a verification code will be sent.</p>
            <label className="field">
              <span>Username</span>
              <input aria-label="Forgot password username" value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            {message ? <p className="muted small-copy">{message}</p> : null}
            {requestMutation.error ? <p className="error">{requestMutation.error.message}</p> : null}
            <button type="submit" disabled={requestMutation.isPending || !username.trim()}>
              {requestMutation.isPending ? "Sending..." : "Send Reset Code"}
            </button>
            <div className="row gap-sm wrap-row">
              <a href="/" className="ghost-button" style={{ textDecoration: "none" }}>Back To Login</a>
            </div>
          </form>
        ) : null}
        {resetStage === "verify" && pending ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              setLocalError("");
              verifyMutation.mutate({ resetToken: pending.resetToken, code });
            }}
          >
            <p className="muted small-copy">Enter the six-digit verification code sent to {pending.emailMasked}.</p>
            <label className="field">
              <span>Verification Code</span>
              <input aria-label="Password reset verification code" inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            {devCode ? <p className="muted small-copy" aria-label="Development password reset code">Test code: <code>{devCode}</code></p> : null}
            {verifyMutation.error ? <p className="error">{verifyMutation.error.message}</p> : null}
            {resendMutation.error ? <p className="error">{resendMutation.error.message}</p> : null}
            <button type="submit" disabled={verifyMutation.isPending || !code.trim()}>
              {verifyMutation.isPending ? "Verifying..." : "Verify Code"}
            </button>
            <div className="row gap-sm wrap-row">
              <button type="button" className="secondary-button" disabled={resendMutation.isPending} onClick={() => resendMutation.mutate({ resetToken: pending.resetToken })}>
                {resendMutation.isPending ? "Sending..." : "Resend Code"}
              </button>
              <a href="/" className="ghost-button" style={{ textDecoration: "none" }} onClick={() => clearPendingPasswordReset()}>
                Cancel
              </a>
            </div>
          </form>
        ) : null}
        {resetStage === "reset" && pending ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              setLocalError("");
              if (newPassword !== confirmPassword) {
                setLocalError("Passwords don't match");
                return;
              }
              resetMutation.mutate({ resetToken: pending.resetToken, newPassword });
            }}
          >
            <p className="muted small-copy">Choose a new password for the account tied to {pending.emailMasked}.</p>
            <label className="field">
              <span>New Password</span>
              <input aria-label="Forgot password new password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </label>
            <label className="field">
              <span>Confirm New Password</span>
              <input aria-label="Forgot password confirm password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </label>
            {localError ? <p className="error">{localError}</p> : null}
            {resetMutation.error ? <p className="error">{resetMutation.error.message}</p> : null}
            <button type="submit" disabled={resetMutation.isPending || !newPassword || !confirmPassword}>
              {resetMutation.isPending ? "Resetting..." : "Reset Password"}
            </button>
            <div className="row gap-sm wrap-row">
              <a href="/" className="ghost-button" style={{ textDecoration: "none" }} onClick={() => clearPendingPasswordReset()}>
                Cancel
              </a>
            </div>
          </form>
        ) : null}
      </section>
    </FullscreenCenter>
  );
}
