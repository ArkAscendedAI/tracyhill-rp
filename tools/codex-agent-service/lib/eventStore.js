import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";

import { EVENTS_DIR, EVENTS_MAX_MB, EVENTS_RETENTION_DAYS, safeId } from "./config.js";
import { LatestSnapshots, latestSnapshotKey } from "./latestSnapshots.js";

const REPLAY_SKIP_AFTER_COMPLETION = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/mcpToolCall/progress",
]);

// Cumulative snapshot notifications: every occurrence carries the FULL state
// and supersedes the previous one (per turn or per thread). They are
// stub-persisted at append time. Goal/usage/plan latest values have a separate
// bounded durable store; interim diffs stay live-only. Compaction coalesces
// older full-log snapshots per scope. A single overnight YOLO turn once
// persisted ~2,400 full-diff snapshots — 470MB of a 494MB log — and replaying
// that file took the whole VM into swap.
export const CUMULATIVE_SNAPSHOT_SCOPES = new Map([
  ["turn/diff/updated", "turn"],
  ["turn/plan/updated", "turn"],
  ["thread/goal/updated", "thread"],
  ["thread/goal/cleared", "thread"],
  ["thread/tokenUsage/updated", "thread"],
]);

const TAIL_CHUNK_BYTES = 64 * 1024;
// `<sessionId>.jsonl.<uuid>.tmp` (compaction, retention cursor) and
// `<sessionId>.snapshots.json.<uuid>.tmp` (latest snapshots); the session id
// itself may contain dots (safeId), hence the anchored lazy group.
const TEMP_FILE_PATTERN = /^(.+?)\.(?:jsonl|snapshots\.json)\.[0-9a-f-]{36}\.tmp$/;
// A rewrite of a very large log can take minutes; the periodic sweep only
// removes files older than this (and never a session's with a rewrite in flight).
const PRUNE_TEMP_MIN_AGE_MS = 30 * 60_000;

