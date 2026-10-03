import type {
  SendTestEmailRequest,
  SendTestEmailResponse,
  ServerSettings,
  SubscriptionLoginStartResponse,
  SubscriptionStatus,
  SubscriptionsResponse,
  UpdateServerSettingsRequest,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";
import type { SubscriptionCalls } from "../auth/SubscriptionCards";

// Admin: Server settings.

export const SERVER_SETTINGS_QUERY_KEY = ["server-settings"] as const;

export function getServerSettings() {
  return apiFetch<ServerSettings>("/api/admin/settings", { method: "GET" });
}

export function updateServerSettings(payload: UpdateServerSettingsRequest) {
  return apiFetch<ServerSettings>("/api/admin/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function sendTestEmail(payload: SendTestEmailRequest) {
  return apiFetch<SendTestEmailResponse>("/api/admin/settings/email/test", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// The server-wide Claude and ChatGPT sign-ins (Shared keys page): the account sign-in flow, at the admin address.
const SHARED_SUBSCRIPTIONS = "/api/admin/settings/subscriptions";
export const SERVER_SUBSCRIPTION_CALLS: SubscriptionCalls = {
  queryKey: ["server-subscriptions"],
  list: () => apiFetch<SubscriptionsResponse>(`${SHARED_SUBSCRIPTIONS}?verify=1`, { method: "GET" }),
  start: (provider) => apiFetch<SubscriptionLoginStartResponse>(`${SHARED_SUBSCRIPTIONS}/${provider}/login/start`, { method: "POST" }),
  complete: (provider, payload) => apiFetch<SubscriptionStatus>(`${SHARED_SUBSCRIPTIONS}/${provider}/login/complete`, { method: "POST", body: JSON.stringify(payload) }),
  cancel: (provider, payload) => apiFetch<SubscriptionStatus>(`${SHARED_SUBSCRIPTIONS}/${provider}/login/cancel`, { method: "POST", body: JSON.stringify(payload) }),
  logout: (provider) => apiFetch<SubscriptionStatus>(`${SHARED_SUBSCRIPTIONS}/${provider}/logout`, { method: "POST" }),
  status: (provider) => apiFetch<SubscriptionStatus>(`${SHARED_SUBSCRIPTIONS}/${provider}/status?verify=1`, { method: "GET" }),
};

/** "3 AM" for 3 in an en-US browser; the browser's own clock style elsewhere. */
export function formatHour(hour: number) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" });
}

/** The browser's IANA zone, or null where the runtime does not say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Every zone the browser knows, for the picker; empty where the runtime cannot list them. */
export function knownTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

/** The fields of `draft` that differ from `saved`, for a PATCH that sends only what changed. */
export function changedFields<T extends Record<string, unknown>>(saved: T, draft: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(draft) as Array<keyof T>) {
    if (draft[key] !== saved[key]) out[key] = draft[key];
  }
  return out;
}
