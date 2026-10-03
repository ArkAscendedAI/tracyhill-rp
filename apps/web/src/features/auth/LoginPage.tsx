import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { completeSignIn } from "./authCache";
import { login } from "./authApi";
import { savePendingMfa, savePendingTwoFactorSetup } from "./mfaStorage";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

type LoginPageProps = {
  // Embedded = rendered inside the session-lapsed overlay over a still-mounted
  // AppShell: no full-screen wrapper, and an MFA challenge is handed
  // to the host instead of navigating (a navigation would drop the shell and
  // the unsent composer text with it).
  embedded?: boolean;
  onMfaRequired?: () => void;
  // The server settings: sign-up is open (switched on, and email works), and a forgotten password can be
  // reset by email. A link that cannot finish is replaced by "ask the administrator".
  registrationOpen?: boolean;
  passwordResetAvailable?: boolean;
};

export function LoginPage({ embedded = false, onMfaRequired, registrationOpen = true, passwordResetAvailable = true }: LoginPageProps = {}) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: login,
    onSuccess: async (response) => {
      setPassword("");
      // Two-factor is Required and this account has none yet: set up an authenticator first. From the
      // re-login overlay too, since nothing can be signed in before it.
      if ("twoFactorSetupRequired" in response) {
        savePendingTwoFactorSetup(response.setupToken);
        window.location.assign("/two-factor-setup");
        return;
      }
      if ("mfaRequired" in response) {
        savePendingMfa({
          mfaSessionToken: response.mfaSessionToken,
          emailMasked: response.emailMasked,
          ...(response.methods ? { methods: response.methods } : {}),
          ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
        });
        if (onMfaRequired) onMfaRequired();
        else window.location.assign("/mfa");
        return;
      }
      // Purges the previous account's cached queries BEFORE the shell can
      // render them; keeps them for the same user re-unlocking.
      completeSignIn(queryClient, response.user);
    },
  });

  const card = (
      <section className="auth-card">
        <img src="/brand/logo-horizontal-480.webp" srcSet="/brand/logo-horizontal-480.webp 1x, /brand/logo-horizontal-960.webp 2x" alt="TracyHill RP" className="auth-logo" />
        <p className="auth-sub">Authenticate to continue.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({ username, password });
          }}
        >
          <input
            className="auth-input"
            type="text"
            placeholder="Username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <input
            className="auth-input"
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {mutation.error ? <p className="auth-error">{mutation.error.message}</p> : null}
          <button type="submit" className="auth-submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Unlocking..." : "Unlock"}
          </button>
          {embedded || !passwordResetAvailable ? null : (
            <div className="auth-link-row">
              <a href="/forgot-password" className="auth-link">Forgot password?</a>
            </div>
          )}
        </form>
        {embedded ? null : registrationOpen ? (
          <div className="auth-footer">
            Don't have an account? <a href="/register" className="auth-link">Create one</a>
          </div>
        ) : (
          <div className="auth-footer">
            {passwordResetAvailable ? "Need an account? Ask the server's administrator." : "Need an account or a new password? Ask the server's administrator."}
          </div>
        )}
      </section>
  );

  return embedded ? card : <FullscreenCenter>{card}</FullscreenCenter>;
}
