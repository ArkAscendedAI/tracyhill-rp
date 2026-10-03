import { useQuery } from "@tanstack/react-query";

import { getSessionDetail } from "./chatApi";

export function useSessionDetail(sessionId: string | null) {
  return useQuery({
    queryKey: ["session-detail", sessionId],
    queryFn: () => getSessionDetail(sessionId!),
    enabled: Boolean(sessionId),
    // The transcript can be multiple MB; without a staleTime, every window-focus
    // refetched the whole thing constantly. The chat surface fires an explicit
    // invalidation after every send/edit/truncate/scene-resolution, so a 30s
    // staleTime keeps focus-refetches off the hot path without going stale in use.
    staleTime: 30_000,
  });
}