export class EventStore extends EventEmitter {
  constructor(dir = EVENTS_DIR, { compactMinBytes = 256 * 1024, snapshotMaxBytes, snapshotMaxScopes } = {}) {
    super();
    this.dir = dir;
    this.compactMinBytes = compactMinBytes;
    this.indices = new Map();
    this.appendReady = new Set();
    // Appends that arrive while a compaction rewrite is streaming the same
    // file are diverted here and flushed after the rename, so the rewrite can
    // never lose a concurrent event.
    this.appendBuffers = new Map();
    this.snapshots = new LatestSnapshots({ maxBytes: snapshotMaxBytes, maxScopes: snapshotMaxScopes });
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  path(sessionId) {
    if (!safeId(sessionId)) throw new Error("Invalid session id");
    return join(this.dir, `${sessionId}.jsonl`);
  }

  currentIndex(sessionId) {
    if (this.indices.has(sessionId)) return this.indices.get(sessionId);
    const index = Math.max(lastIndexFromDisk(this.path(sessionId)), this.snapshots.read(this.snapshotPath(sessionId)).lastIndex);
    this.indices.set(sessionId, index);
    return index;
  }

  // persistParams: when set, the disk line carries it instead of params (the
  // stub form) while subscribers still receive the full event. idx continuity
  // on disk stays intact, so client cursors survive restarts.
  append(sessionId, method, params = {}, { persistParams, retainSnapshot = false } = {}) {
    const idx = this.currentIndex(sessionId) + 1;
    if (!this.appendReady.has(sessionId)) {
      // Keep a complete final record even if only its newline was torn. An
      // incomplete record stays an isolated invalid line, never swallowing
      // the first newly appended event after restart.
      ensureTrailingNewline(this.path(sessionId));
      this.appendReady.add(sessionId);
    }
    const ts = new Date().toISOString();
    const event = { idx, method, params, ts };
    if (retainSnapshot) persistParams = { stub: true, threadId: params.threadId ?? sessionId, turnId: params.turnId ?? null };
    const line = `${JSON.stringify(persistParams ? { idx, method, params: persistParams, ts } : event)}\n`;
    const buffer = this.appendBuffers.get(sessionId);
    if (buffer) buffer.push(line);
    // 0600 on creation: the log carries question texts and the
    // panel's own bridge events; a service unit may set no UMask. Existing
    // files keep their mode.
    else appendFileSync(this.path(sessionId), line, { encoding: "utf8", mode: 0o600 });
    this.indices.set(sessionId, idx);
    if (retainSnapshot && this.snapshots.retain(this.snapshotPath(sessionId), sessionId, event)) {
      this.emit("snapshotWarning", `Latest Codex snapshots for ${sessionId} exceeded the storage window; older or oversized fields may be unavailable after restart`);
    }
    this.emit(`event:${sessionId}`, event);
    return event;
  }

  // Streaming line reader — O(one line) memory regardless of log size. Stub
  // lines are replay-invisible.
  //
  // Compaction window: appends that arrive while a
  // compaction rewrite is streaming the same file go to appendBuffers, not
  // disk, and are flushed only after the rename — so a reader during that
  // window (a second tab, the API proxy reconnecting from its cursor, or
  // getSession's liveEvents tail) drained the old file and never saw them.
  // The diverted array is captured synchronously at generator start — the
  // same tick a subscriber attaches its live listener — and its lines are
  // yielded after the file, deduped by idx, so file + diverted + live is a
  // complete sequence. The reference survives the buffer being flushed and
  // dropped from the map mid-read.
  async *streamAfter(sessionId, after = -1) {
    const retained = this.snapshots.read(this.snapshotPath(sessionId));
    const snapshots = retained.entries.sort((a, b) => a.idx - b.idx);
    const latest = new Map(snapshots.map(event => [latestSnapshotKey(event, sessionId), event.idx]));
    let next = 0, last = after;
    for await (const event of this.#streamLogAfter(sessionId, after)) {
      while (next < snapshots.length && snapshots[next].idx <= event.idx) {
        const snapshot = snapshots[next++];
        if (snapshot.idx <= last) continue;
        if (snapshot.params?.stub !== true) yield snapshot;
        last = snapshot.idx;
      }
      // A discarded scope cannot keep its individual tombstone forever within
      // a fixed-size file. This global floor suppresses only older cumulative
      // legacy rows; retained snapshots still replay above, including root
      // snapshots with older indices. Structural events/final diffs are intact.
      if (latestSnapshotKey(event, sessionId) && event.idx <= (retained.discardedThrough ?? -1)) continue;
      if (event.idx <= last || event.idx < (latest.get(latestSnapshotKey(event, sessionId)) ?? -1)) continue;
      yield event;
      last = event.idx;
    }
    while (next < snapshots.length) {
      const snapshot = snapshots[next++];
      if (snapshot.idx > last && snapshot.params?.stub !== true) yield snapshot;
      last = Math.max(last, snapshot.idx);
    }
  }

  async *#streamLogAfter(sessionId, after = -1) {
    const diverted = this.appendBuffers.get(sessionId) ?? null;
    const path = this.path(sessionId);
    let last = after;
    if (existsSync(path)) {
      const stream = createReadStream(path, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const event = parseReplayLine(line, last);
          if (!event) continue;
          last = event.idx;
          yield event;
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }
    if (!diverted) return;
    // Index-bounded: the array may still be growing while we iterate.
    for (let i = 0; i < diverted.length; i += 1) {
      const event = parseReplayLine(diverted[i], last);
      if (!event) continue;
      last = event.idx;
      yield event;
    }
  }

  async readAfter(sessionId, after = -1) {
    const result = [];
    for await (const event of this.streamAfter(sessionId, after)) result.push(event);
    return result;
  }

  // Tail window bounded by serialized size — for getSession liveEvents, where
  // an unbounded active turn once shipped hundreds of MB in one JSON body.
  async readTail(sessionId, after = -1, maxBytes = 4 * 1024 * 1024, through = Infinity) {
    const events = [];
    let bytes = 0;
    let truncated = false;
    for await (const event of this.streamAfter(sessionId, after)) {
      if (event.idx > through) break;
      events.push(event);
      bytes += Buffer.byteLength(JSON.stringify(event));
      while (bytes > maxBytes && events.length > 1) {
        bytes -= Buffer.byteLength(JSON.stringify(events[0]));
        events.shift();
        truncated = true;
      }
    }
    return { events, truncated };
  }

  subscribe(sessionId, listener) {
    const key = `event:${sessionId}`;
    this.on(key, listener);
    return () => this.off(key, listener);
  }

  // Two streaming passes retain structural events, each thread's open turn,
  // and the final cumulative snapshots. A subagent completing must never
  // discard its still-running parent's deltas or overwrite its token usage.
  async compactCompleted(sessionId) {
    const path = this.path(sessionId);
    if (!existsSync(path)) return { kept: 0, dropped: 0 };
    try { if (statSync(path).size < this.compactMinBytes) return { kept: 0, dropped: 0, skipped: true }; } catch {}
    if (this.appendBuffers.has(sessionId)) return { kept: 0, dropped: 0, skipped: true };
    const buffered = [];
    this.appendBuffers.set(sessionId, buffered);
    const ownsRewrite = () => this.appendBuffers.get(sessionId) === buffered;
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      const openTurns = new Map();
      let lastRawIdx = -1;
      const finalSnapshotIdx = new Map();
      for await (const event of this.#streamRaw(path)) {
        lastRawIdx = event.idx;
        trackOpenTurns(openTurns, event, sessionId);
        const scope = CUMULATIVE_SNAPSHOT_SCOPES.get(event.method);
        if (scope && event.params?.stub !== true) {
          finalSnapshotIdx.set(snapshotKey(event, scope, sessionId), event.idx);
        }
      }

      let kept = 0;
      let dropped = 0;
      const source = this.#streamRaw(path);
      async function* rewrite() { for await (const event of source) {
        let keep = true;
        const scope = CUMULATIVE_SNAPSHOT_SCOPES.get(event.method);
        if (event.params?.stub === true) keep = false;
        else if (REPLAY_SKIP_AFTER_COMPLETION.has(event.method)) {
          const open = openTurns.get(eventThreadId(event, sessionId));
          const turnId = event.params?.turnId ?? event.params?.turn?.id;
          keep = Boolean(open && event.idx >= open.idx && (!turnId || turnId === open.turnId));
        }
        else if (scope) {
          keep = finalSnapshotIdx.get(snapshotKey(event, scope, sessionId)) === event.idx;
        }
        // The final line is the on-disk idx watermark — dropping it would let
        // a restart re-issue idx values clients have already consumed.
        if (event.idx === lastRawIdx) keep = true;
        if (!keep) { dropped += 1; continue; }
        kept += 1;
        yield `${JSON.stringify(event)}\n`;
      } }
      // pipeline installs error handlers before opening the file and closes
      // both streams on failure, including an asynchronous output-open error.
      await pipeline(Readable.from(rewrite()), createWriteStream(tmp, { encoding: "utf8", mode: 0o600 }));
      if (!ownsRewrite()) { rmSync(tmp, { force: true }); return { kept: 0, dropped: 0, cancelled: true }; }
      renameSync(tmp, path);
      return { kept, dropped };
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch {}
      return { kept: 0, dropped: 0, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (ownsRewrite()) {
        this.appendBuffers.delete(sessionId);
        if (buffered.length) appendFileSync(path, buffered.join(""), { encoding: "utf8", mode: 0o600 });
      }
    }
  }

  // Raw pass including stubs — compaction needs every line.
  async *#streamRaw(path) {
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (Number.isInteger(event.idx)) yield event;
        } catch {}
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  // Boot recovery only needs turn boundaries — string-prefilter each line so
  // a legacy multi-hundred-MB log costs a scan, not a parse.
  async recoverInterrupted(sessionIds) {
    const recovered = [];
    for (const sessionId of sessionIds) {
      const path = this.path(sessionId);
      if (!existsSync(path)) continue;
      const openTurns = new Map();
      const stream = createReadStream(path, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.includes('"method":"turn/started"') && !line.includes('"method":"turn/completed"')) continue;
          try { trackOpenTurns(openTurns, JSON.parse(line), sessionId); } catch {}
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      if (!openTurns.size) continue;
      for (const [threadId, { turnId }] of openTurns) {
        this.append(sessionId, "bridge/restarted", { threadId, turnId, message: "Codex bridge restarted — the in-flight turn was interrupted." });
        this.append(sessionId, "turn/completed", { threadId, turn: { id: turnId, status: "interrupted", items: [], itemsView: "notLoaded", error: null } });
      }
      recovered.push(sessionId);
    }
    return recovered;
  }

