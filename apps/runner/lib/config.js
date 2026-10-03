import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Where the Docker init service writes the derived runner secret (2026-10-01); declared before SECRET reads it.
export const DEFAULT_RUNNER_SECRET_FILE = "/run/tracyhill-secrets/runner.secret";
export const PORT = parsePort(process.env.RUNNER_PORT, 7710);
// A bind mount OUTSIDE /app: no repository file (a CLAUDE.md above all) may be an
// ancestor of a per-user working directory (Claude Code reads CLAUDE.md files
// from the working directory up).
export const DATA_DIR = resolve(process.env.RUNNER_DATA_DIR || "/srv/subscriptions");
export const SECRET = resolveRunnerSecret(process.env);
export const CLAUDE_WRAPPER = process.env.CLAUDE_CLI_WRAPPER || join(ROOT, "cli-wrapper.sh");
export const CODEX_BIN = process.env.CODEX_BIN || join(ROOT, "node_modules", ".bin", "codex");
export const MAX_BODY_BYTES = Number.parseInt(process.env.MAX_BODY_BYTES || String(100 * 1024 * 1024), 10);
export const CLAUDE_MAX_OUTPUT_TOKENS = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || "64000";
export const CLAUDE_LOGIN_TTL_MS = 10 * 60_000;
export const CODEX_LOGIN_TTL_MS = 15 * 60_000;
export const CODEX_IDLE_MS = Number.parseInt(process.env.RUNNER_CODEX_IDLE_MS || String(30 * 60_000), 10);

/**
 * The shared secret between the API/worker and the runner. An explicit
 * RUNNER_SECRET wins (cross-host deployments); otherwise it is derived from
 * SESSION_SECRET so the shipped Compose file needs no extra variable. The API
 * side derives it with the same parameters (provider-runtime deriveRunnerSecret).
 * With neither set (2026-10-01: the deployment's secret is generated, not
 * configured), the Docker init service has written the derived value to
 * RUNNER_SECRET_FILE on a volume only it and the runner mount, so the runner
 * never holds the session secret itself.
 */
export function resolveRunnerSecret(env, readSecretFile = readTrimmedFile) {
  const explicit = String(env.RUNNER_SECRET || "").trim();
  if (explicit) return explicit;
  const derived = deriveRunnerSecret(env.SESSION_SECRET);
  if (derived) return derived;
  return readSecretFile(String(env.RUNNER_SECRET_FILE || "").trim() || DEFAULT_RUNNER_SECRET_FILE);
}

function readTrimmedFile(file) {
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
}

export function deriveRunnerSecret(sessionSecret) {
  const secret = String(sessionSecret || "").trim();
  if (!secret) return "";
  return Buffer.from(hkdfSync("sha256", secret, "tracyhill-rp", "runner-secret", 32)).toString("hex");
}

export function parsePort(raw, fallback) {
  const trimmed = String(raw ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const port = Number.parseInt(trimmed, 10);
  return port > 0 && port <= 65535 ? port : fallback;
}
