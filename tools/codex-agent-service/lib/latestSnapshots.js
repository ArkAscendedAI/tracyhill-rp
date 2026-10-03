import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

export const LATEST_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const LATEST_SNAPSHOT_MAX_SCOPES = 256;
export const DURABLE_SNAPSHOT_METHODS = new Set([
  "thread/goal/updated", "thread/goal/cleared", "thread/tokenUsage/updated", "turn/plan/updated",
]);

// Latest state, not another history log. Repeated large plans/goals replace
// their prior payload. Tombstones invalidate older legacy log entries when a
// payload exceeds the explicit storage bound. Root snapshots outlive child
// snapshots when capacity is needed. The caller validates the session path.
export class LatestSnapshots {
  constructor({ maxBytes = LATEST_SNAPSHOT_MAX_BYTES, maxScopes = LATEST_SNAPSHOT_MAX_SCOPES } = {}) {
    this.maxBytes = maxBytes;
    this.maxScopes = maxScopes;
  }

  read(path) {
    try {
      if (statSync(path).size > this.maxBytes) throw new Error("Codex latest-snapshot file exceeds its storage bound");
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!Number.isInteger(value.lastIndex) || (value.discardedThrough !== undefined && !Number.isInteger(value.discardedThrough)) || !Array.isArray(value.entries) || value.entries.length > this.maxScopes) throw new Error("Invalid Codex latest-snapshot file");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { lastIndex: -1, discardedThrough: -1, entries: [] };
      throw error;
    }
  }

  retain(path, sessionId, event) {
    const previous = this.read(path);
    const key = latestSnapshotKey(event, sessionId);
    const entries = previous.entries.filter(entry => latestSnapshotKey(entry, sessionId) !== key);
    entries.push(event);
    let dropped = false;
    const state = { lastIndex: Math.max(previous.lastIndex, event.idx), discardedThrough: previous.discardedThrough ?? -1, entries };
    const discard = index => {
      const [removed] = entries.splice(index, 1);
      if (removed) state.discardedThrough = Math.max(state.discardedThrough, removed.idx);
    };
    const chooseOldest = candidates => candidates.findIndex(entry => (entry.params?.threadId || sessionId) !== sessionId);
    while (entries.length > this.maxScopes) {
      const child = chooseOldest(entries);
      discard(child < 0 ? 0 : child);
      dropped = true;
    }
    let encoded = JSON.stringify(state);
    while (Buffer.byteLength(encoded) > this.maxBytes) {
      const child = chooseOldest(entries);
      const fullChild = entries.findIndex(entry => (entry.params?.threadId || sessionId) !== sessionId && entry.params?.stub !== true);
      const victimIndex = fullChild >= 0 ? fullChild : child >= 0 ? child : entries.findIndex(entry => entry.params?.stub !== true);
      const victim = entries[victimIndex];
      if (victim && victim.params?.stub !== true) {
        entries[victimIndex] = { ...victim, params: { stub: true, threadId: victim.params?.threadId || sessionId, turnId: victim.params?.turnId ?? null } };
      } else {
        discard(victimIndex < 0 ? 0 : victimIndex);
        if (!entries.length && Buffer.byteLength(JSON.stringify(state)) > this.maxBytes) throw new Error("Codex latest-snapshot storage bound is too small");
      }
      dropped = true;
      encoded = JSON.stringify(state);
    }
    const tmp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(tmp, encoded, { mode: 0o600 }); renameSync(tmp, path); }
    finally { rmSync(tmp, { force: true }); }
    return dropped;
  }
}

export function latestSnapshotKey(event, sessionId) {
  if (!DURABLE_SNAPSHOT_METHODS.has(event.method)) return null;
  const method = event.method === "thread/goal/cleared" ? "thread/goal/updated" : event.method;
  return JSON.stringify([method, event.params?.threadId || sessionId]);
}
