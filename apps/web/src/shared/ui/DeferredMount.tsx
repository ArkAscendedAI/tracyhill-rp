import { Suspense, useEffect, useState, type ReactNode } from "react";

/**
 * Mounts its children the first time `when` becomes true and keeps them
 * mounted afterwards. Used around the
 * lazily-loaded dialogs and panels in AppShell: their chunk is fetched on the
 * first open instead of with the shell, and after that first open they stay
 * mounted exactly as before, so every dialog keeps the state it used to keep
 * across close/reopen (each one still hides itself with `if (!open) return null`).
 * `fallback` renders only while the chunk is in flight.
 */
export function DeferredMount({ when, fallback = null, children }: { when: boolean; fallback?: ReactNode; children: ReactNode }) {
  const [armed, setArmed] = useState(when);
  useEffect(() => {
    if (when && !armed) setArmed(true);
  }, [when, armed]);
  if (!when && !armed) return null;
  return <Suspense fallback={fallback}>{children}</Suspense>;
}
