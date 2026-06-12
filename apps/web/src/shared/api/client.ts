type AuthInvalidationListener = () => void;
const authInvalidationListeners = new Set<AuthInvalidationListener>();

/**
 * Subscribe to "session became invalid" events. Fires when any API call
 * receives a 401 on an authenticated endpoint (i.e. not /api/auth/login).
 * Used by the React shell to invalidate the current-user query and bounce
 * the user back to the login page rather than leaving them stranded behind
 * a wall of "request failed" toasts.
 */
export function onAuthInvalidated(listener: AuthInvalidationListener): () => void {
  authInvalidationListeners.add(listener);
  return () => { authInvalidationListeners.delete(listener); };
}

function isAuthBootstrapPath(path: string): boolean {
  // 401 from these paths is a normal "wrong credentials" outcome, not a
  // session-died-out-from-under-us event.
  return (
    path.startsWith("/api/auth/login")
    || path.startsWith("/api/auth/mfa")
    || path.startsWith("/api/auth/register")
    || path.startsWith("/api/auth/forgot-password")
    || path === "/api/auth/me"
  );
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    if (res.status === 401 && !isAuthBootstrapPath(path)) {
      // Session invalid mid-app -- let subscribers (App shell) react before
      // we throw, so they can clear cached user state + redirect to login.
      for (const listener of authInvalidationListeners) {
        try { listener(); } catch { /* never let a listener block the throw */ }
      }
    }
    let message = "request failed";
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore JSON parse failures for generic errors
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}
