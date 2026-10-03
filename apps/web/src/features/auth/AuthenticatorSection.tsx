import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { confirmTotp, disableTotp, getTwoFactorStatus, regenerateRecoveryCodes, startTotp } from "./authApi";
import { RecoveryCodesBlock, TotpSetupBlock } from "./TwoFactorParts";

// The account's authenticator app, at the top of the MFA dialog: set one up or replace it, replace the
// recovery codes, or turn it off. Each change asks for the password again; turning it off also asks for a code.

export const TWO_FACTOR_STATUS_KEY = ["account", "two-factor"] as const;

type Step =
  | { kind: "idle" }
  | { kind: "password"; purpose: "setup" | "codes" | "off" }
  | { kind: "scan" }
  | { kind: "codes"; codes: string[] };

export function AuthenticatorSection({ open }: { open: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: TWO_FACTOR_STATUS_KEY, queryFn: getTwoFactorStatus, enabled: open });
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: TWO_FACTOR_STATUS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["account", "mfa-status"] });
  };
  const reset = () => {
    setStep({ kind: "idle" });
    setPassword("");
    setCode("");
    start.reset();
    confirm.reset();
    off.reset();
    codes.reset();
  };
  const start = useMutation({ mutationFn: startTotp, onSuccess: () => { setPassword(""); setStep({ kind: "scan" }); } });
  const confirm = useMutation({ mutationFn: confirmTotp, onSuccess: (response) => { setCode(""); setStep({ kind: "codes", codes: response.recoveryCodes }); refresh(); } });
  const off = useMutation({ mutationFn: disableTotp, onSuccess: () => { reset(); refresh(); } });
  const codes = useMutation({ mutationFn: regenerateRecoveryCodes, onSuccess: (response) => { setPassword(""); setStep({ kind: "codes", codes: response.recoveryCodes }); refresh(); } });

  const data = status.data;
  if (!data) return status.error ? <p className="error">{status.error.message}</p> : null;
  if (!data.methods.totp && !data.totp.enabled) return null;
  const enabled = data.totp.enabled;
  const error = start.error ?? confirm.error ?? off.error ?? codes.error;
  const policyLine = data.policy === "required"
    ? "This server requires a second step for every sign-in."
    : data.policy === "off"
      ? "Two-step sign-in is off on this server, so the app is not asked for at the moment."
      : "Optional on this server: once set up, every sign-in asks for a code from the app.";

  return (
    <section className="stack stack-tight authenticator-section" aria-label="Authenticator app">
      <h3>Authenticator App</h3>
      <p className="muted small-copy">
        {enabled ? `Set up. ${data.totp.recoveryCodesLeft} of 10 recovery codes left.` : "Not set up."} {policyLine}
      </p>
      {error ? <p className="error">{error.message}</p> : null}

      {step.kind === "idle" ? (
        <div className="row gap-sm wrap-row">
          <button type="button" className="secondary-button" onClick={() => setStep({ kind: "password", purpose: "setup" })}>{enabled ? "Replace Authenticator" : "Set Up Authenticator"}</button>
          {enabled ? <button type="button" className="secondary-button" onClick={() => setStep({ kind: "password", purpose: "codes" })}>New Recovery Codes</button> : null}
          {enabled && data.policy !== "required" ? <button type="button" className="danger-button" onClick={() => setStep({ kind: "password", purpose: "off" })}>Turn Off</button> : null}
        </div>
      ) : null}

      {step.kind === "password" ? (
        <form
          className="stack stack-tight"
          onSubmit={(event) => {
            event.preventDefault();
            if (step.purpose === "setup") start.mutate({ password });
            else if (step.purpose === "codes") codes.mutate({ password });
            else off.mutate({ password, code });
          }}
        >
          <label className="field">
            <span>Current Password</span>
            <input aria-label="Authenticator current password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {step.purpose === "off" ? (
            <label className="field">
              <span>Code from the app, or a recovery code</span>
              <input aria-label="Authenticator code to turn off" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
            </label>
          ) : null}
          <div className="row gap-sm wrap-row">
            <button type="submit" disabled={!password || (step.purpose === "off" && !code.trim()) || start.isPending || codes.isPending || off.isPending}>
              {step.purpose === "setup" ? "Continue" : step.purpose === "codes" ? "Make New Codes" : "Turn Off"}
            </button>
            <button type="button" className="ghost-button" onClick={reset}>Cancel</button>
          </div>
        </form>
      ) : null}

      {step.kind === "scan" && start.data ? (
        <form
          className="stack stack-tight"
          onSubmit={(event) => {
            event.preventDefault();
            confirm.mutate({ code });
          }}
        >
          <TotpSetupBlock setup={start.data} />
          {enabled ? <p className="muted small-copy">Your current authenticator keeps working until you confirm this one.</p> : null}
          <label className="field">
            <span>Code from the app</span>
            <input aria-label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
          </label>
          <div className="row gap-sm wrap-row">
            <button type="submit" disabled={!code.trim() || confirm.isPending}>{confirm.isPending ? "Checking..." : "Confirm"}</button>
            <button type="button" className="ghost-button" onClick={reset}>Cancel</button>
          </div>
        </form>
      ) : null}

      {step.kind === "codes" ? <RecoveryCodesBlock codes={step.codes} doneLabel="Done" onDone={reset} /> : null}
    </section>
  );
}
