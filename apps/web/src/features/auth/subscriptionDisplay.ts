import { subscriptionLoginCompleteRequestSchema } from "@tracyhill-rp/contracts";
import type { SubscriptionStatus } from "@tracyhill-rp/contracts";

import { stringMaxLength } from "../lorebook/contractBounds";

// Wording helpers for the Subscriptions area of the Providers dialog. Pure, so
// the labels are unit-tested without React.

const PLAN_LABELS: Record<string, string> = {
  max: "Max",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  free: "Free",
};

/** "max" becomes "Max"; a plan id the table does not know is shown as the provider reported it. */
export function formatSubscriptionPlan(plan: string | null | undefined): string | null {
  const trimmed = plan?.trim() ?? "";
  if (!trimmed) return null;
  return PLAN_LABELS[trimmed.toLowerCase()] ?? trimmed;
}

/** "Connected as ‹email› · ‹plan›", dropping whichever part the provider did not report. */
export function describeConnectedSubscription(status: Pick<SubscriptionStatus, "accountEmail" | "plan">): string {
  const email = status.accountEmail?.trim() || null;
  const plan = formatSubscriptionPlan(status.plan);
  if (email && plan) return `Connected as ${email} · ${plan}`;
  if (email) return `Connected as ${email}`;
  if (plan) return `Connected · ${plan}`;
  return "Connected";
}

/** The short state word beside a card's title. */
export function describeSubscriptionState(status: Pick<SubscriptionStatus, "status" | "available">): string {
  if (!status.available) return "Unavailable";
  if (status.status === "connected") return "Connected";
  if (status.status === "expired") return "Sign-in expired";
  return "Not connected";
}

// The completion contract's limit for a pasted code: a longer paste came back as a bare
// "invalid sign-in completion request".
const SIGN_IN_CODE_MAX = stringMaxLength(subscriptionLoginCompleteRequestSchema.shape.code) ?? Infinity;

/** Why the pasted text cannot be sent as a sign-in code, or null. Measured as it is sent (trimmed). */
export function pastedCodeProblem(code: string): string | null {
  const length = code.trim().length;
  if (length <= SIGN_IN_CODE_MAX) return null;
  return `The pasted text is ${length.toLocaleString("en-US")} characters; a sign-in code is at most ${SIGN_IN_CODE_MAX.toLocaleString("en-US")}. Paste only the code the sign-in page shows.`;
}
