import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { CLAUDE_LOGIN_TTL_MS, CLAUDE_WRAPPER, DATA_DIR } from "../config.js";
import { childEnv, ensureProviderDirs, hasProviderDirs, removeProviderDirs, userDirs } from "../homes.js";
import { httpError } from "../http.js";

// Claude sign-in through the unmodified Claude Code binary's own commands, one
// credential home per user:
//   claude auth login   → prints the authorize link, waits for the pasted code
//   claude auth status  → JSON: loggedIn, email, orgName, subscriptionType
//   claude auth logout  → revokes and clears the login
// The runner never reads the credential file the CLI writes.
const URL_RE = /https?:\/\/[^\s"'<>]+/;
const LOGIN_METHODS = new Set(["claudeai", "console"]);

export class ClaudeAccounts {
  constructor({ wrapperPath = CLAUDE_WRAPPER, dataDir = DATA_DIR, ttlMs = CLAUDE_LOGIN_TTL_MS, log = (line) => console.error(line) } = {}) {
    this.wrapperPath = wrapperPath;
    this.dataDir = dataDir;
    this.ttlMs = ttlMs;
    this.log = log;
    this.pending = new Map();
  }

  run(userId, args, { input = null, timeoutMs = 60_000 } = {}) {
    const dirs = userDirs(userId, this.dataDir);
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(this.wrapperPath, args, { env: childEnv("claude", dirs), cwd: dirs.claudeCwd, stdio: ["pipe", "pipe", "pipe"] });
      const finish = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }); };
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(-1); }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { stderr += `\n${error.message}`; finish(-1); });
      child.on("close", (code) => finish(code ?? -1));
      if (input !== null) child.stdin.write(input);
      child.stdin.end();
    });
  }

  /** {loggedIn, email, org, plan, authMethod} from `claude auth status --json`; never reads the credential file. */
  async status(userId) {
    if (!hasProviderDirs(userId, "claude", this.dataDir)) return { loggedIn: false, email: null, org: null, plan: null, authMethod: null };
    const { code, stdout, stderr } = await this.run(userId, ["auth", "status", "--json"], { timeoutMs: 30_000 });
    const parsed = parseJsonTail(stdout);
    if (!parsed) throw httpError(502, `claude auth status returned no JSON (exit ${code}): ${tail(stderr || stdout)}`);
    return {
      loggedIn: parsed.loggedIn === true,
      email: typeof parsed.email === "string" ? parsed.email : null,
      org: typeof parsed.orgName === "string" ? parsed.orgName : null,
      plan: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
    };
  }

  /** Spawns `claude auth login`, returns the sign-in link; the pasted code finishes it in completeLogin. */
  async startLogin(userId, { method = "claudeai" } = {}) {
    if (!LOGIN_METHODS.has(method)) throw httpError(400, "unknown sign-in method");
    for (const [id, entry] of this.pending) if (entry.userId === userId) this.cancelLogin(id);
    const dirs = ensureProviderDirs(userId, "claude", this.dataDir);
    const child = spawn(this.wrapperPath, ["auth", "login", method === "console" ? "--console" : "--claudeai"], {
      env: childEnv("claude", dirs), cwd: dirs.claudeCwd, stdio: ["pipe", "pipe", "pipe"],
    });
    const entry = { userId, child, output: "", exited: null, expiresAt: Date.now() + this.ttlMs, timer: null };
    entry.exit = new Promise((resolve) => { entry.resolveExit = resolve; });
    child.stdout.on("data", (chunk) => { entry.output += chunk; });
    child.stderr.on("data", (chunk) => { entry.output += chunk; });
    child.on("error", (error) => { entry.output += `\n${error.message}`; entry.exited = -1; entry.resolveExit(-1); });
    child.on("close", (code) => { entry.exited = code ?? -1; entry.resolveExit(entry.exited); });
    const url = await waitFor(() => entry.output.match(URL_RE)?.[0] ?? null, 30_000, () => entry.exited !== null);
    if (!url) {
      try { child.kill("SIGTERM"); } catch {}
      throw httpError(502, `claude auth login did not print a sign-in link: ${tail(entry.output) || "(no output)"}`);
    }
    const loginId = randomUUID();
    entry.timer = setTimeout(() => { if (this.pending.get(loginId) === entry) this.cancelLogin(loginId); }, this.ttlMs);
    entry.timer.unref?.();
    this.pending.set(loginId, entry);
    return { loginId, url, expiresAt: new Date(entry.expiresAt).toISOString() };
  }

  /**
   * Writes the pasted code to the waiting `claude auth login` and resolves with
   * the account status. The CLI does not exit on its own after success: it prints
   * "Login successful. Press Enter to continue" and waits (found
   * 2026-09-25), so success is detected from that line or from the binary's own
   * `auth status`, then the CLI is given its Enter and retired.
   */
  async completeLogin(loginId, code) {
    const entry = this.pending.get(loginId);
    if (!entry) throw httpError(404, "no pending sign-in with that id — start again");
    const trimmed = String(code ?? "").trim();
    if (!trimmed) throw httpError(400, "paste the code the sign-in page showed");
    if (entry.exited !== null) {
      this.#drop(loginId);
      throw httpError(400, `the sign-in ended before a code was entered: ${tail(entry.output)}`);
    }
    try { entry.child.stdin.write(`${trimmed}\n`); } catch (error) { this.#drop(loginId); throw httpError(502, `could not hand the code to Claude Code: ${error.message}`); }
    const deadline = Date.now() + 90_000;
    let lastStatusCheck = 0;
    let succeeded = false;
    while (Date.now() < deadline) {
      if (entry.exited !== null) break;
      if (/login successful/i.test(entry.output)) { succeeded = true; break; }
      if (Date.now() - lastStatusCheck > 3_000) {
        lastStatusCheck = Date.now();
        try { if ((await this.status(entry.userId)).loggedIn) { succeeded = true; break; } } catch {}
      }
      await sleep(250);
    }
    this.#drop(loginId);
    if (entry.exited === null) {
      // Give the CLI its Enter, then retire it whether or not it takes the hint.
      try { entry.child.stdin.write("\n"); entry.child.stdin.end(); } catch {}
      await Promise.race([entry.exit, sleep(3_000)]);
      if (entry.exited === null) { try { entry.child.kill("SIGTERM"); } catch {} }
    }
    if (!succeeded && entry.exited !== 0) {
      const status = await this.status(entry.userId).catch(() => ({ loggedIn: false }));
      if (!status.loggedIn) throw httpError(400, entry.exited === null ? "the sign-in did not finish in time — start again" : `sign-in failed: ${tail(entry.output)}`);
    }
    const status = await this.status(entry.userId);
    if (!status.loggedIn) throw httpError(400, `the sign-in did not complete: ${tail(entry.output)}`);
    return status;
  }

  cancelLogin(loginId) {
    const entry = this.pending.get(loginId);
    if (!entry) return false;
    this.#drop(loginId);
    try { entry.child.kill("SIGTERM"); } catch {}
    return true;
  }

  pendingFor(userId) {
    return [...this.pending.entries()].filter(([, entry]) => entry.userId === userId).map(([id]) => id);
  }

  /** `claude auth logout` (revokes) then the whole Claude home goes. */
  async logout(userId) {
    for (const id of this.pendingFor(userId)) this.cancelLogin(id);
    if (hasProviderDirs(userId, "claude", this.dataDir)) {
      const { code, stderr } = await this.run(userId, ["auth", "logout"], { timeoutMs: 30_000 });
      if (code !== 0) this.log(`[claude] auth logout exited ${code} for ${userId}: ${tail(stderr)} — removing the home anyway`);
    }
    removeProviderDirs(userId, "claude", this.dataDir);
  }

  cancelAll() { for (const id of [...this.pending.keys()]) this.cancelLogin(id); }

  #drop(loginId) {
    const entry = this.pending.get(loginId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(loginId);
  }
}

export function parseJsonTail(text) {
  const index = String(text ?? "").indexOf("{");
  if (index < 0) return null;
  try { return JSON.parse(String(text).slice(index)); } catch { return null; }
}

export function tail(text, max = 600) {
  const clean = String(text ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitFor(read, timeoutMs, stopWhen) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const value = read();
      if (value) return resolve(value);
      if (stopWhen() || Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}