  sizeOf(sessionId) {
    try { return statSync(this.path(sessionId)).size; } catch { return 0; }
  }

  remove(sessionId) {
    // Invalidate an in-flight rewrite before unlinking. Its buffered appends
    // belong to the deleted session and must not recreate the removed file.
    this.appendBuffers.delete(sessionId);
    try { rmSync(this.path(sessionId), { force: true }); } catch {}
    try { rmSync(this.snapshotPath(sessionId), { force: true }); } catch {}
    this.indices.delete(sessionId);
    this.appendReady.delete(sessionId);
  }

  // Orphaned rewrite files. Compaction, the
  // retention cursor and the latest-snapshot store write `<file>.<uuid>.tmp`
  // beside their target and rename; a kill mid-rewrite (OOM/MemoryMax, power
  // loss — both have happened on this VM) leaves a partial copy, potentially
  // hundreds of MB, that neither retention nor /v2/status ever saw. Boot
  // sweeps everything (nothing is in flight before start()); prune sweeps
  // files older than minAgeMs whose session has no rewrite in progress.
  sweepTemp({ minAgeMs = 0, now = Date.now() } = {}) {
    let removed = 0;
    let names;
    try { names = readdirSync(this.dir); } catch { return 0; }
    for (const name of names) {
      const match = TEMP_FILE_PATTERN.exec(name);
      if (!match || this.appendBuffers.has(match[1])) continue;
      const path = join(this.dir, name);
      try {
        if (now - statSync(path).mtimeMs < minAgeMs) continue;
        rmSync(path, { force: true });
        removed += 1;
      } catch {}
    }
    return removed;
  }

