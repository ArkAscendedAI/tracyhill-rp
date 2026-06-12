import { useQuery } from "@tanstack/react-query";

import { getSessionDetail } from "./chatApi";

export function useSessionDetail(sessionId: string | null) {
  return useQuery({
    queryKey: ["session-detail", sessionId],
    queryFn: () => getSessionDetail(sessionId!),
    enabled: Boolean(sessionId),
  });
}
