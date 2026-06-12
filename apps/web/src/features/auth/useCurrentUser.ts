import { useQuery } from "@tanstack/react-query";

import { getCurrentUser } from "./authApi";

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: getCurrentUser,
    retry: false,
  });
}
