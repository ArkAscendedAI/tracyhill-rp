import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getMfaStatus, requestEmailChange, revokeAllTrustedDevices, revokeTrustedDevice, verifyEmailChange } from "./authApi";
import { AuthenticatorSection } from "./AuthenticatorSection";
import { Dialog } from "../../shared/ui/Dialog";

type MfaDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function MfaDialog({ open, onClose }: MfaDialogProps) {
  const queryClient = useQueryClient();
  const mfaStatusQuery = useQuery({
    queryKey: ["account", "mfa-status"],
    queryFn: getMfaStatus,
    enabled: open,
  });
  // Revoking asks first, inside this dialog: the device id awaiting confirmation, or "all".
  const [confirmingRevoke, setConfirmingRevoke] = useState<number | "all" | null>(null);
  const revokeDeviceMutation = useMutation({
    mutationFn: revokeTrustedDevice,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["account", "mfa-status"] });
      setConfirmingRevoke(null);
    },
  });
  const revokeAllDevicesMutation = useMutation({
    mutationFn: revokeAllTrustedDevices,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["account", "mfa-status"] });
      setConfirmingRevoke(null);
    },
  });

  // Set/change-email flow. Admin-created
  // accounts start with no email, which used to leave MFA and the staged
  // self-delete permanently unreachable — the "inactive until … is verified"
  // copy below had no path that could ever satisfy it.
  const [emailFormOpen, setEmailFormOpen] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailChallenge, setEmailChallenge] = useState<{ emailToken: string; emailMasked: string; devVerificationCode?: string } | null>(null);
  const resetEmailFlow = () => {
    setEmailFormOpen(false);
    setEmailDraft("");
    setEmailPassword("");
    setEmailCode("");
    setEmailChallenge(null);
    requestEmailMutation.reset();
    verifyEmailMutation.reset();
  };
  const requestEmailMutation = useMutation({
    mutationFn: requestEmailChange,
    onSuccess: (response) => {
      setEmailPassword("");
      setEmailCode("");
      setEmailChallenge({
        emailToken: response.emailToken,
        emailMasked: response.emailMasked,
        ...(response.devVerificationCode ? { devVerificationCode: response.devVerificationCode } : {}),
      });
    },
  });
  const verifyEmailMutation = useMutation({
    mutationFn: verifyEmailChange,
    onSuccess: async () => {
      resetEmailFlow();
      await queryClient.invalidateQueries({ queryKey: ["account", "mfa-status"] });
    },
  });

  if (!open) return null;

  const busy = revokeDeviceMutation.isPending || revokeAllDevicesMutation.isPending || requestEmailMutation.isPending || verifyEmailMutation.isPending;
  const status = mfaStatusQuery.data;
  // The server reports enabled = a verified email AND email delivery (authService getMfaStatus), so a
  // verified address that is not enabled means this server cannot send email: that user has nothing
  // to verify.
  const needsEmail = status ? !status.enabled && !(status.emailMasked && status.emailVerified) : false;
  // The same reading tells the dialog that a change request would always answer 503 "Email verification is not
  // available", so it says why instead of offering one.
  const cannotSendEmail = status ? !status.enabled && Boolean(status.emailMasked && status.emailVerified) : false;

  return (
    <Dialog open onClose={onClose} label="MFA" eyebrow="Security" title="MFA Status" icon="shield" size="md" closeDisabled={busy}>
        <div className="stack stack-tight">
          <AuthenticatorSection open={open} />
          {mfaStatusQuery.isLoading ? <p className="muted small-copy">Loading MFA status…</p> : null}
          {mfaStatusQuery.error ? <p className="error">{mfaStatusQuery.error.message}</p> : null}
          {mfaStatusQuery.data ? (
            <p className="muted small-copy">
              {mfaStatusQuery.data.enabled
                ? `Email MFA is active for ${mfaStatusQuery.data.emailMasked}.`
                : mfaStatusQuery.data.emailMasked
                  ? mfaStatusQuery.data.emailVerified
                    ? `Email MFA is unavailable because this server cannot send email. Your address ${mfaStatusQuery.data.emailMasked} is verified.`
                    : `Email MFA is inactive until ${mfaStatusQuery.data.emailMasked} is verified.`
                  : "No MFA email is configured for this account."}
            </p>
          ) : null}
          {status && !emailFormOpen ? (
            <div className="row gap-sm wrap-row">
              {cannotSendEmail ? (
                <span className="muted small-copy">The address cannot be changed here, because the change is confirmed by a code sent to the new address.</span>
              ) : (
                <button type="button" className="secondary-button" disabled={busy} onClick={() => setEmailFormOpen(true)}>
                  {status.emailMasked ? "Change Email" : "Set Email Address"}
                </button>
              )}
              {needsEmail ? <span className="muted small-copy">A verified email is required for MFA and for deleting your own account.</span> : null}
            </div>
          ) : null}
          {emailFormOpen && !emailChallenge ? (
            <form
              className="stack stack-tight"
              onSubmit={(event) => {
                event.preventDefault();
                requestEmailMutation.mutate({ email: emailDraft.trim(), currentPassword: emailPassword });
              }}
            >
              <label className="field">
                <span>Email Address</span>
                <input aria-label="Account email address" type="email" autoComplete="email" value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} />
              </label>
              <label className="field">
                <span>Current Password</span>
                <input aria-label="Account email current password" type="password" autoComplete="current-password" value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} />
              </label>
              <p className="muted small-copy">A six-digit code is sent to the new address; the email becomes active once you enter it.</p>
              {requestEmailMutation.error ? <p className="error">{requestEmailMutation.error.message}</p> : null}
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" disabled={busy} onClick={resetEmailFlow}>Cancel</button>
                <button type="submit" disabled={busy || !emailDraft.trim() || !emailPassword}>
                  {requestEmailMutation.isPending ? "Sending..." : "Send Code"}
                </button>
              </div>
            </form>
          ) : null}
          {emailFormOpen && emailChallenge ? (
            <form
              className="stack stack-tight"
              onSubmit={(event) => {
                event.preventDefault();
                verifyEmailMutation.mutate({ emailToken: emailChallenge.emailToken, code: emailCode });
              }}
            >
              <p className="muted small-copy">Enter the six-digit code sent to {emailChallenge.emailMasked}.</p>
              <label className="field">
                <span>Verification Code</span>
                <input aria-label="Account email verification code" inputMode="numeric" value={emailCode} onChange={(event) => setEmailCode(event.target.value)} />
              </label>
              {emailChallenge.devVerificationCode ? <p className="muted small-copy" aria-label="Development email verification code">Test code: <code>{emailChallenge.devVerificationCode}</code></p> : null}
              {verifyEmailMutation.error ? <p className="error">{verifyEmailMutation.error.message}</p> : null}
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" disabled={busy} onClick={resetEmailFlow}>Cancel</button>
                <button type="submit" disabled={busy || !emailCode.trim()}>
                  {verifyEmailMutation.isPending ? "Verifying..." : "Verify Email"}
                </button>
              </div>
            </form>
          ) : null}
          <hr />
          <div className="stack stack-tight">
            <div>
              <p className="eyebrow">Security</p>
              <h3>Trusted Devices</h3>
            </div>
            {revokeDeviceMutation.error ? <p className="error">{revokeDeviceMutation.error.message}</p> : null}
            {revokeAllDevicesMutation.error ? <p className="error">{revokeAllDevicesMutation.error.message}</p> : null}
            {mfaStatusQuery.data?.trustedDevices.length ? (
              <div className="stack stack-tight">
                {mfaStatusQuery.data.trustedDevices.map((device) => (
                  <div key={`${device.id}-${device.createdAt}`} className="row gap-sm wrap-row space-between">
                    <div className="stack stack-tight">
                      <strong>{device.label}</strong>
                      <span className="muted small-copy">Added {new Date(device.createdAt).toLocaleString()}</span>
                      <span className="muted small-copy">Last used {new Date(device.lastUsed).toLocaleString()} · {device.tokenPreview}</span>
                    </div>
                    {confirmingRevoke === device.id ? (
                      <div className="stack stack-tight">
                        <p className="error">Revoke <strong>{device.label}</strong>? MFA will be required on this device at its next sign-in.</p>
                        <div className="row gap-sm end">
                          <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingRevoke(null)}>
                            Cancel
                          </button>
                          <button type="button" className="danger-button" disabled={busy} onClick={() => revokeDeviceMutation.mutate(device.id)}>
                            {revokeDeviceMutation.isPending ? "Revoking..." : "Confirm Revoke"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingRevoke(device.id)}>
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
                {confirmingRevoke === "all" ? (
                  <div className="stack stack-tight">
                    <p className="error">Revoke all trusted devices? You will need to complete MFA again on every device the next time you sign in.</p>
                    <div className="row gap-sm end">
                      <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingRevoke(null)}>
                        Cancel
                      </button>
                      <button type="button" className="danger-button" disabled={busy} onClick={() => revokeAllDevicesMutation.mutate()}>
                        {revokeAllDevicesMutation.isPending ? "Revoking..." : "Confirm Revoke All"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="row gap-sm end">
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmingRevoke("all")}>
                      Revoke All Devices
                    </button>
                  </div>
                )}
              </div>
            ) : (
              // Empty-state copy only for a successful read; a failed one already shows its error above.
              mfaStatusQuery.isSuccess ? <p className="muted small-copy">No trusted devices are saved for this account.</p> : null
            )}
          </div>
        </div>
    </Dialog>
  );
}
