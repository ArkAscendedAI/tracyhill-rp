type AuthInvalidationListener = () => void;
const authInvalidationListeners = new Set<AuthInvalidationListener>();

/**
 * Error thrown by apiFetch carrying the HTTP status, so global handlers (e.g. the
 * mutation-error toast layer) can suppress noise for auth-invalidation 401s, which
 * are already handled by the onAuthInvalidated → redirect-to-login path.
 */
export class ApiError extends Error {
  status: number;
  authInvalidated: boolean;
  constructor(message: string, status: number, authInvalidated: boolean) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.authInvalidated = authInvalidated;
  }
}

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

export function isAuthBootstrapPath(path: string): boolean {
  // 401 from these paths is a normal "wrong credentials" outcome, not a
  // session-died-out-from-under-us event.
  return (
    path.startsWith("/api/auth/login")
    || path.startsWith("/api/auth/mfa")
    || path.startsWith("/api/auth/register")
    || path.startsWith("/api/auth/forgot-password")
    || path === "/api/auth/me"
    // First-run setup: a wrong setup code answers 401 before anyone is signed in.
    || path.startsWith("/api/setup/")
    // Two-factor: a wrong code at sign-in setup, or a wrong password or code on the account page.
    || path.startsWith("/api/auth/two-factor/")
    || path.startsWith("/api/account/two-factor")
    // Authenticated credential re-checks: authService answers a wrong current
    // password (PUT /password, POST /email) or a wrong one-time code
    // (/email/verify, /delete-confirm) with 401 while the session itself is
    // fine. Bouncing to login on a typo was the pre-2026-09-02 behaviour; a
    // genuine session loss on these paths still surfaces via the next poll.
    || path === "/api/account/password"
    || path.startsWith("/api/account/email")
    || path === "/api/account/delete-confirm"
  );
}

/**
 * Default headers merged UNDER any caller-supplied headers. Exported so the
 * merge order is unit-testable: `...init` used to be spread AFTER `headers`, so
 * a caller passing its own `headers` silently replaced the whole object and lost
 * both the JSON content-type (Express then parsed `req.body` as `{}`) and the
 * CSRF fallback header.
 */
export function buildRequestInit(init?: RequestInit): RequestInit {
  return {
    credentials: "include",
    ...init,
    headers: {
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      ...(init?.headers ?? {}),
    },
  };
}

/** Shared authenticated boundary for JSON, downloads and streaming responses. */
export async function apiFetchResponse(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, buildRequestInit(init));
  if (!res.ok) {
    let authInvalidated = false;
    if (res.status === 401 && !isAuthBootstrapPath(path)) {
      // Session invalid mid-app -- let subscribers (App shell) react before
      // we throw, so they can clear cached user state + redirect to login.
      authInvalidated = true;
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
    throw new ApiError(message, res.status, authInvalidated);
  }
  return res;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return (await apiFetchResponse(path, init)).json() as Promise<T>;
}