  prune(active = () => false) {
    this.sweepTemp({ minAgeMs: PRUNE_TEMP_MIN_AGE_MS });
    const files = [];
    const cutoff = Date.now() - EVENTS_RETENTION_DAYS * 24 * 3600_000;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -6);
      const path = join(this.dir, name);
      try {
        const stat = statSync(path);
        if (!active(sessionId) && !this.appendBuffers.has(sessionId) && stat.mtimeMs < cutoff) { this.#retainCursor(sessionId); continue; }
        files.push({ sessionId, path, mtimeMs: stat.mtimeMs, size: stat.size + this.snapshotSizeOf(sessionId) });
      } catch {}
    }
    const maxBytes = EVENTS_MAX_MB * 1024 * 1024;
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) break;
      if (active(file.sessionId) || this.appendBuffers.has(file.sessionId)) continue;
      try { this.#retainCursor(file.sessionId); total -= file.size - this.sizeOf(file.sessionId) - this.snapshotSizeOf(file.sessionId); } catch {}
    }
  }

  #retainCursor(sessionId) {
    const path = this.path(sessionId);
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ idx: this.currentIndex(sessionId), method: "bridge/cursor", params: { stub: true }, ts: new Date().toISOString() })}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      rmSync(this.snapshotPath(sessionId), { force: true });
    } finally { rmSync(tmp, { force: true }); }
  }

  snapshotPath(sessionId) { return this.path(sessionId).replace(/\.jsonl$/, ".snapshots.json"); }
  snapshotSizeOf(sessionId) { try { return statSync(this.snapshotPath(sessionId)).size; } catch { return 0; } }

  // Reconstruct only the small root snapshots. The native goal getter fills
  // old stub-only logs; current logs retain these fields through reconnects.
  async readRuntimeSnapshots(sessionId) {
    const snapshots = {};
    for await (const event of this.streamAfter(sessionId)) {
      if (eventThreadId(event, sessionId) !== sessionId) continue;
      const params = event.params || {};
      if (event.method === "thread/goal/updated") snapshots.goal = params;
      else if (event.method === "thread/goal/cleared") snapshots.goal = null;
      else if (event.method === "thread/tokenUsage/updated") snapshots.tokenUsage = params.tokenUsage;
      else if (event.method === "thread/settings/updated") snapshots.settings = params.threadSettings;
      else if (event.method === "turn/started") snapshots.plan = null;
      else if (event.method === "turn/plan/updated") snapshots.plan = { threadId: sessionId, turnId: params.turnId ?? null, explanation: params.explanation, steps: params.plan || [] };
    }
    return snapshots;
  }
}

