import { useQuery } from "@tanstack/react-query";

import type {
  AuthOptionsResponse,
  CreateFirstAdminRequest,
  CreateFirstAdminResponse,
  LegalTextResponse,
  ProviderId,
  ProviderKeyListResponse,
  VerifySetupCodeRequest,
  VerifySetupCodeResponse,
} from "@tracyhill-rp/contracts";

import { apiFetch } from "../../shared/api/client";

// First-run setup: the server's one-time code, then the first administrator. And the public
// sign-in options every sign-in page reads: whether setup is needed, sign-up, forgot-password, the terms box.

export const AUTH_OPTIONS_QUERY_KEY = ["auth-options"] as const;

export function getAuthOptions() {
  return apiFetch<AuthOptionsResponse>("/api/auth/options", { method: "GET" });
}

export function getLegalText() {
  return apiFetch<LegalTextResponse>("/api/auth/legal", { method: "GET" });
}

export function verifySetupCode(payload: VerifySetupCodeRequest) {
  return apiFetch<VerifySetupCodeResponse>("/api/setup/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createFirstAdmin(payload: CreateFirstAdminRequest) {
  return apiFetch<CreateFirstAdminResponse>("/api/setup/admin", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Read while nobody is signed in: whether the deployment needs setting up, and what the sign-in pages offer. */
export function useAuthOptions(enabled: boolean) {
  return useQuery({
    queryKey: AUTH_OPTIONS_QUERY_KEY,
    queryFn: getAuthOptions,
    enabled,
    retry: false,
  });
}

/** True when the page travels over plain HTTP to anything but this computer. */
export function isUnencryptedRemote(location: Pick<Location, "protocol" | "hostname">) {
  if (location.protocol !== "http:") return false;
  return !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
}

/** The names of everything this account can already write with: API keys (its own or the server's), subscriptions, custom endpoints. */
export function describeConnectedProviders(
  data: Pick<ProviderKeyListResponse, "providers" | "customEndpoints"> | undefined,
  providers: ReadonlyArray<{ id: ProviderId; label: string }>,
): string[] {
  if (!data) return [];
  const names: string[] = [];
  for (const { id, label } of providers) {
    const status = data.providers[id];
    if (status?.configured) names.push(status.source === "server" ? `${label} (server key)` : label);
  }
  if (data.providers["claude-code"]?.configured) names.push("Claude subscription");
  if (data.providers["codex-bridge"]?.configured) names.push("ChatGPT subscription");
  for (const endpoint of data.customEndpoints) {
    if (endpoint.hasKey || endpoint.authHeader === "none") names.push(endpoint.name);
  }
  return names;
}
