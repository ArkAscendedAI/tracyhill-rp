import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import type { RequestAccountDeletionResponse } from "@tracyhill-rp/contracts";

import { confirmAccountDeletion, executeAccountDeletion, requestAccountDeletion, resendAccountDeletion } from "./authApi";

type DeleteAccountDialogProps = {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
  currentUsername: string;
};

export function DeleteAccountDialog({ open, onClose, onDeleted, currentUsername }: DeleteAccountDialogProps) {
  const [deleteStep, setDeleteStep] = useState<"confirm" | "verify" | "final">("confirm");
  const [confirmUsername, setConfirmUsername] = useState("");
  const [deleteCode, setDeleteCode] = useState("");
  const [deleteFlow, setDeleteFlow] = useState<(Pick<RequestAccountDeletionResponse, "deleteToken" | "emailMasked" | "devVerificationCode"> & { verified: boolean }) | null>(null);
  const requestDeleteMutation = useMutation({
    mutationFn: requestAccountDeletion,
    onSuccess: (data) => {
      setDeleteCode("");
      setDeleteFlow({ ...data, verified: false });
      setDeleteStep("verify");
    },
  });
  const resendDeleteMutation = useMutation({
    mutationFn: resendAccountDeletion,
    onSuccess: (data) => {
      setDeleteCode("");
      setDeleteFlow((current) => current ? {
        deleteToken: current.deleteToken,
        emailMasked: data.emailMasked,
        devVerificationCode: data.devVerificationCode,
        verified: false,
      } : current);
    },
  });
  const confirmDeleteMutation = useMutation({
    mutationFn: confirmAccountDeletion,
    onSuccess: () => {
      setDeleteCode("");
      setDeleteFlow((current) => current ? { ...current, verified: true } : current);
      setDeleteStep("final");
    },
  });
  const executeDeleteMutation = useMutation({
    mutationFn: executeAccountDeletion,
    onSuccess: () => {
      resetDialog();
      onDeleted();
    },
  });

  const resetDialog = () => {
    setDeleteStep("confirm");
    setConfirmUsername("");
    setDeleteCode("");
    setDeleteFlow(null);
    requestDeleteMutation.reset();
    resendDeleteMutation.reset();
    confirmDeleteMutation.reset();
    executeDeleteMutation.reset();
  };

  useEffect(() => {
    if (!open) resetDialog();
  }, [open]);

  if (!open) return null;

  const busy = requestDeleteMutation.isPending || resendDeleteMutation.isPending || confirmDeleteMutation.isPending || executeDeleteMutation.isPending;

  return (
    <div className="dialog-backdrop">
      <div className="dialog-card" role="dialog" aria-modal="true" aria-label="Delete Account">
        <div className="stack stack-tight">
          <div className="section-head">
            <div>
              <p className="eyebrow">Danger Zone</p>
              <h3>Delete Account</h3>
            </div>
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              Close
            </button>
          </div>
          {deleteStep === "confirm" ? (
            <div className="stack stack-tight">
              <p className="muted small-copy">This permanently deletes your account, sessions, attachments, generated images, campaigns, runs, templates, and remembered devices.</p>
              <p className="muted small-copy">Type <strong>{currentUsername}</strong> to continue.</p>
              <label className="stack stack-tight">
                <span className="muted small-copy">Username Confirmation</span>
                <input
                  aria-label="Delete account username confirmation"
                  value={confirmUsername}
                  onChange={(event) => setConfirmUsername(event.target.value)}
                  disabled={busy}
                />
              </label>
              <div className="row gap-sm end">
                <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => requestDeleteMutation.mutate()}
                  disabled={busy || confirmUsername.trim() !== currentUsername}
                >
                  {requestDeleteMutation.isPending ? "Sending..." : "Continue"}
                </button>
              </div>
            </div>
          ) : deleteStep === "verify" && deleteFlow ? (
            <div className="stack stack-tight">
              <p className="muted small-copy">A delete code was sent to {deleteFlow.emailMasked}. Enter it below to unlock permanent deletion.</p>
              {deleteFlow.devVerificationCode ? (
                <p aria-label="Development delete code" className="muted small-copy">Development delete code: <strong>{deleteFlow.devVerificationCode}</strong></p>
              ) : null}
              <label className="stack stack-tight">
                <span className="muted small-copy">Verification Code</span>
                <input aria-label="Delete verification code" value={deleteCode} onChange={(event) => setDeleteCode(event.target.value)} disabled={busy} />
              </label>
              <div className="row gap-sm end wrap-row">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setDeleteStep("confirm");
                    setDeleteCode("");
                    resendDeleteMutation.reset();
                    confirmDeleteMutation.reset();
                  }}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => resendDeleteMutation.mutate({ deleteToken: deleteFlow.deleteToken })}
                  disabled={busy}
                >
                  {resendDeleteMutation.isPending ? "Resending..." : "Resend delete code"}
                </button>
                <button
                  type="button"
                  onClick={() => confirmDeleteMutation.mutate({ deleteToken: deleteFlow.deleteToken, code: deleteCode })}
                  disabled={busy || !deleteCode.trim()}
                >
                  {confirmDeleteMutation.isPending ? "Verifying..." : "Verify delete code"}
                </button>
              </div>
            </div>
          ) : deleteFlow ? (
            <div className="stack stack-tight">
              <p className="muted small-copy">Delete verification complete for {deleteFlow.emailMasked}. This action cannot be undone.</p>
              <div style={{ background: "rgba(248,81,73,.12)", border: "1px solid rgba(248,81,73,.3)", borderRadius: 12, padding: 16 }}>
                <p style={{ margin: 0, color: "#f85149", fontWeight: 700 }}>THIS WILL PERMANENTLY DELETE ALL YOUR DATA</p>
                <p style={{ margin: "8px 0 0", color: "#f85149" }}>All conversations, campaigns, keys, generated images, and account information will be erased. This action cannot be undone.</p>
              </div>
              <div className="row gap-sm end">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setDeleteStep("verify");
                    executeDeleteMutation.reset();
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => executeDeleteMutation.mutate({ deleteToken: deleteFlow.deleteToken })}
                  disabled={busy}
                >
                  {executeDeleteMutation.isPending ? "Deleting..." : "Delete My Account"}
                </button>
              </div>
            </div>
          ) : null}
          {requestDeleteMutation.error ? <p className="error">{requestDeleteMutation.error.message}</p> : null}
          {resendDeleteMutation.error ? <p className="error">{resendDeleteMutation.error.message}</p> : null}
          {confirmDeleteMutation.error ? <p className="error">{confirmDeleteMutation.error.message}</p> : null}
          {executeDeleteMutation.error ? <p className="error">{executeDeleteMutation.error.message}</p> : null}
        </div>
      </div>
    </div>
  );
}
