import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ConfirmForcedTwoFactorSetupResponse } from "@tracyhill-rp/contracts";

import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";
import { confirmForcedTwoFactorSetup, startForcedTwoFactorSetup } from "./authApi";
import { completeSignIn } from "./authCache";
import { clearPendingTwoFactorSetup, loadPendingTwoFactorSetup } from "./mfaStorage";
import { RecoveryCodesBlock, TotpSetupBlock } from "./TwoFactorParts";

// Required two-factor at sign-in: the account sets up an authenticator before it is signed in. The page
// asks the server for a key once, confirms it with a current code, shows the recovery codes once, then signs in.

export function TwoFactorSetupPage() {
  const queryClient = useQueryClient();
  const [setupToken] = useState(loadPendingTwoFactorSetup);
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [done, setDone] = useState<ConfirmForcedTwoFactorSetupResponse | null>(null);
  const start = useMutation({ mutationFn: startForcedTwoFactorSetup });
  const confirm = useMutation({
    mutationFn: confirmForcedTwoFactorSetup,
    onSuccess: (response) => {
      clearPendingTwoFactorSetup();
      setCode("");
      setDone(response);
    },
  });
  // One key per visit: a second start would replace the one already scanned.
  const started = useRef(false);
  useEffect(() => {
    if (!setupToken || started.current) return;
    started.current = true;
    start.mutate({ setupToken });
  }, [setupToken, start]);

  const logo = <img src="/brand/logo-horizontal-480.webp" srcSet="/brand/logo-horizontal-480.webp 1x, /brand/logo-horizontal-960.webp 2x" alt="TracyHill RP" className="login-logo" />;

  if (!setupToken && !done) {
    return (
      <FullscreenCenter>
        <section className="card stack">
          {logo}
          <h1>Set Up Two-Step Sign-In</h1>
          <p className="muted small-copy">This setup has expired or was already finished. Sign in again.</p>
          <a href="/" className="ghost-button" style={{ textDecoration: "none" }}>Back To Login</a>
        </section>
      </FullscreenCenter>
    );
  }

  if (done) {
    return (
      <FullscreenCenter>
        <section className="card stack">
          {logo}
          <h1>You're Set Up</h1>
          <RecoveryCodesBlock
            codes={done.recoveryCodes}
            doneLabel="I saved them, continue"
            onDone={() => {
              window.history.replaceState(null, "", "/");
              completeSignIn(queryClient, done.user);
            }}
          />
        </section>
      </FullscreenCenter>
    );
  }

  return (
    <FullscreenCenter>
      <section className="card stack">
        {logo}
        <h1>Set Up Two-Step Sign-In</h1>
        <p className="muted small-copy">This server asks everyone for a second step when they sign in. Set up an authenticator app on your phone to continue.</p>
        {start.isPending ? <p className="muted small-copy">Preparing your key…</p> : null}
        {start.error ? <p className="error">{start.error.message}</p> : null}
        {start.data ? <TotpSetupBlock setup={start.data} /> : null}
        {start.data ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              confirm.mutate({ setupToken: setupToken!, code, trustDevice });
            }}
          >
            <label className="field">
              <span>Code from the app</span>
              <input aria-label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
            <label className="row gap-sm wrap-row">
              <input aria-label="Trust this device" type="checkbox" checked={trustDevice} onChange={(event) => setTrustDevice(event.target.checked)} />
              <span className="muted small-copy">Trust this device for future sign-ins on this browser.</span>
            </label>
            {confirm.error ? <p className="error">{confirm.error.message}</p> : null}
            <button type="submit" disabled={confirm.isPending || !code.trim()}>{confirm.isPending ? "Checking..." : "Confirm And Sign In"}</button>
            <a href="/" className="ghost-button" style={{ textDecoration: "none" }} onClick={() => clearPendingTwoFactorSetup()}>Cancel</a>
          </form>
        ) : null}
      </section>
    </FullscreenCenter>
  );
}
