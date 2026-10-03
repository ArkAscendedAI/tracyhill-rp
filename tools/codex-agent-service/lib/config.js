import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PORT = Number.parseInt(process.env.AGENT_PORT || "7701", 10);
export const SECRET = process.env.AGENT_SECRET || "";
export const ALLOWED_IPS = (process.env.ALLOWED_IPS || "127.0.0.1,::1,::ffff:127.0.0.1")
  .split(",").map((value) => value.trim()).filter(Boolean);
const DATA_DIR = join(ROOT, "data");
export const EVENTS_DIR = join(DATA_DIR, "events");
export const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/codex-uploads";
export const COMPOSER_DIR = process.env.COMPOSER_DIR || "/tmp/codex-composer";
export const PANEL_MANIFEST = join(DATA_DIR, "panel-sessions.json");
// Pre-2026-07-12 exec-wrapper session archive: only its COUNT is still served
// (`legacySessionCount` on the /v2 status, read by web + Android). The API that
// wrote/read it was removed 2026-09-02.
export const LEGACY_MANIFEST = join(DATA_DIR, "sessions.json");
export const TLS_KEY = join(ROOT, "certs", "agent-key.pem");
export const TLS_CERT = join(ROOT, "certs", "agent-cert.pem");
export const CODEX_BIN = process.env.CODEX_BIN || "codex";
export const MAX_BODY_BYTES = Number.parseInt(process.env.MAX_BODY_BYTES || String(80 * 1024 * 1024), 10);
export const EVENTS_RETENTION_DAYS = Number.parseInt(process.env.EVENTS_RETENTION_DAYS || "30", 10);
export const EVENTS_MAX_MB = Number.parseInt(process.env.EVENTS_MAX_MB || "500", 10);
// getSession liveEvents tail budget — an unbounded active turn once shipped
// hundreds of MB in a single JSON body.
export const LIVE_EVENTS_MAX_BYTES = Number.parseInt(process.env.LIVE_EVENTS_MAX_MB || "4", 10) * 1024 * 1024;
// Logs above this size get one streaming compaction at boot (legacy pre-stub
// diff snapshots) before any replay can stream them.
export const BOOT_COMPACT_MIN_BYTES = Number.parseInt(process.env.BOOT_COMPACT_MIN_MB || "8", 10) * 1024 * 1024;

for (const dir of [DATA_DIR, EVENTS_DIR, UPLOAD_DIR, COMPOSER_DIR]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const WORKSPACES = discoverWorkspaces(process.env.WORKSPACES_JSON);

function discoverWorkspaces(raw) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return normalizeWorkspaces(parsed);
    } catch (error) {
      console.error(`[config] invalid WORKSPACES_JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const home = homedir();
  const result = { home: { id: "home", name: "Home", cwd: home } };
  const projects = join(home, "projects");
  if (!existsSync(projects)) return result;
  for (const name of readdirSync(projects).sort((a, b) => a.localeCompare(b))) {
    const cwd = join(projects, name);
    try {
      if (!statSync(cwd).isDirectory()) continue;
      const id = slug(name);
      result[id] = { id, name: humanize(name), cwd };
    } catch {}
  }
  return result;
}

function normalizeWorkspaces(value) {
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || typeof raw.cwd !== "string") continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id : slug(key);
    result[id] = { id, name: typeof raw.name === "string" && raw.name ? raw.name : humanize(key), cwd: resolve(raw.cwd) };
  }
  return Object.keys(result).length ? result : { home: { id: "home", name: "Home", cwd: homedir() } };
}

function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || basename(value); }
function humanize(value) {
  if (value === "tracyhill-rp") return "TracyHill RP";
  if (value === "tracyhill-rp-android") return "TracyHill RP Android";
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function workspaceById(id) { return id && WORKSPACES[id] ? WORKSPACES[id] : null; }
export function listWorkspaces() { return Object.values(WORKSPACES); }
export function safeId(id) { return typeof id === "string" && /^[a-zA-Z0-9._-]{1,160}$/.test(id); }
