import type { SubscriptionStatus } from "@tracyhill-rp/contracts";

// The device-code sign-in poll of a Subscriptions card (ChatGPT's "poll"
// completion). Kept free of React so the
// stop rule is unit-tested; SubscriptionCards.tsx
// starts it while a sign-in is pending and stops it when the card unmounts.

export const DEVICE_SIGN_IN_POLL_MS = 3000;

/** The card's connection status when the sign-in began. */
export type DeviceSignInBaseline = Pick<SubscriptionStatus, "status">;

/** Whether a status read while the sign-in is pending is that sign-in's outcome. */
export function isDeviceSignInOutcome(baseline: DeviceSignInBaseline, next: Pick<SubscriptionStatus, "status" | "lastError">): boolean {
  // The server clears the row's error when a sign-in starts, so any error a
  // read shows now is this sign-in's failure, even one worded like the last
  // attempt's.
  const failed = Boolean(next.lastError);
  // An expiry ends the sign-in only when it is new: a card that began from an
  // expired row may keep reading that old state while the new sign-in is
  // pending, and it is not this sign-in's result.
  const newlyExpired = next.status === "expired" && baseline.status !== "expired";
  return next.status === "connected" || newlyExpired || failed;
}

export type DeviceSignInPoll = {
  /** The device code's own expiry, from the start response. */
  expiresAt: string;
  baseline: DeviceSignInBaseline;
  readStatus: () => Promise<SubscriptionStatus>;
  /** The sign-in finished: connected, or failed with the server's reason. */
  onOutcome: (next: SubscriptionStatus) => void;
  /** The code's own expiry passed before the sign-in finished. */
  onCodeExpired: () => void;
  /**
   * A status read failed (the message; the poll keeps going), or a read after a
   * failed one succeeded (null: the error line goes).
   */
  onReadError: (message: string | null) => void;
};

/**
 * Asks for the status every three seconds until the sign-in's outcome or the
 * code's expiry. Returns the stop function (the card's unmount or a new sign-in).
 */
export function startDeviceSignInPoll(poll: DeviceSignInPoll): () => void {
  const expiresAt = Date.parse(poll.expiresAt);
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Whether this poll's last read failed and its error is on the card.
  let showingReadError = false;
  const tick = async () => {
    if (cancelled) return;
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
      poll.onCodeExpired();
      return;
    }
    try {
      const next = await poll.readStatus();
      if (cancelled) return;
      // A good read retires a failed read's error, so it never stands under
      // the finished sign-in.
      if (showingReadError) {
        showingReadError = false;
        poll.onReadError(null);
      }
      if (isDeviceSignInOutcome(poll.baseline, next)) {
        poll.onOutcome(next);
        return;
      }
    } catch (error) {
      if (cancelled) return;
      showingReadError = true;
      poll.onReadError(error instanceof Error ? error.message : "Subscription status could not be loaded.");
    }
    timer = setTimeout(() => void tick(), DEVICE_SIGN_IN_POLL_MS);
  };
  timer = setTimeout(() => void tick(), DEVICE_SIGN_IN_POLL_MS);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
