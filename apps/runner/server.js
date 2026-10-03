import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ClaudeAccounts } from "./lib/claude/account.js";
import { bufferAnthropic, streamAnthropic } from "./lib/claude/encodeAnthropic.js";
import { buildSdkMessages, buildSystemPrompt, resolveThinking } from "./lib/claude/messageTransform.js";
import { resolveModel } from "./lib/claude/models.js";
import { runQuery } from "./lib/claude/runQuery.js";
import { CodexPool } from "./lib/codex/pool.js";
import { CLAUDE_WRAPPER, CODEX_BIN, DATA_DIR, MAX_BODY_BYTES, PORT, SECRET } from "./lib/config.js";
import { assertUserId, childEnv, ensureProviderDirs, userDirs, listHomes } from "./lib/homes.js";
import { bearerMatches, httpError, readBody, sendJson } from "./lib/http.js";

// The subscription runner: the composer's
// Claude and ChatGPT subscription paths, one credential home per user, both
// served by the unmodified official binaries. Plain HTTP on the private Compose
// network; every route but /healthz needs the shared secret and X-RP-User-Id.

export function createRunnerServer({ secret = SECRET, claude, codex, versions = {}, log = (line) => console.error(line), dataDir = DATA_DIR, wrapperPath = CLAUDE_WRAPPER, maxBodyBytes = MAX_BODY_BYTES, queryImpl = undefined } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL((req.url || "/").replace(/^\/+/, "/"), "http://runner.local");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true, service: "tracyhill-rp-runner", ...versions, codexSessions: codex.entries.size, pendingClaudeLogins: claude.pending.size });
      }
      if (!bearerMatches(req.headers.authorization, secret)) return sendJson(res, 401, { error: "Unauthorized" });
      // Not tied to one user: the API lists the homes to remove those of accounts it deleted while the runner was away.
      if (req.method === "GET" && url.pathname === "/homes") return sendJson(res, 200, { userIds: listHomes(dataDir) });
      const userId = assertUserId(headerValue(req.headers["x-rp-user-id"]));
      if (req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
        return await handleAnthropicMessages(req, res, { userId, log, dataDir, wrapperPath, maxBodyBytes, queryImpl });
      }
      if (req.method === "POST" && url.pathname === "/v2/composer/messages") return await streamComposer(req, res, { userId, codex, maxBodyBytes });
      const match = url.pathname.match(/^\/accounts\/(claude|chatgpt)\/(login\/start|login\/complete|login\/cancel|logout|status)$/);
      if (match) return await handleAccount(req, res, { userId, provider: match[1], action: match[2], claude, codex, maxBodyBytes });
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      if (statusCode >= 500) log(`[runner] ${req.method} ${req.url}: ${error?.stack || error?.message || error}`);
      if (!res.headersSent) sendJson(res, statusCode, { error: error?.message || "runner error" });
      else { try { res.end(); } catch {} }
    }
  });
}

function headerValue(value) { return Array.isArray(value) ? value[0] : value; }

async function handleAccount(req, res, { userId, provider, action, claude, codex, maxBodyBytes }) {
  if (action === "status") {
    if (req.method !== "GET") throw httpError(405, "method not allowed");
    const status = provider === "claude" ? await claude.status(userId) : await codex.status(userId);
    return sendJson(res, 200, { provider, ...status });
  }
  if (req.method !== "POST") throw httpError(405, "method not allowed");
  const body = await readBody(req, maxBodyBytes);
  if (action === "login/start") {
    if (provider === "claude") {
      const started = await claude.startLogin(userId, { method: typeof body.method === "string" ? body.method : "claudeai" });
      return sendJson(res, 200, { provider, ...started, userCode: null, completion: "paste-code" });
    }
    const started = await codex.startLogin(userId);
    return sendJson(res, 200, { provider, ...started, completion: "poll" });
  }
  const loginId = String(body.loginId ?? "").trim();
  if (action === "login/complete") {
    if (!loginId) throw httpError(400, "loginId required");
    if (provider === "claude") {
      const status = await claude.completeLogin(loginId, body.code);
      return sendJson(res, 200, { provider, done: true, success: true, error: null, ...status });
    }
    const result = codex.loginResult(userId, loginId);
    if (!result) throw httpError(404, "no pending sign-in with that id — start again");
    if (!result.done) return sendJson(res, 200, { provider, done: false, success: false, error: null, loggedIn: false });
    const status = result.success ? await codex.status(userId) : { loggedIn: false };
    return sendJson(res, 200, { provider, done: true, success: result.success && status.loggedIn, error: result.error ?? (status.loggedIn ? null : "sign-in did not complete"), ...status });
  }
  if (action === "login/cancel") {
    if (!loginId) throw httpError(400, "loginId required");
    const cancelled = provider === "claude" ? claude.cancelLogin(loginId) : await codex.cancelLogin(userId, loginId);
    return sendJson(res, 200, { provider, cancelled });
  }
  if (action === "logout") {
    if (provider === "claude") await claude.logout(userId); else await codex.logout(userId);
    return sendJson(res, 200, { provider, loggedIn: false });
  }
  throw httpError(404, "not found");
}

