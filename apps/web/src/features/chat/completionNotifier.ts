// Completion notification: when an assistant turn finishes while
// the tab is hidden, flash the title bar and — opt-in via the session Controls
// popover — fire a browser Notification. The toggle is the ONLY place that
// requests Notification permission; completion itself never prompts.
const FLASH_TITLE = "● Response ready — TracyHill RP";
const STORAGE_KEY = "trp.notifyOnComplete";

let savedTitle: string | null = null;
// The document the reset listener is installed on. A browser has exactly one,
// so this is a once-only install in production; keying on the document object
// (rather than a boolean) is what lets a test swap `document` between cases —
// the boolean version bound the listener to whichever fake document reached
// notifyTurnComplete first and left every later document without a reset
// (an order-dependent test suite).
let resetInstalledOn: Document | null = null;

function installVisibilityReset() {
  if (typeof document === "undefined" || resetInstalledOn === document) return;
  resetInstalledOn = document;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && savedTitle != null) {
      document.title = savedTitle;
      savedTitle = null;
    }
  });
}

function notificationsGranted(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/**
 * The EFFECTIVE toggle: stored on AND the browser can actually fire a
 * Notification. The toggle governs only the Notification (the title flash is
 * unconditional), so a stored "on" without permission — what the old
 * `setNotifyOnCompleteEnabled` persisted after a dismissed prompt, and what
 * older browsers may still hold — is reported as off (the pill showed On
 * while nothing could fire).
 */
export function isNotifyOnCompleteEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "1" && notificationsGranted(); } catch { return false; }
}

/**
 * Persist the "notify me" toggle. Enabling requests Notification permission
 * when it hasn't been decided yet. Persists and returns the EFFECTIVE value —
 * true only when browser notifications will actually fire (enabled AND
 * permission granted); the title flash works regardless. The caller reflects
 * the returned boolean in the UI and explains a false with
 * `describeNotifyUnavailable()`.
 */
export async function setNotifyOnCompleteEnabled(enabled: boolean): Promise<boolean> {
  if (enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* dismissed */ }
  }
  const effective = enabled && notificationsGranted();
  try { localStorage.setItem(STORAGE_KEY, effective ? "1" : "0"); } catch { /* storage unavailable */ }
  return effective;
}

/** Why enabling did not take — for the toast after `setNotifyOnCompleteEnabled(true)` returned false. */
export function describeNotifyUnavailable(): string {
  if (typeof Notification === "undefined") return "This browser does not support notifications — only the tab title will flash when a response finishes.";
  if (Notification.permission === "denied") return "Browser notifications are blocked for this site — only the tab title will flash. Allow them in the site settings, then click Notify again.";
  return "Notification permission was not granted (the prompt was dismissed) — only the tab title will flash. Click Notify again to retry.";
}

/** Call when an assistant turn completes. No-op while the tab is visible. */
export function notifyTurnComplete(sessionName?: string | null) {
  if (typeof document === "undefined" || !document.hidden) return;
  if (savedTitle == null) savedTitle = document.title;
  document.title = FLASH_TITLE;
  installVisibilityReset();
  if (isNotifyOnCompleteEnabled() && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification("Response ready — TracyHill RP", {
        body: sessionName ? `New response in "${sessionName}"` : "Your response has finished generating.",
        tag: "trp-response-ready",
      });
    } catch { /* Notification ctor can throw (e.g. Android Chrome) — flash is enough */ }
  }
}
