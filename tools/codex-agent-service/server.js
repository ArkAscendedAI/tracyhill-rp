import { createServer } from "node:https";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ALLOWED_IPS,
  CODEX_BIN,
  COMPOSER_DIR,
  MAX_BODY_BYTES,
  PORT,
  SECRET,
  TLS_CERT,
  TLS_KEY,
  UPLOAD_DIR,
  safeId,
} from "./lib/config.js";
import { AppServerClient } from "./lib/appServerClient.js";
import { ComposerService } from "./lib/composerService.js";
import { EventStore } from "./lib/eventStore.js";

import { PanelManifest } from "./lib/manifest.js";
import { PanelService, UPLOAD_CONSUMED_TTL_MS, UPLOAD_DRAFT_TTL_MS, httpError } from "./lib/panelService.js";

export async function main() {
  installProcessGuards();
  const client = new AppServerClient({ command: CODEX_BIN });
  const manifest = new PanelManifest();
  const events = new EventStore();
  const panel = new PanelService({ client, manifest, events });
  await panel.start();
  const composerClient = new AppServerClient({
    command: CODEX_BIN,
    clientInfo: { name: "tracyhill-rp-codex-composer", title: "TracyHill RP CodexBridge Composer", version: "1.0.0" },
    args: [
      "app-server",
      "--strict-config",
      "-c", 'history.persistence="none"',
      "-c", 'web_search="disabled"',
      "-c", "project_doc_max_bytes=0",
      "-c", "memories.use_memories=false",
      "-c", "features.shell_tool=false",
      "-c", "features.unified_exec=false",
      "-c", "features.skill_mcp_dependency_install=false",
      "-c", "features.apps=false",
      "-c", "features.multi_agent=false",
      "-c", "features.hooks=false",
      "-c", "features.goals=false",
      "-c", "features.memories=false",
      "-c", "features.plugins=false",
    ],
  });
  const composer = new ComposerService({ client: composerClient, cwd: COMPOSER_DIR });

  const server = createAgentServer(panel, composer);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Codex Agent Service v2 listening on https://0.0.0.0:${PORT}`);
    console.log(`Codex integration: App Server · allowed IPs: ${ALLOWED_IPS.join(", ")}`);
  });

  // Timer callbacks are boundaries too: a throw inside setInterval
  // has no caller to catch it.
  const retentionTimer = setInterval(() => {
    try { events.prune((sessionId) => panel.isActive(sessionId)); }
    catch (error) {
      console.error(`[events] retention failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      panel.recordWarning(`Event-log retention failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 6 * 3600_000);
  retentionTimer.unref();
  const uploadTimer = setInterval(() => cleanUploads(UPLOAD_DIR, { consumedAt: (path) => panel.uploadConsumedAt(path) }), 10 * 60_000);
  uploadTimer.unref();

  const shutdown = async () => {
    clearInterval(retentionTimer);
    clearInterval(uploadTimer);
    server.close();
    await Promise.allSettled([panel.shutdown(), composer.shutdown()]);
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => shutdown().finally(() => process.exit(0)));
  return { server, panel, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  });
}

// Process-level guards. The handler-level
// boundaries in PanelService catch what the App Server child can throw at us;
// these catch what escapes everything else (a timer, a stream callback, a
// rejected promise nobody awaited) and decide whether continuing is safe.
//
// "Safe" means the error is environmental — an errno-style I/O failure
// (ENOSPC, EACCES, EIO, EMFILE, EPIPE, ECONNRESET …) or one of this service's
// own httpError values — raised by a leaf operation whose callers are
// idempotent per event: the replay-log index advances only after a successful
// append, manifest and snapshot files are written tmp-then-rename, uploads are
// UUID-named. Nothing is half-applied, so logging and continuing loses at most
// that one event. A programming error (TypeError, RangeError, ReferenceError —
// anything without an errno or status) means the process state is unknown:
// exit 1 and let systemd restart the service (its unit's Restart= policy;
// boot recovery closes interrupted turns). More than
// `budget` continues within `windowMs` also exits — a persistently failing
// environment is better served by a restart than by a silent spin.
// Unhandled rejections are logged and never fatal: an un-awaited promise has
// no synchronous state mid-flight, and every fire-and-forget site here
// (turn/interrupt on abort, post-turn compaction, thread/unsubscribe) is
// self-contained.
export function installProcessGuards({ target = process, log = (line) => console.error(line), exit = (code) => process.exit(code), budget = 20, windowMs = 60_000, now = Date.now } = {}) {
  const continued = [];
  target.on("unhandledRejection", (reason) => {
    log(`[guard] unhandled rejection: ${describeError(reason)}`);
  });
  target.on("uncaughtException", (error, origin) => {
    log(`[guard] uncaught exception (${origin ?? "uncaughtException"}): ${describeError(error)}`);
    if (!isEnvironmentalError(error)) {
      log("[guard] not an environmental error — exiting so systemd restarts the service from a known state");
      exit(1);
      return;
    }
    const at = now();
    continued.push(at);
    while (continued.length && at - continued[0] > windowMs) continued.shift();
    if (continued.length > budget) {
      log(`[guard] ${continued.length} uncaught exceptions within ${windowMs} ms — exiting so systemd restarts the service`);
      exit(1);
      return;
    }
    log("[guard] continuing: environmental error from an idempotent leaf operation");
  });
}

// errno codes (ENOSPC, EACCES, EPIPE …), Node stream/socket lifecycle codes and
// this service's httpError values. Node's other ERR_* codes (ERR_INVALID_ARG_TYPE
// and friends) are programming errors and stay fatal.
export function isEnvironmentalError(error) {
  if (!error || typeof error !== "object") return false;
  if (Number.isInteger(error.statusCode)) return true;
  const code = typeof error.code === "string" ? error.code : "";
  return /^E[A-Z0-9]+$/.test(code) || code.startsWith("ERR_STREAM_") || code.startsWith("ERR_SOCKET_");
}

function describeError(error) { return error instanceof Error ? error.stack || error.message : String(error); }

export function createAgentServer(service, composer = null) {
  return createServer({ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) }, async (req, res) => {
    try {
      if (!checkAuth(req, res)) return;
      const url = new URL(req.url, `https://localhost:${PORT}`);
      if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) {
        url.pathname = url.pathname.slice(3) || "/";
        await routeV2(service, composer, req, res, url);
      } else {
        // The unversioned exec-wrapper API (pre-2026-07-12 panel) was removed on
        // 2026-09-02: no caller remains in the RP API (/v2 only),
        // the web app or the Android app.
        sendJson(res, 404, { error: "not found — the Codex agent serves /v2 only" });
      }
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (!res.headersSent) sendJson(res, statusCode, { error: error instanceof Error ? error.message : "Codex bridge error" });
      else try { res.end(); } catch {}
    }
  });
}

