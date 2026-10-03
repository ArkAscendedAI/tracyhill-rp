import type { SecondFactorMethod } from "@tracyhill-rp/contracts";

const MFA_STORAGE_KEY = "trp.auth.mfa";
const SETUP_STORAGE_KEY = "trp.auth.two-factor-setup";

export type PendingMfaState = {
  mfaSessionToken: string;
  // Where the email code went; blank when none was sent (an authenticator is asked for first).
  emailMasked: string;
  // What this sign-in accepts; absent from older servers, where it was the email code alone.
  methods?: SecondFactorMethod[];
  devVerificationCode?: string;
};

const METHODS: readonly SecondFactorMethod[] = ["totp", "recovery", "email"];

export function loadPendingMfa(): PendingMfaState | null {
  try {
    const raw = window.sessionStorage.getItem(MFA_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingMfaState>;
    if (!parsed.mfaSessionToken) return null;
    const methods = Array.isArray(parsed.methods) ? parsed.methods.filter((method): method is SecondFactorMethod => METHODS.includes(method)) : undefined;
    // An older challenge without methods was the email code alone, and always had an address.
    if (!methods && !parsed.emailMasked) return null;
    return {
      mfaSessionToken: parsed.mfaSessionToken,
      emailMasked: typeof parsed.emailMasked === "string" ? parsed.emailMasked : "",
      ...(methods ? { methods } : {}),
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

/** Required two-factor at sign-in: the token that lets this browser set up an authenticator. */
export function loadPendingTwoFactorSetup(): string | null {
  try {
    return window.sessionStorage.getItem(SETUP_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function savePendingTwoFactorSetup(setupToken: string) {
  window.sessionStorage.setItem(SETUP_STORAGE_KEY, setupToken);
}

export function clearPendingTwoFactorSetup() {
  window.sessionStorage.removeItem(SETUP_STORAGE_KEY);
}
