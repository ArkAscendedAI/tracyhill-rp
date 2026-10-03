import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { acceptInvite, peekInvite } from "./authApi";
import { completeSignIn } from "./authCache";
import { savePendingTwoFactorSetup } from "./mfaStorage";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

// An invite link: /invite/<token>. The person picks a username (unless
// the invite fixes one) and a password and is signed in at once. Under Required two-step sign-in they set up an
// authenticator first, exactly as at sign-in. Works with sign-up off and without email.

export function inviteTokenFromPath(pathname: string): string {
  return /^\/invite\/([A-Za-z0-9_-]+)\/?$/.exec(pathname)?.[1] ?? "";
}

export function InviteAcceptPage() {
  const queryClient = useQueryClient();
  const token = inviteTokenFromPath(window.location.pathname);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [localError, setLocalError] = useState("");
  const invite = useQuery({ queryKey: ["invite", token], queryFn: () => peekInvite(token), enabled: Boolean(token), retry: false });
  const mutation = useMutation({
    mutationFn: acceptInvite,
    onSuccess: (response) => {
      setPassword("");
      setConfirmPassword("");
      if ("twoFactorSetupRequired" in response) {
        savePendingTwoFactorSetup(response.setupToken);
        window.location.assign("/two-factor-setup");
        return;
      }
      completeSignIn(queryClient, response.user);
    },
  });

  const details = invite.data;
  const unusable = !token
    ? "This invite link is not valid."
    : details && !details.valid ? details.reason ?? "This invite can no longer be used." : null;
  const fixedUsername = details?.username ?? null;
  const termsRequired = details?.termsRequired ?? true;

  return (
    <FullscreenCenter>
      <section className="card">
        <img src="/brand/logo-horizontal-480.webp" srcSet="/brand/logo-horizontal-480.webp 1x, /brand/logo-horizontal-960.webp 2x" alt="TracyHill RP" className="login-logo" style={{ width: "100%", maxHeight: "60px", objectFit: "contain", marginBottom: "1rem" }} />
        <h1>Create your account</h1>
        {unusable ? (
          <p className="muted small-copy">{unusable}</p>
        ) : invite.isLoading ? (
          <p className="muted small-copy">Checking the invite…</p>
        ) : invite.isError ? (
          <p className="error">The invite could not be checked: {invite.error.message}</p>
        ) : (
          <>
            <p className="muted small-copy">
              {fixedUsername ? <>You have been invited to this server as <strong>{fixedUsername}</strong>. Choose a password.</> : "You have been invited to this server. Choose a username and a password."}
            </p>
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                setLocalError("");
                if (password !== confirmPassword) {
                  setLocalError("Passwords don't match");
                  return;
                }
                mutation.mutate({ token, username: fixedUsername ?? username, password, ...(termsRequired ? { agreedToTerms } : {}) });
              }}
            >
              {fixedUsername ? null : (
                <label className="field">
                  <span>Username</span>
                  <input aria-label="Invite username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
                </label>
              )}
              <label className="field">
                <span>Password</span>
                <input aria-label="Invite password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <label className="field">
                <span>Confirm Password</span>
                <input aria-label="Invite confirm password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </label>
              {termsRequired ? (
                <label className="row gap-sm align-left">
                  <input aria-label="Agree to terms" type="checkbox" checked={agreedToTerms} onChange={(event) => setAgreedToTerms(event.target.checked)} />
                  <span className="muted small-copy">I agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</span>
                </label>
              ) : null}
              {localError ? <p className="error">{localError}</p> : null}
              {mutation.error ? <p className="error">{mutation.error.message}</p> : null}
              <button type="submit" disabled={mutation.isPending || (termsRequired && !agreedToTerms) || (!fixedUsername && !username.trim()) || !password}>
                {mutation.isPending ? "Creating Account..." : "Create Account"}
              </button>
            </form>
          </>
        )}
        <div className="row gap-sm wrap-row">
          <a href="/" className="ghost-button" style={{ textDecoration: "none" }}>Back To Login</a>
        </div>
      </section>
    </FullscreenCenter>
  );
}
