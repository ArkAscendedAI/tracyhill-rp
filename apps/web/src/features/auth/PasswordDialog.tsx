import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { changePassword } from "./authApi";

type PasswordDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function PasswordDialog({ open, onClose }: PasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setLocalError("");
      onClose();
    },
  });

  if (!open) return null;

  const submit = () => {
    setLocalError("");
    if (!currentPassword || !newPassword) {
      setLocalError("Current and new password required");
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError("Passwords don't match");
      return;
    }
    mutation.mutate({ currentPassword, newPassword });
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog-card" role="dialog" aria-modal="true" aria-label="Password">
        <div className="stack stack-tight">
          <div className="section-head">
            <div>
              <p className="eyebrow">Account</p>
              <h3>Change Password</h3>
            </div>
            <button type="button" className="secondary-button" onClick={onClose} disabled={mutation.isPending}>
              Close
            </button>
          </div>
          <p className="muted small-copy">Passwords must be 8-128 characters and include uppercase, lowercase, and numeric characters.</p>
          <label className="stack stack-tight">
            <span className="muted small-copy">Current Password</span>
            <input aria-label="Current password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={mutation.isPending} />
          </label>
          <label className="stack stack-tight">
            <span className="muted small-copy">New Password</span>
            <input aria-label="New password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={mutation.isPending} />
          </label>
          <label className="stack stack-tight">
            <span className="muted small-copy">Confirm New Password</span>
            <input aria-label="Confirm new password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={mutation.isPending} />
          </label>
          {localError ? <p className="error">{localError}</p> : null}
          {mutation.error ? <p className="error">{mutation.error.message}</p> : null}
          <div className="row gap-sm wrap-row">
            <a href="/terms" className="ghost-button" style={{ textDecoration: "none" }}>Terms</a>
            <a href="/privacy" className="ghost-button" style={{ textDecoration: "none" }}>Privacy</a>
          </div>
          <div className="row gap-sm end">
            <button type="button" className="secondary-button" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={mutation.isPending}>
              {mutation.isPending ? "Saving..." : "Change Password"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
