import type {
  SubscriptionLoginCancelRequest,
  SubscriptionLoginCompleteRequest,
  SubscriptionLoginStartResponse,
  SubscriptionProvider,
  SubscriptionStatus,
  SubscriptionsResponse,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

// Per-user subscription connections (2026-09-25). The API relays each call to the runner, which drives the official
// Claude Code and Codex programs under the user's own home; the browser only ever
// sees connection state and account identity, never a token.
const BASE = "/api/providers/subscriptions";

// The dialog opens with `verify`, so a sign-in the runner already holds (one
// that finished after the app's wait ran out, or a restored credential volume)
// shows as connected instead of stale state; the stored rows answer otherwise.
export function getSubscriptions(options?: { verify?: boolean }) {
  const suffix = options?.verify ? "?verify=1" : "";
  return apiFetch<SubscriptionsResponse>(`${BASE}${suffix}`, { method: "GET" });
}

export function startSubscriptionLogin(provider: SubscriptionProvider) {
  return apiFetch<SubscriptionLoginStartResponse>(`${BASE}/${provider}/login/start`, { method: "POST" });
}

export function completeSubscriptionLogin(provider: SubscriptionProvider, payload: SubscriptionLoginCompleteRequest) {
  return apiFetch<SubscriptionStatus>(`${BASE}/${provider}/login/complete`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function cancelSubscriptionLogin(provider: SubscriptionProvider, payload: SubscriptionLoginCancelRequest) {
  return apiFetch<SubscriptionStatus>(`${BASE}/${provider}/login/cancel`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function logoutSubscription(provider: SubscriptionProvider) {
  return apiFetch<SubscriptionStatus>(`${BASE}/${provider}/logout`, { method: "POST" });
}

// `verify` asks the server to re-check the connection with the runner instead of
// answering from its stored row. The device-code poll uses it so a login that
// completed on the provider's page is seen on the next tick.
export function getSubscriptionStatus(provider: SubscriptionProvider, options?: { verify?: boolean }) {
  const suffix = options?.verify ? "?verify=1" : "";
  return apiFetch<SubscriptionStatus>(`${BASE}/${provider}/status${suffix}`, { method: "GET" });
}
