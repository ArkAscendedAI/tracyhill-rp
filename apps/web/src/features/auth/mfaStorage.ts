const MFA_STORAGE_KEY = "trp.auth.mfa";

export type PendingMfaState = {
  mfaSessionToken: string;
  emailMasked: string;
  devVerificationCode?: string;
};

export function loadPendingMfa(): PendingMfaState | null {
  try {
    const raw = window.sessionStorage.getItem(MFA_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingMfaState>;
    if (!parsed.mfaSessionToken || !parsed.emailMasked) return null;
    return {
      mfaSessionToken: parsed.mfaSessionToken,
      emailMasked: parsed.emailMasked,
      ...(parsed.devVerificationCode ? { devVerificationCode: parsed.devVerificationCode } : {}),
    };
  } catch {
    return null;
  }
}

export function savePendingMfa(state: PendingMfaState) {
  window.sessionStorage.setItem(MFA_STORAGE_KEY, JSON.stringify(state));
}

export function clearPendingMfa() {
  window.sessionStorage.removeItem(MFA_STORAGE_KEY);
}
