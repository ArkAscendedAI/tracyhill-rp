import { useCallback, useSyncExternalStore } from "react";

// A stream can finish after its conversation unmounts. Keep the one-shot arm
// and its subscribers outside that component so completion consumes the same
// arm and updates any remounted view without affecting a later arm.
const owners = new Map<string, symbol | null>();
const listeners = new Map<string, Set<() => void>>();
const storageKey = (sessionId: string) => `trp.rollOverride.${sessionId}`;

function getOwner(sessionId: string) {
  if (!owners.has(sessionId)) {
    let armed = false;
    try { armed = localStorage.getItem(storageKey(sessionId)) === "1"; } catch { /* storage unavailable */ }
    owners.set(sessionId, armed ? Symbol() : null);
  }
  return owners.get(sessionId) ?? null;
}

function setArmed(sessionId: string, armed: boolean) {
  owners.set(sessionId, armed ? Symbol() : null);
  try {
    if (armed) localStorage.setItem(storageKey(sessionId), "1");
    else localStorage.removeItem(storageKey(sessionId));
  } catch { /* in-memory state still governs this tab */ }
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

export function useRollOverride(sessionId: string) {
  const subscribe = useCallback((listener: () => void) => {
    let callbacks = listeners.get(sessionId);
    if (!callbacks) listeners.set(sessionId, callbacks = new Set());
    callbacks.add(listener);
    return () => { callbacks.delete(listener); if (!callbacks.size) listeners.delete(sessionId); };
  }, [sessionId]);
  const getSnapshot = useCallback(() => getOwner(sessionId), [sessionId]);
  const owner = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return {
    armed: owner != null,
    getOwner: getSnapshot,
    setArmed: (armed: boolean) => setArmed(sessionId, armed),
    consume: (completedOwner: symbol | null | undefined) => {
      if (completedOwner && getOwner(sessionId) === completedOwner) setArmed(sessionId, false);
    },
  };
}
