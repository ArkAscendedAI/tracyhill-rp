import type { ClaudeCodeMode } from "@tracyhill-rp/contracts";

// Per-session permission-mode memory. One localStorage key per
// backend holds a bounded map instead of one `ccp-session-mode:<id>` key per
// session that was never removed (every session ever opened left a key
// forever). Legacy keys are migrated on first read and removed; a deleted
// session's entry is forgotten by the rail.
const MAX_ENTRIES = 200;
type Entry = { mode: ClaudeCodeMode; at: number };

const legacyKey = (sessionId: string) => `ccp-session-mode:${sessionId}`;
export const sessionModesStorageKey = (storagePrefix: string) => `${storagePrefix}-session-modes-v1`;

function readMap(storagePrefix: string): Record<string, Entry> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(sessionModesStorageKey(storagePrefix)) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, Entry> : {};
  } catch { return {}; }
}

function writeMap(storagePrefix: string, map: Record<string, Entry>) {
  try { localStorage.setItem(sessionModesStorageKey(storagePrefix), JSON.stringify(map)); } catch { /* storage full or disabled: the mode still applies for this page life */ }
}

export function readSessionMode(storagePrefix: string, sessionId: string): ClaudeCodeMode | null {
  const map = readMap(storagePrefix);
  const entry = map[sessionId];
  if (entry && typeof entry.mode === "string") return entry.mode;
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(legacyKey(sessionId)); } catch { legacy = null; }
  if (!legacy) return null;
  try { localStorage.removeItem(legacyKey(sessionId)); } catch { /* best effort */ }
  writeSessionMode(storagePrefix, sessionId, legacy as ClaudeCodeMode);
  return legacy as ClaudeCodeMode;
}

export function writeSessionMode(storagePrefix: string, sessionId: string, mode: ClaudeCodeMode) {
  const map = readMap(storagePrefix);
  map[sessionId] = { mode, at: Date.now() };
  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    for (const id of ids.sort((a, b) => (map[a]!.at ?? 0) - (map[b]!.at ?? 0)).slice(0, ids.length - MAX_ENTRIES)) delete map[id];
  }
  writeMap(storagePrefix, map);
}

export function forgetSessionMode(storagePrefix: string, sessionId: string) {
  const map = readMap(storagePrefix);
  if (sessionId in map) { delete map[sessionId]; writeMap(storagePrefix, map); }
  try { localStorage.removeItem(legacyKey(sessionId)); } catch { /* best effort */ }
}
