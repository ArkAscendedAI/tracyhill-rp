import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { register } from "./authApi";
import { savePendingRegistration } from "./registrationStorage";
import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

export function RegistrationPage() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [localError, setLocalError] = useState("");
  const mutation = useMutation({
    mutationFn: register,
    onSuccess: async (response) => {
      setPassword("");
      setConfirmPassword("");
      setLocalError("");
      savePendingRegistration({
        registrationToken: response.registrationToken,
        emailMasked: response.emailMasked,
        ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
      window.location.assign("/register/verify");
    },
  });

  return (
    <FullscreenCenter>
      <section className="card">
        <img src="/TracyHill-RP-Logo-Horizontal.png" alt="TracyHill RP" className="login-logo" style={{ width: "100%", maxHeight: "60px", objectFit: "contain", marginBottom: "1rem" }} />
        <h1>Register</h1>
        <p className="muted small-copy">Create your account, then verify the email code before signing in.</p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            setLocalError("");
            if (password !== confirmPassword) {
              setLocalError("Passwords don't match");
              return;
            }
            mutation.mutate({ username, email, password, agreedToTerms: agreedToTerms as true });
          }}
        >
          <label className="field">
            <span>Username</span>
            <input aria-label="Register username" value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="field">
            <span>Email</span>
            <input aria-label="Register email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="field">
            <span>Password</span>
            <input aria-label="Register password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <label className="field">
            <span>Confirm Password</span>
            <input aria-label="Register confirm password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </label>
          <label className="row gap-sm align-left">
            <input aria-label="Agree to terms" type="checkbox" checked={agreedToTerms} onChange={(event) => setAgreedToTerms(event.target.checked)} />
            <span className="muted small-copy">I agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</span>
          </label>
          {localError ? <p className="error">{localError}</p> : null}
          {mutation.error ? <p className="error">{mutation.error.message}</p> : null}
          <button type="submit" disabled={mutation.isPending || !agreedToTerms}>
            {mutation.isPending ? "Creating Account..." : "Create Account"}
          </button>
          <div className="row gap-sm wrap-row">
            <a href="/" className="ghost-button" style={{ textDecoration: "none" }}>Back To Login</a>
            <a href="/terms" className="ghost-button" style={{ textDecoration: "none" }}>Terms</a>
            <a href="/privacy" className="ghost-button" style={{ textDecoration: "none" }}>Privacy</a>
          </div>
        </form>
      </section>
    </FullscreenCenter>
  );
}
