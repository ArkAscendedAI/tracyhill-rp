import { useEffect, useState } from "react";

// Trailing-edge debounce for a query-key input. The lorebook search used to
// put every keystroke straight into the react-query key, refetching the
// FULL paged lorebook (up to 3 requests on a 2,600-entry campaign) per
// character typed.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
