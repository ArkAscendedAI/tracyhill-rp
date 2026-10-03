import type { QueryClient } from "@tanstack/react-query";

import type { CurrentUser } from "@tracyhill-rp/contracts";

/**
 * React-query cache hygiene across identity changes.
 *
 * Every workspace query key is user-agnostic (["workspace-state"],
 * ["session-detail", id], ["provider-keys"], ...), and the QueryClient is a
 * module singleton with the default 5-minute gcTime — so on a shared family
 * browser, user B signing in after user A logged out was served A's cached
 * sidebar and transcript (status:"success", isLoading:false) until each query
 * refetched. Only ["current-user"] is kept: it is the auth probe itself and is
 * overwritten by the new identity.
 */
const CURRENT_USER_KEY = "current-user";

// The last identity the shell rendered for. Module-level (not query state) so
// it survives the ["current-user"] probe flipping to {authenticated:false} on a
// mid-app 401 and still lets the next sign-in tell "same person re-unlocking"
// (keep caches, refetch) from "different account" (purge).
let lastAuthenticatedUserId: string | null = null;
let userCacheGeneration = 0;

export function rememberAuthenticatedUser(userId: string | null) {
  lastAuthenticatedUserId = userId;
}

/** Test/inspection hook. */
export function getLastAuthenticatedUserId() {
  return lastAuthenticatedUserId;
}

function isNotCurrentUserQuery(queryKey: readonly unknown[]) {
  return queryKey[0] !== CURRENT_USER_KEY;
}

/** Drop everything except the auth probe. */
export function purgeUserScopedQueries(queryClient: QueryClient) {
  userCacheGeneration += 1;
  queryClient.removeQueries({ predicate: (query) => isNotCurrentUserQuery(query.queryKey) });
}

/** Bind imperative mutation cache writes to the rendered identity boundary.
 * Removing/cancelling queries does not cancel an already pending mutation. */
export function createUserScopedCacheWriter(queryClient: QueryClient) {
  const generation = userCacheGeneration;
  return <TData>(queryKey: readonly unknown[], data: TData): boolean => {
    if (generation !== userCacheGeneration) return false;
    queryClient.setQueryData(queryKey, data);
    return true;
  };
}

/**
 * Explicit sign-out: forget the identity, publish the unauthenticated probe and
 * drop user caches synchronously so neither an old probe nor a new login can
 * expose the previous account's data.
 */
export function completeSignOut(queryClient: QueryClient) {
  lastAuthenticatedUserId = null;
  // Publish sign-out directly; a refetch can race a new login in another tab.
  void queryClient.cancelQueries({ queryKey: [CURRENT_USER_KEY] });
  queryClient.setQueryData([CURRENT_USER_KEY], { authenticated: false, user: null });
  purgeUserScopedQueries(queryClient);
  normalizeAuthRoute();
}

function normalizeAuthRoute() {
  if (typeof window === "undefined") return;
  const path = window.location.pathname;
  // An invite link is spent once its account exists; the token leaves the address bar with it.
  if (["/mfa", "/register", "/register/verify", "/forgot-password", "/two-factor-setup"].includes(path) || path.startsWith("/invite/")) {
    window.history.replaceState(null, "", "/");
  }
}

/**
 * Sign-in / MFA / registration success path. The server already told us who we
 * are (`user` on the login/verify responses), so the cache decision is made
 * BEFORE the probe is refreshed — no frame ever renders the previous account's
 * data. Returns what was done so callers/tests can assert it.
 */
export function completeSignIn(queryClient: QueryClient, user: CurrentUser): "purged" | "kept" {
  normalizeAuthRoute();
  const previous = lastAuthenticatedUserId;
  lastAuthenticatedUserId = user.id;
  if (previous != null && previous === user.id) {
    // Same person re-unlocking after a lapsed session: keep the shell's data
    // (and any unsent composer text held in component state) and just refetch
    // whatever is mounted so the errored queries recover.
    queryClient.setQueryData([CURRENT_USER_KEY], { authenticated: true, user });
    void queryClient.invalidateQueries({ predicate: (query) => isNotCurrentUserQuery(query.queryKey) });
    return "kept";
  }
  purgeUserScopedQueries(queryClient);
  queryClient.setQueryData([CURRENT_USER_KEY], { authenticated: true, user });
  return "purged";
}
