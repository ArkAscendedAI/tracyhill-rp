import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { login } from "./authApi";
import { savePendingMfa } from "./mfaStorage";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

export function LoginPage() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: login,
    onSuccess: async (response) => {
      setPassword("");
      if ("mfaRequired" in response) {
        savePendingMfa({
          mfaSessionToken: response.mfaSessionToken,
          emailMasked: response.emailMasked,
          ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
        });
        window.location.assign("/mfa");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });

  return (
    <FullscreenCenter>
      <section className="auth-card">
        <img src="/TracyHill-RP-Logo-Horizontal.png" alt="TracyHill RP" className="auth-logo" />
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
          <div className="auth-link-row">
            <a href="/forgot-password" className="auth-link">Forgot password?</a>
          </div>
        </form>
        <div className="auth-footer">
          Don't have an account? <a href="/register" className="auth-link">Create one</a>
        </div>
      </section>
    </FullscreenCenter>
  );
}
