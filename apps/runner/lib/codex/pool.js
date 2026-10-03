import { AppServerClient } from "../../../../tools/codex-agent-service/lib/appServerClient.js";
import { ComposerService } from "../../../../tools/codex-agent-service/lib/composerService.js";
import { CODEX_BIN, CODEX_IDLE_MS, CODEX_LOGIN_TTL_MS, DATA_DIR } from "../config.js";
import { childEnv, ensureProviderDirs, hasProviderDirs, removeProviderDirs } from "../homes.js";
import { httpError } from "../http.js";

// One Codex app-server per connected user, in that user's own CODEX_HOME, sharing
// the sidecar's composer implementation (tools/codex-agent-service/lib) so the
// panel sidecar and the runner never drift. Account methods
// are the app-server's own: device-code login, login/completed, logout, read.
export const COMPOSER_ARGS = [
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
];

// How long a finished device-code result stays readable after its first read.
export const LOGIN_RESULT_GRACE_MS = 10 * 60_000;

export class CodexPool {
  constructor({ codexBin = CODEX_BIN, dataDir = DATA_DIR, idleMs = CODEX_IDLE_MS, loginTtlMs = CODEX_LOGIN_TTL_MS, log = (line) => console.error(line), clientFactory = null } = {}) {
    this.codexBin = codexBin;
    this.dataDir = dataDir;
    this.idleMs = idleMs;
    this.loginTtlMs = loginTtlMs;
    this.log = log;
    this.clientFactory = clientFactory;
    this.entries = new Map();
    this.reapTimer = setInterval(() => this.reap(), 60_000);
    this.reapTimer.unref?.();
  }

  entry(userId, { create = true } = {}) {
    const existing = this.entries.get(userId);
    if (existing || !create) return existing ?? null;
    const dirs = ensureProviderDirs(userId, "chatgpt", this.dataDir);
    const client = this.clientFactory
      ? this.clientFactory({ userId, dirs })
      : new AppServerClient({
          command: this.codexBin,
          args: COMPOSER_ARGS,
          env: childEnv("chatgpt", dirs),
          clientInfo: { name: "tracyhill-rp-runner", title: "TracyHill RP subscription runner", version: "1.0.0" },
        });
    const composer = new ComposerService({ client, cwd: dirs.codexCwd });
    const entry = { userId, client, composer, lastUsed: Date.now(), pendingLogins: new Map() };
    client.on("notification", (message) => {
      if (message?.method === "account/login/completed") this.#onLoginCompleted(entry, message.params || {});
    });
    client.on("exit", () => {
      for (const pending of entry.pendingLogins.values()) {
        if (!pending.result.done) pending.result = { done: true, success: false, error: "Codex stopped before the sign-in finished — start again" };
      }
    });
    client.on("stderr", (text) => this.log(`[codex:${userId}] ${text}`));
    this.entries.set(userId, entry);
    return entry;
  }

  #onLoginCompleted(entry, params) {
    const target = params.loginId ? entry.pendingLogins.get(params.loginId) : [...entry.pendingLogins.values()].find((pending) => !pending.result.done);
    if (!target) return;
    target.result = { done: true, success: params.success === true, error: params.success === true ? null : (params.error || "sign-in failed") };
  }

  async stream(userId, payload, callbacks, signal) {
    const entry = this.entry(userId);
    entry.lastUsed = Date.now();
    try { return await entry.composer.stream(payload, callbacks, signal); }
    finally { entry.lastUsed = Date.now(); }
  }

  /** {loggedIn, email, plan, org} from account/read; a user without a home is simply not signed in. */
  async status(userId) {
    if (!this.entries.has(userId) && !hasProviderDirs(userId, "chatgpt", this.dataDir)) return { loggedIn: false, email: null, plan: null, org: null };
    const entry = this.entry(userId);
    entry.lastUsed = Date.now();
    const read = await entry.client.request("account/read", { refreshToken: false }, 30_000);
    const account = read?.account ?? null;
    if (!account || account.type !== "chatgpt") return { loggedIn: false, email: null, plan: null, org: null, requiresOpenaiAuth: read?.requiresOpenaiAuth === true };
    return { loggedIn: true, email: typeof account.email === "string" ? account.email : null, plan: typeof account.planType === "string" ? account.planType : null, org: null };
  }

  /** Device-code sign-in: the user opens the link and enters the code on the provider's page. */
  async startLogin(userId) {
    const entry = this.entry(userId);
    entry.lastUsed = Date.now();
    const started = await entry.client.request("account/login/start", { type: "chatgptDeviceCode" }, 60_000);
    if (!started?.loginId || !started.verificationUrl || !started.userCode) throw httpError(502, "Codex did not return a device-code sign-in");
    const expiresAt = Date.now() + this.loginTtlMs;
    const pending = { result: { done: false, success: false, error: null }, expiresAt };
    entry.pendingLogins.set(started.loginId, pending);
    const timer = setTimeout(() => {
      if (entry.pendingLogins.get(started.loginId) === pending && !pending.result.done) pending.result = { done: true, success: false, error: "The code expired. Start again." };
    }, this.loginTtlMs);
    timer.unref?.();
    return { loginId: started.loginId, url: started.verificationUrl, userCode: started.userCode, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * {done, success, error} for a started login. A finished result stays readable
   * for a grace period instead of vanishing on the first read: two concurrent
   * status reads from the app (its card poll and its list refresh) must both
   * see the same outcome (production, 2026-09-25).
   */
  loginResult(userId, loginId, { now = Date.now() } = {}) {
    const entry = this.entry(userId, { create: false });
    const pending = entry?.pendingLogins.get(loginId);
    if (!pending) return null;
    if (pending.result.done) {
      if (!pending.doneAt) pending.doneAt = now;
      else if (now - pending.doneAt > LOGIN_RESULT_GRACE_MS) {
        entry.pendingLogins.delete(loginId);
        return null;
      }
    }
    return pending.result;
  }

  async cancelLogin(userId, loginId) {
    const entry = this.entry(userId, { create: false });
    if (!entry) return false;
    entry.pendingLogins.delete(loginId);
    try { await entry.client.request("account/login/cancel", { loginId }, 30_000); } catch (error) { this.log(`[codex:${userId}] login cancel: ${error.message}`); }
    return true;
  }

  /** account/logout (revokes) then the whole Codex home goes. */
  async logout(userId) {
    const entry = this.entry(userId, { create: false });
    if (entry) {
      try { await entry.client.request("account/logout", {}, 30_000); }
      catch (error) { this.log(`[codex:${userId}] account/logout: ${error.message} — removing the home anyway`); }
      await entry.client.stop();
      this.entries.delete(userId);
    }
    removeProviderDirs(userId, "chatgpt", this.dataDir);
  }

  reap(now = Date.now()) {
    for (const [userId, entry] of this.entries) {
      const busy = entry.composer.runs.size > 0 || [...entry.pendingLogins.values()].some((pending) => !pending.result.done);
      // Finished results past their grace period are dropped here too.
      for (const [loginId, pending] of entry.pendingLogins) if (pending.result.done && pending.doneAt && now - pending.doneAt > LOGIN_RESULT_GRACE_MS) entry.pendingLogins.delete(loginId);
      if (busy || now - entry.lastUsed <= this.idleMs) continue;
      void entry.client.stop();
      this.entries.delete(userId);
    }
  }

  async stopAll() {
    clearInterval(this.reapTimer);
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.client.stop()));
    this.entries.clear();
  }
}
