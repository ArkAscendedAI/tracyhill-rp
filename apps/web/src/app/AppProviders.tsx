import type { PropsWithChildren } from "react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "../shared/api/client";
import { IconSprite } from "../shared/ui/iconSprite";
import { emitGlobalToast, ToastProvider } from "../shared/ui/Toast";

// Global mutation-error layer: every mutation that doesn't define its own
// onError surfaces its failure through the toast layer instead of failing silently.
// AppShell's ~13 workspace mutations had no onError and never rendered their .error,
// so a failed rename/move/delete/preference-write just vanished. A mutation can still
// opt out by handling onError itself (this runs IN ADDITION to mutation-level onError,
// so we only suppress auth-invalidation 401s, which the login-redirect path handles).
const mutationCache = new MutationCache({
  onError: (error) => {
    if (error instanceof ApiError && error.authInvalidated) return;
    const message = error instanceof Error ? error.message : "Request failed";
    emitGlobalToast(message, "error");
  },
});

const queryClient = new QueryClient({ mutationCache });

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <IconSprite />
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
