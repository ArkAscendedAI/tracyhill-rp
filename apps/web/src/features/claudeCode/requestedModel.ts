/**
 * The requested-vs-served badge's record: the model the panel's last send asked for, keyed by the session it was sent
 * in (the session id, or a New send's `pending-…` query key). `AssistantTurn` says "served by X (requested Y)" when the
 * turn's served model differs from it.
 */
export type RequestedModelRecord = { sessionKey: string | null; model: string };

/** The requested model for the session the panel shows, or null when the record belongs to another session. */
export function requestedModelFor(record: RequestedModelRecord | null, currentKey: string | null, serving: boolean): string | null {
  // Serving-mode backends (Kimi) fix the wire model server-side ("kimi-k3"
  // vs the subscription gateway's "k3"), so the requested-vs-served badge
  // would misfire on every turn; the serving dropdown IS the identity.
  if (serving) return null;
  if (!record) return null;
  if (record.sessionKey && currentKey && record.sessionKey !== currentKey) return null;
  return record.model;
}

/**
 * The record once a New send's session id is adopted (`pendingQueryKey` → `resolvedSessionId`): a record keyed by that
 * send's query key moves to the session id, so the new session's first turn is badged like later ones.
 * The stream names the session before any text arrives, so the key had stopped matching before the first turn.
 */
export function adoptRequestedModel(record: RequestedModelRecord | null, pendingQueryKey: string, resolvedSessionId: string): RequestedModelRecord | null {
  return record && record.sessionKey === pendingQueryKey ? { ...record, sessionKey: resolvedSessionId } : record;
}
