import { emptySubscriptionStatus, SUBSCRIPTION_PROVIDERS, type SubscriptionProvider, type SubscriptionsResponse, type SubscriptionStatus } from "@tracyhill-rp/contracts";

import type { ProviderConnectionRow } from "./providerConnectionRepository";

function isProvider(value: string): value is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}

export function rowToStatus(row: ProviderConnectionRow | undefined, provider: SubscriptionProvider, available: boolean): SubscriptionStatus {
  if (!row) return emptySubscriptionStatus(provider, available);
  const status = row.status === "connected" || row.status === "expired" ? row.status : "disconnected";
  return {
    provider,
    status,
    accountEmail: row.accountEmail ?? null,
    accountOrg: row.accountOrg ?? null,
    plan: row.plan ?? null,
    connectedAt: row.connectedAt ?? null,
    verifiedAt: row.verifiedAt ?? null,
    lastError: row.lastError ?? null,
    available,
  };
}

/** Pure: the per-user block the provider-key list and the subscriptions routes both return. */
export function buildSubscriptionsResponse(rows: ProviderConnectionRow[], available: boolean): SubscriptionsResponse {
  const byProvider = new Map(rows.filter((row) => isProvider(row.provider)).map((row) => [row.provider as SubscriptionProvider, row]));
  return {
    claude: rowToStatus(byProvider.get("claude"), "claude", available),
    chatgpt: rowToStatus(byProvider.get("chatgpt"), "chatgpt", available),
  };
}
