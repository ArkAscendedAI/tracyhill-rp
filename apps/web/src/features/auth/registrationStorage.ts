const REGISTRATION_STORAGE_KEY = "trp.registration.pending";

export type PendingRegistrationState = {
  registrationToken: string;
  emailMasked: string;
  devVerificationCode?: string;
};

export function loadPendingRegistration(): PendingRegistrationState | null {
  try {
    const raw = window.sessionStorage.getItem(REGISTRATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRegistrationState>;
    if (!parsed.registrationToken || !parsed.emailMasked) return null;
    return {
      registrationToken: parsed.registrationToken,
      emailMasked: parsed.emailMasked,
      ...(parsed.devVerificationCode ? { devVerificationCode: parsed.devVerificationCode } : {}),
    };
  } catch {
    return null;
  }
}

export function savePendingRegistration(state: PendingRegistrationState) {
  window.sessionStorage.setItem(REGISTRATION_STORAGE_KEY, JSON.stringify(state));
}

export function clearPendingRegistration() {
  window.sessionStorage.removeItem(REGISTRATION_STORAGE_KEY);
}
