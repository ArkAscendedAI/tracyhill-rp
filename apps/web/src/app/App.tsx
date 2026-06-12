import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { AppShell } from "./AppShell";
import { ForgotPasswordPage } from "../features/auth/ForgotPasswordPage";
import { LegalPage } from "../features/auth/LegalPage";
import { LoginPage } from "../features/auth/LoginPage";
import { MfaChallengePage } from "../features/auth/MfaChallengePage";
import { RegistrationPage } from "../features/auth/RegistrationPage";
import { RegistrationVerificationPage } from "../features/auth/RegistrationVerificationPage";
import { logout } from "../features/auth/authApi";
import { useCurrentUser } from "../features/auth/useCurrentUser";
import { onAuthInvalidated } from "../shared/api/client";

export function App() {
  const path = window.location.pathname;
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });

  // If the server invalidates the session mid-app (logout from another tab,
  // session expiry, admin force-delete), the next 401 from apiFetch fires
  // onAuthInvalidated. Drop cached state so the next render bounces back to
  // the login page instead of leaving the user stuck behind error toasts.
  useEffect(() => onAuthInvalidated(() => {
    void queryClient.invalidateQueries({ queryKey: ["current-user"] });
  }), [queryClient]);

  if (path === "/terms") return <LegalPage kind="terms" />;
  if (path === "/privacy") return <LegalPage kind="privacy" />;

  if (currentUser.isLoading) return <main className="shell"><section className="card">Loading...</section></main>;

  if (!currentUser.data?.authenticated || !currentUser.data.user) {
    if (path === "/mfa") return <MfaChallengePage />;
    if (path === "/forgot-password") return <ForgotPasswordPage />;
    if (path === "/register/verify") return <RegistrationVerificationPage />;
    if (path === "/register") return <RegistrationPage />;
    return <LoginPage />;
  }

  return (
    <AppShell
      user={currentUser.data.user}
      onLogout={() => logoutMutation.mutate()}
      loggingOut={logoutMutation.isPending}
    />
  );
}
