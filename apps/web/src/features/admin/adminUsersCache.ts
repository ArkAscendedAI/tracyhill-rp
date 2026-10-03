import type { QueryClient } from "@tanstack/react-query";

import type { AdminUsersResponse } from "@tracyhill-rp/contracts";

// The admin Users dialog's cached list (AdminUsersDialog.tsx). Pure cache
// writes, unit-tested without React.

export const ADMIN_USERS_QUERY_KEY = ["admin-users"] as const;

/**
 * A successful DELETE takes the row out of the cached list at once, before the
 * list refetches. A failed refetch keeps the last good list, so without this the
 * deleted user stayed listed with a live Delete beside the refetch error, and a
 * second Delete answered "User not found".
 */
export function removeDeletedUser(queryClient: QueryClient, userId: string): void {
  queryClient.setQueryData<AdminUsersResponse>(ADMIN_USERS_QUERY_KEY, (current) =>
    current ? { ...current, users: current.users.filter((user) => user.id !== userId) } : current,
  );
}