function eventThreadId(event, sessionId) { return event.params?.threadId || event.params?.thread?.id || sessionId; }
function trackOpenTurns(openTurns, event, sessionId) {
  const threadId = eventThreadId(event, sessionId);
  const turnId = event.params?.turn?.id ?? event.params?.turnId;
  if (event.method === "turn/started" && turnId) openTurns.set(threadId, { turnId, idx: event.idx });
  else if (event.method === "turn/completed" && (!turnId || openTurns.get(threadId)?.turnId === turnId)) openTurns.delete(threadId);
}
function snapshotKey(event, scope, sessionId) {
  const method = event.method === "thread/goal/cleared" ? "thread/goal/updated" : event.method;
  return JSON.stringify([method, eventThreadId(event, sessionId), scope === "turn" ? event.params?.turnId ?? event.params?.turn?.id ?? "" : ""]);
}

// One replay line → event, or null when it is blank, unparseable, a stub, or
// at/behind the cursor.
function parseReplayLine(line, after) {
  if (!line || !line.trim()) return null;
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (!Number.isInteger(event.idx) || event.idx <= after) return null;
  if (event.params?.stub === true) return null;
  return event;
}

function ensureTrailingNewline(path) {
  let fd;
  try { fd = openSync(path, "r"); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let missingNewline = false;
  try {
    const size = fstatSync(fd).size;
    if (size) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      missingNewline = last[0] !== 10;
    }
  } finally { closeSync(fd); }
  if (missingNewline) appendFileSync(path, "\n");
}

// Backward scan for the last parseable idx — the boot path may face a log
// whose final line is a partial write from a crash, and single lines can be
// hundreds of KB, so the window grows until a complete line fits.
function lastIndexFromDisk(path) {
  if (!existsSync(path)) return -1;
  let fd;
  try { fd = openSync(path, "r"); } catch { return -1; }
  try {
    const size = fstatSync(fd).size;
    if (!size) return -1;
    let window = TAIL_CHUNK_BYTES;
    while (true) {
      const start = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      const lines = text.split("\n").filter((line) => line.trim());
      // The first line of a mid-file window is usually a fragment — only
      // trust it when the window reaches the start of the file.
      const trustFrom = start === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= trustFrom; i -= 1) {
        try {
          const idx = JSON.parse(lines[i]).idx;
          if (Number.isInteger(idx)) return idx;
        } catch {}
      }
      if (start === 0) return -1;
      window *= 4;
    }
  } catch {
    return -1;
  } finally {
    try { closeSync(fd); } catch {}
  }
}
