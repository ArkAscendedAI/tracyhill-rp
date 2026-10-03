import { useQuery } from "@tanstack/react-query";

import { getWorkspaceState } from "./workspaceApi";

export function useWorkspaceState() {
  return useQuery({
    queryKey: ["workspace-state"],
    queryFn: getWorkspaceState,
  });
}
