import { useQuery } from "@tanstack/react-query";

import { searchWorkspace } from "./workspaceApi";

export function useWorkspaceSearch(query: string) {
  return useQuery({
    queryKey: ["workspace-search", query],
    queryFn: () => searchWorkspace(query),
    enabled: query.trim().length >= 2,
  });
}