async function routeV2(service, composer, req, res, url) {
  const path = url.pathname;
  const parts = path.split("/").filter(Boolean);

  if (req.method === "GET" && path === "/status") return sendJson(res, 200, await service.getStatus());
  if (req.method === "POST" && path === "/composer/messages") {
    if (!composer) throw httpError(503, "CodexBridge Composer is unavailable");
    return streamComposer(composer, req, res);
  }
  if (req.method === "POST" && path === "/upload") return sendJson(res, 200, await handleUpload(req));
  if (req.method === "GET" && path === "/sessions") return sendJson(res, 200, await service.listSessions());
  if (req.method === "POST" && path === "/sessions") return sendJson(res, 200, await service.startTurn(await readBody(req)));
  if (req.method === "GET" && path === "/fs/search") return sendJson(res, 200, await service.searchFiles(url.searchParams.get("workspaceId"), url.searchParams.get("q")));
  if (req.method === "GET" && path === "/skills") return sendJson(res, 200, await service.listSkills(url.searchParams.get("sessionId")));
  if (req.method === "GET" && path === "/mcp") return sendJson(res, 200, await service.listMcp(url.searchParams.get("sessionId")));
  if (req.method === "GET" && path === "/doctor") return sendJson(res, 200, await service.getDoctor(url.searchParams.get("sessionId")));

  if (parts[0] !== "sessions" || !safeId(parts[1])) throw httpError(404, "Not found");
  const sessionId = parts[1];
  const action = parts[2] || "";

  if (req.method === "GET" && !action) return sendJson(res, 200, await service.getSession(sessionId, {
    turnLimit: url.searchParams.get("turnLimit"),
    descendantTurnLimit: url.searchParams.get("descendantTurnLimit"),
  }));
  if (req.method === "PATCH" && !action) return sendJson(res, 200, await service.patchSession(sessionId, await readBody(req)));
  if (req.method === "DELETE" && !action) return sendJson(res, 200, await service.deleteSession(sessionId));
  if (req.method === "GET" && action === "status") return sendJson(res, 200, service.getSessionStatus(sessionId));
  if (req.method === "GET" && action === "stream") {
    const lastEventId = Array.isArray(req.headers["last-event-id"]) ? req.headers["last-event-id"][0] : req.headers["last-event-id"];
    return streamSession(service, req, res, sessionId, parseAfter(url.searchParams.get("after") ?? lastEventId));
  }
  if (req.method === "GET" && action === "export") {
    const exported = await service.exportSession(sessionId);
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exported.filename.replace(/[\r\n"]/g, "")}"`,
    });
    res.end(exported.content);
    return;
  }
  if (req.method === "POST" && action === "steer") return sendJson(res, 200, await service.steer(sessionId, await readBody(req)));
  if (req.method === "POST" && action === "settings") return sendJson(res, 200, await service.updateSettings(sessionId, await readBody(req)));
  if (req.method === "POST" && action === "interrupt") return sendJson(res, 200, await service.interrupt(sessionId));
  if (req.method === "POST" && action === "compact") return sendJson(res, 200, await service.compact(sessionId));
  if (req.method === "POST" && action === "fork") return sendJson(res, 200, await service.fork(sessionId, await readBody(req)));
  if (req.method === "POST" && action === "review") return sendJson(res, 200, await service.review(sessionId, (await readBody(req)).target));
  if (req.method === "POST" && action === "shell") {
    const body = await readBody(req);
    if (!String(body.command || "").trim()) throw httpError(400, "Command required");
    return sendJson(res, 200, await service.runShell(sessionId, String(body.command)));
  }
  if (req.method === "POST" && action === "answer") {
    const body = await readBody(req);
    return sendJson(res, 200, await service.answer(sessionId, body.requestId, body.answers || {}));
  }
  if (req.method === "POST" && action === "archive") return sendJson(res, 200, await service.archive(sessionId));
  if (req.method === "POST" && action === "unarchive") return sendJson(res, 200, await service.unarchive(sessionId));
  throw httpError(404, "Not found");
}

async function streamComposer(composer, req, res) {
  const payload = await readBody(req);
  const controller = new AbortController();
  let settled = false;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (event, data) => { if (!settled) try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  const keepalive = setInterval(() => { if (!settled) try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {} }, 10_000);
  keepalive.unref();
  res.once("close", () => { if (!settled) controller.abort(); });
  try {
    await composer.stream(payload, {
      onStart: () => write("start", { model: payload.model }),
      onDelta: (delta) => write("text_delta", { delta }),
      onThinkingDelta: (delta) => write("thinking_delta", { delta }),
      onComplete: (result) => write("done", result),
    }, controller.signal);
  } catch (error) {
    write("error", { error: error instanceof Error ? error.message : "CodexBridge generation failed" });
  } finally {
    settled = true;
    clearInterval(keepalive);
    try { res.end(); } catch {}
  }
}

// Replay applies backpressure (awaited drain) so a slow client throttles the
// file read; live events never buffer past the high-water mark — the stream
// drops instead and the client reconnects from its cursor.
const SSE_HIGH_WATER_BYTES = 8 * 1024 * 1024;

// Exported for the node:test suite (never started there — the fakes stand in
// for req/res/service).
export async function streamSession(service, req, res, sessionId, after) {
  service.getSessionStatus(sessionId); // 404s before headers are committed
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  let unsubscribe = null;
  // Aborted on disconnect so an in-flight drain wait settles (see the drain race below).
  const gone = new AbortController();
  const keepalive = setInterval(() => { if (!closed) try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {} }, 10_000);
  keepalive.unref();
  const onClose = () => {
    closed = true;
    clearInterval(keepalive);
    gone.abort();
    if (unsubscribe) unsubscribe();
  };
  req.on("close", onClose);
  res.on("close", onClose);
  // Returns false once the client is gone so PanelService.subscribe stops the
  // replay instead of reading the rest of the log into a dead socket.
  const write = async (event) => {
    if (closed) return false;
    if (res.writableLength > SSE_HIGH_WATER_BYTES) {
      try { res.destroy(); } catch {}
      return false;
    }
    let ok = true;
    try { ok = res.write(`id: ${event.idx}\nevent: codex_event\ndata: ${JSON.stringify(event)}\n\n`); } catch { return false; }
    if (!ok) {
      // Race the drain against the disconnect: a client that leaves under
      // backpressure emits `close` but never `drain`, and the un-raced await
      // pinned the replay generator, the live subscription and an unbounded
      // buffer for the life of the process.
      try { await once(res, "drain", { signal: gone.signal }); } catch { return false; }
    }
    return !closed;
  };
  try {
    unsubscribe = await service.subscribe(sessionId, after, write, { onError: () => { onClose(); res.destroy(); } });
    if (closed) unsubscribe();
  } catch (error) {
    // A replay that throws (a rejected .snapshots.json, an fs error mid-file)
    // used to end the client's stream with a clean EOF and no trace anywhere:
    // the web reconnected with backoff forever and nothing reached the journal
    // or /v2/status. Log it, remember it as a
    // status warning, and end with an error frame the web surfaces as a
    // stream error before it reconnects from its cursor (Android ignores
    // frames whose event name is not codex_event).
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stream] replay failed for ${sessionId} (after=${after}): ${error instanceof Error ? error.stack || error.message : message}`);
    if (typeof service.recordWarning === "function") service.recordWarning(`Codex replay failed for ${sessionId}: ${message}`);
    if (!closed) {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: `Codex replay failed: ${message}`, sessionId, source: "codex-sidecar" })}\n\n`); } catch {}
      try { res.end(); } catch {}
      onClose();
    }
  }
}

async function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(httpError(413, "Request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      if (!chunks.length) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(httpError(400, "Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

export async function handleUpload(req, uploadDir = UPLOAD_DIR) {
  const body = await readBody(req);
  if (!body.name || !body.data) throw httpError(400, "name and data required");
  const safeName = `${randomUUID()}-${String(body.name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180)}`;
  const data = Buffer.from(String(body.data), "base64");
  if (!data.length) throw httpError(400, "Empty upload");
  if (data.length > 20 * 1024 * 1024) throw httpError(413, "Upload exceeds 20 MB");
  const path = join(uploadDir, safeName);
  writeFileSync(path, data, { mode: 0o600, flag: "wx" });
  return { path, name: safeName, size: data.length };
}

// Upload retention: a file a turn/steer consumed is removed
// UPLOAD_CONSUMED_TTL_MS after that use; a never-sent one (a draft's) lives
// UPLOAD_DRAFT_TTL_MS from its upload time. After a restart the consumption
// map is empty, so everything falls under the longer draft rule — the safe
// side. Exported for the node:test suite.
export function cleanUploads(uploadDir = UPLOAD_DIR, { now = Date.now(), consumedAt = () => null } = {}) {
  let removed = 0;
  try {
    for (const name of readdirSync(uploadDir)) {
      const path = join(uploadDir, name);
      try {
        if (!existsSync(path)) continue;
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        const consumed = consumedAt(path);
        const expiresAt = typeof consumed === "number" ? consumed + UPLOAD_CONSUMED_TTL_MS : stat.mtimeMs + UPLOAD_DRAFT_TTL_MS;
        if (now >= expiresAt) { unlinkSync(path); removed += 1; }
      } catch {}
    }
  } catch {}
  return removed;
}

function checkAuth(req, res) {
  const remote = req.socket.remoteAddress || "";
  const ip = remote.replace(/^::ffff:/, "");
  if (!ALLOWED_IPS.includes(ip) && !ALLOWED_IPS.includes(remote)) { sendJson(res, 403, { error: "Forbidden" }); return false; }
  if (!SECRET || !bearerMatches(req.headers.authorization, SECRET)) { sendJson(res, 401, { error: "Unauthorized" }); return false; }
  return true;
}

// Constant-time bearer compare — `!==` short-circuits on the first differing
// byte. Length is compared first because
// timingSafeEqual throws on unequal buffers; leaking the secret's length is
// harmless, its bytes are not.
export function bearerMatches(header, secret) {
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(String(header ?? ""), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseAfter(value) {
  const parsed = Number.parseInt(value ?? "-1", 10);
  return Number.isFinite(parsed) ? parsed : -1;
}
