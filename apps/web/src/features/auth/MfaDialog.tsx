import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getMfaStatus, revokeAllTrustedDevices, revokeTrustedDevice } from "./authApi";

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
  const revokeDeviceMutation = useMutation({
    mutationFn: revokeTrustedDevice,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["account", "mfa-status"] });
    },
  });
  const revokeAllDevicesMutation = useMutation({
    mutationFn: revokeAllTrustedDevices,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["account", "mfa-status"] });
    },
  });

  if (!open) return null;

  const busy = revokeDeviceMutation.isPending || revokeAllDevicesMutation.isPending;

  return (
    <div className="dialog-backdrop">
      <div className="dialog-card" role="dialog" aria-modal="true" aria-label="MFA">
        <div className="stack stack-tight">
          <div className="section-head">
            <div>
              <p className="eyebrow">Security</p>
              <h3>MFA Status</h3>
            </div>
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              Close
            </button>
          </div>
          {mfaStatusQuery.isLoading ? <p className="muted small-copy">Loading MFA status…</p> : null}
          {mfaStatusQuery.error ? <p className="error">{mfaStatusQuery.error.message}</p> : null}
          {mfaStatusQuery.data ? (
            <p className="muted small-copy">
              {mfaStatusQuery.data.enabled
                ? `Email MFA is active for ${mfaStatusQuery.data.emailMasked}.`
                : mfaStatusQuery.data.emailMasked
                  ? `Email MFA is inactive until ${mfaStatusQuery.data.emailMasked} is verified.`
                  : "No MFA email is configured for this account."}
            </p>
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
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => revokeDeviceMutation.mutate(device.id)}>
                      Revoke
                    </button>
                  </div>
                ))}
                <div className="row gap-sm end">
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => revokeAllDevicesMutation.mutate()}>
                    Revoke All Devices
                  </button>
                </div>
              </div>
            ) : (
              mfaStatusQuery.isLoading ? null : <p className="muted small-copy">No trusted devices are saved for this account.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