async function handleAnthropicMessages(req, res, { userId, log, dataDir, wrapperPath, maxBodyBytes, queryImpl }) {
  const body = await readBody(req, maxBodyBytes);
  const { system: systemTopLevel, messages, model: modelInput, stream, thinking, output_config } = body;
  if (!Array.isArray(messages) || messages.length === 0) throw httpError(400, "messages array required");
  const model = resolveModel(modelInput);
  const systemPromptOverride = buildSystemPrompt({ systemTopLevel, messages });
  const sdkMessages = buildSdkMessages({ messages });
  const thinkingResolved = resolveThinking(thinking);
  const effort = typeof output_config?.effort === "string" ? output_config.effort : null;
  const dirs = ensureProviderDirs(userId, "claude", dataDir);

  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const gen = runQuery({
    messages: sdkMessages, systemPromptOverride, thinking: thinkingResolved, model, effort,
    cwd: dirs.claudeCwd, env: childEnv("claude", dirs), wrapperPath, signal: controller.signal,
    log: (line) => log(`[claude:${userId}] ${line}`),
    ...(queryImpl ? { queryImpl } : {}),
  });
  if (stream === false) {
    const buffered = await bufferAnthropic(gen, { model });
    return sendJson(res, 200, buffered);
  }
  await streamAnthropic(res, gen, { model });
}

async function streamComposer(req, res, { userId, codex, maxBodyBytes }) {
  const payload = await readBody(req, maxBodyBytes);
  const controller = new AbortController();
  let settled = false;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  const write = (event, data) => { if (!settled) try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  const keepalive = setInterval(() => { if (!settled) try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {} }, 10_000);
  keepalive.unref?.();
  res.once("close", () => { if (!settled) controller.abort(); });
  try {
    await codex.stream(userId, payload, {
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

function spawnCollect(command, args, { env, timeoutMs = 20_000 } = {}) {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolveResult({ code, stdout, stderr }); };
    let child;
    try { child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { finish(-1); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

export async function readVersions({ dataDir = DATA_DIR, wrapperPath = CLAUDE_WRAPPER, codexBin = CODEX_BIN } = {}) {
  const probeDirs = userDirs(".version-probe", dataDir);
  const out = { claudeVersion: null, codexVersion: null };
  try {
    mkdirSync(probeDirs.claudeConfigDir, { recursive: true, mode: 0o700 });
    mkdirSync(probeDirs.claudeCwd, { recursive: true, mode: 0o700 });
    const claude = await spawnCollect(wrapperPath, ["--version"], { env: childEnv("claude", probeDirs) });
    out.claudeVersion = claude.code === 0 ? claude.stdout.trim().split("\n")[0] : null;
    mkdirSync(probeDirs.codexConfigDir, { recursive: true, mode: 0o700 });
    const codex = await spawnCollect(codexBin, ["--version"], { env: childEnv("chatgpt", probeDirs) });
    out.codexVersion = codex.code === 0 ? codex.stdout.trim().split("\n")[0] : null;
  } catch {}
  finally { rmSync(probeDirs.base, { recursive: true, force: true }); }
  return out;
}

export async function main() {
  process.on("unhandledRejection", (reason) => console.error(`[runner] unhandled rejection: ${reason?.stack || reason}`));
  process.on("uncaughtException", (error) => { console.error(`[runner] uncaught exception: ${error?.stack || error}`); process.exit(1); });
  if (!SECRET) { console.error("[runner] no RUNNER_SECRET, no SESSION_SECRET and no RUNNER_SECRET_FILE written by the init service — refusing to start"); process.exit(1); }
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const versions = await readVersions();
  const claude = new ClaudeAccounts();
  const codex = new CodexPool();
  const server = createRunnerServer({ claude, codex, versions });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[runner] listening on :${PORT} · data ${DATA_DIR} · claude ${versions.claudeVersion ?? "unavailable"} · codex ${versions.codexVersion ?? "unavailable"}`);
  });
  const shutdown = async () => { server.close(); claude.cancelAll(); await codex.stopAll(); };
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => shutdown().finally(() => process.exit(0)));
  return { server, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : error); process.exit(1); });
}
