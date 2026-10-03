import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { CurrentUser } from "@tracyhill-rp/contracts";

// The shell is its own chunk: the sign-in
// pages load without it, and the auth pages prefetch it on idle so the first
// render after sign-in does not wait on the network.
const loadAppShell = () => import("./AppShell");
const AppShell = lazy(() => loadAppShell().then((m) => ({ default: m.AppShell })));
const SHELL_LOADING = <main className="shell"><section className="card">Loading...</section></main>;
// First-run setup (2026-10-01) is its own chunk too: it is shown once per deployment.
const SetupPage = lazy(() => import("../features/auth/SetupPage").then((m) => ({ default: m.SetupPage })));
import { ForgotPasswordPage } from "../features/auth/ForgotPasswordPage";
import { InviteAcceptPage } from "../features/auth/InviteAcceptPage";
import { LegalPage } from "../features/auth/LegalPage";
import { LoginPage } from "../features/auth/LoginPage";
import { MfaChallengePage } from "../features/auth/MfaChallengePage";
import { RegistrationPage } from "../features/auth/RegistrationPage";
import { RegistrationVerificationPage } from "../features/auth/RegistrationVerificationPage";
import { TwoFactorSetupPage } from "../features/auth/TwoFactorSetupPage";
import { SessionLapsedOverlay } from "../features/auth/SessionLapsedOverlay";
import { completeSignIn, completeSignOut, rememberAuthenticatedUser } from "../features/auth/authCache";
import { logout } from "../features/auth/authApi";
import { useAuthOptions } from "../features/auth/setupApi";
import { useCurrentUser } from "../features/auth/useCurrentUser";
import { onAuthInvalidated } from "../shared/api/client";

export function App() {
  const path = window.location.pathname;
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  // The identity the shell last rendered for, kept so a mid-app session loss
  // can keep AppShell mounted behind a re-login overlay. Cleared by
  // `signOut` — an explicit logout AND a completed self-deletion (an earlier
  // fix narrowed the clearing to logout, so deleting your own
  // account left the deleted identity remembered and the next /me probe raised
  // the "sign-in expired" overlay instead of the login page). A ref mirror
  // lets the 401 listener read it without re-binding.
  const [knownUser, setKnownUser] = useState<CurrentUser | null>(null);
  const knownUserRef = useRef<CurrentUser | null>(null);
  const [sessionLapsed, setSessionLapsed] = useState(false);
  const signOut = () => {
    setKnownUser(null);
    knownUserRef.current = null;
    setSessionLapsed(false);
    // Publishes the unauthenticated probe, purges every user-scoped cache and
    // normalizes a consumed auth route — the same teardown for both paths.
    completeSignOut(queryClient);
  };
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: signOut,
  });

  // If the server invalidates the session mid-app (logout from another tab,
  // session expiry, admin force-delete), the next 401 from apiFetch fires
  // onAuthInvalidated. Refresh the auth probe; if we were rendering a user,
  // flag the lapse so the shell stays mounted under the re-login overlay
  // instead of being torn down (and the composer draft with it).
  useEffect(() => onAuthInvalidated(() => {
    if (knownUserRef.current) setSessionLapsed(true);
    void queryClient.invalidateQueries({ queryKey: ["current-user"] });
  }), [queryClient]);

  const authenticatedUser = currentUser.data?.authenticated && currentUser.data.user ? currentUser.data.user : null;
  // Read only while nobody is signed in: a deployment without any account opens first-run setup instead of sign-in, and
  // the server settings decide what the sign-in pages offer.
  const authOptions = useAuthOptions(Boolean(currentUser.data) && !authenticatedUser && !knownUser);
  useEffect(() => {
    if (authenticatedUser) {
      // A background /me probe can observe another tab's account switch too.
      // Keep the new shell behind the identity gate below until its predecessor's
      // user-agnostic caches have been purged.
      if (knownUserRef.current?.id !== authenticatedUser.id) {
        completeSignIn(queryClient, authenticatedUser);
      }
      setKnownUser(authenticatedUser);
      knownUserRef.current = authenticatedUser;
      setSessionLapsed(false);
      rememberAuthenticatedUser(authenticatedUser.id);
    } else if (currentUser.data && knownUserRef.current) {
      // /me returns a successful unauthenticated response on session expiry;
      // it need not be preceded by a 401 from another request.
      setSessionLapsed(true);
    }
  }, [authenticatedUser, currentUser.data, queryClient]);

  if (path === "/terms") return <LegalPage kind="terms" />;
  if (path === "/privacy") return <LegalPage kind="privacy" />;

  if (currentUser.isLoading) return <main className="shell"><section className="card">Loading...</section></main>;

  // One tree shape for both the live and the lapsed shell: AppShell is always
  // the first child of the same fragment, so flipping to/from the overlay
  // reconciles in place instead of remounting (which would drop the draft).
  if (authenticatedUser && authenticatedUser.id !== knownUser?.id) {
    return <main className="shell"><section className="card">Loading account...</section></main>;
  }
  const shellUser = authenticatedUser ?? knownUser;
  if (!shellUser) {
    if (authOptions.isLoading) return SHELL_LOADING;
    if (authOptions.data?.setupRequired) return <Suspense fallback={SHELL_LOADING}><SetupPage signedIn={false} /></Suspense>;
    prefetchShellOnIdle();
    // A failed options read keeps every link: the server answers each flow for itself.
    const options = authOptions.data;
    if (path === "/mfa") return <MfaChallengePage />;
    if (path === "/two-factor-setup") return <TwoFactorSetupPage />;
    if (path === "/forgot-password") return <ForgotPasswordPage />;
    if (path === "/register/verify") return <RegistrationVerificationPage />;
    if (path.startsWith("/invite/")) return <InviteAcceptPage />;
    if (path === "/register") return <RegistrationPage registrationOpen={options?.registrationOpen ?? true} termsRequired={options?.termsRequired ?? true} />;
    return <LoginPage registrationOpen={options?.registrationOpen ?? true} passwordResetAvailable={options?.passwordResetAvailable ?? true} />;
  }
  // The new administrator's last setup step (connect a provider), and a later visit to /setup.
  if (path === "/setup" && authenticatedUser) return <Suspense fallback={SHELL_LOADING}><SetupPage signedIn /></Suspense>;

  return (
    <Suspense fallback={SHELL_LOADING}>
      <AppShell
        // Keyed by identity: a different account signing in on the same browser
        // gets a fresh shell (all per-user component state) — the same user
        // re-unlocking a lapsed session keeps theirs.
        key={shellUser.id}
        user={shellUser}
        onLogout={() => logoutMutation.mutate()}
        onAccountDeleted={signOut}
        loggingOut={logoutMutation.isPending}
      />
      {authenticatedUser && !sessionLapsed ? null : <SessionLapsedOverlay />}
    </Suspense>
  );
}

let shellPrefetched = false;
function prefetchShellOnIdle() {
  if (shellPrefetched) return;
  shellPrefetched = true;
  const run = () => { void loadAppShell().catch(() => { shellPrefetched = false; }); };
  if (typeof window !== "undefined" && "requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 300);
}
