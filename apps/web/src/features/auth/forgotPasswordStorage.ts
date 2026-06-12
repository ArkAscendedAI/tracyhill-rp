const FORGOT_PASSWORD_STORAGE_KEY = "trp.forgot-password.pending";

export type PendingPasswordResetState = {
  resetToken: string;
  emailMasked: string;
  verified?: boolean;
  devVerificationCode?: string;
};

export function loadPendingPasswordReset(): PendingPasswordResetState | null {
  try {
    const raw = window.sessionStorage.getItem(FORGOT_PASSWORD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPasswordResetState>;
    if (!parsed.resetToken || !parsed.emailMasked) return null;
    return {
      resetToken: parsed.resetToken,
      emailMasked: parsed.emailMasked,
      ...(parsed.verified ? { verified: true } : {}),
      ...(parsed.devVerificationCode ? { devVerificationCode: parsed.devVerificationCode } : {}),
    };
  } catch {
    return null;
  }
}

export function savePendingPasswordReset(state: PendingPasswordResetState) {
  window.sessionStorage.setItem(FORGOT_PASSWORD_STORAGE_KEY, JSON.stringify(state));
}

export function clearPendingPasswordReset() {
  window.sessionStorage.removeItem(FORGOT_PASSWORD_STORAGE_KEY);
}
