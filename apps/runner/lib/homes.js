import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { CLAUDE_MAX_OUTPUT_TOKENS, DATA_DIR } from "./config.js";
import { httpError } from "./http.js";

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const PROVIDERS = new Set(["claude", "chatgpt"]);

export function assertUserId(userId) {
  if (!USER_ID.test(String(userId ?? ""))) throw httpError(400, "invalid user id");
  return String(userId);
}

export function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw httpError(404, "unknown subscription provider");
  return provider;
}

/**
 * One credential home per (user, provider). Claude Code keeps its config and
 * credentials under CLAUDE_CONFIG_DIR; Codex keeps auth.json, config and state
 * under CODEX_HOME. Each also gets an EMPTY working directory so no project
 * file, CLAUDE.md or AGENTS.md is ever discovered by a composer turn.
 */
export function userDirs(userId, dataDir = DATA_DIR) {
  const base = join(dataDir, userId);
  return {
    base,
    claudeHome: join(base, "claude-home"),
    claudeConfigDir: join(base, "claude-home", ".claude"),
    claudeCwd: join(base, "claude-cwd"),
    codexHome: join(base, "codex-home"),
    codexConfigDir: join(base, "codex-home", ".codex"),
    codexCwd: join(base, "codex-cwd"),
  };
}

function providerDirs(dirs, provider) {
  return provider === "claude"
    ? [dirs.claudeHome, dirs.claudeConfigDir, dirs.claudeCwd]
    : [dirs.codexHome, dirs.codexConfigDir, dirs.codexCwd];
}

export function ensureProviderDirs(userId, provider, dataDir = DATA_DIR) {
  const dirs = userDirs(assertUserId(userId), dataDir);
  for (const dir of [dirs.base, ...providerDirs(dirs, assertProvider(provider))]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dirs;
}

export function hasProviderDirs(userId, provider, dataDir = DATA_DIR) {
  const dirs = userDirs(assertUserId(userId), dataDir);
  return providerDirs(dirs, assertProvider(provider)).every((dir) => existsSync(dir));
}

/** The user ids that have a credential home, for the API's cleanup of deleted accounts' sign-ins. */
export function listHomes(dataDir = DATA_DIR) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && USER_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function removeProviderDirs(userId, provider, dataDir = DATA_DIR) {
  const dirs = userDirs(assertUserId(userId), dataDir);
  for (const dir of providerDirs(dirs, assertProvider(provider))) rmSync(dir, { recursive: true, force: true });
  if (existsSync(dirs.base) && !existsSync(dirs.claudeHome) && !existsSync(dirs.codexHome)) rmSync(dirs.base, { recursive: true, force: true });
}

/** The environment a spawned official binary sees: the user's home and nothing of the runner's own. */
export function childEnv(provider, dirs, extra = {}) {
  const base = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  if (provider === "claude") {
    return {
      ...base,
      HOME: dirs.claudeHome,
      CLAUDE_CONFIG_DIR: dirs.claudeConfigDir,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: CLAUDE_MAX_OUTPUT_TOKENS,
      DISABLE_AUTOUPDATER: "1",
      ...extra,
    };
  }
  return { ...base, HOME: dirs.codexHome, CODEX_HOME: dirs.codexConfigDir, ...extra };
}
