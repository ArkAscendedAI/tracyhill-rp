// ═══════════════════════════════════════════════════════════
// SHARED UTILITIES — imported by server.js, campaigns.js, pipeline.js
// ═══════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { DEFAULT_SEED_UPDATE_TEMPLATE, DEFAULT_SYSPROMPT_UPDATE_TEMPLATE, DEFAULT_EXAMPLE_STATE_SEED, DEFAULT_EXAMPLE_SYSTEM_PROMPT } from "./wizard-defaults.js";

// ── Path-safety helpers (prevent traversal attacks) ──
export function safeHexId(id) { return typeof id === "string" && /^[a-f0-9]{1,48}$/.test(id); }
export function safeAlphanumId(id) { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id); }
function assertSafeChild(parent, child) { const r = resolve(parent, child); if (!r.startsWith(resolve(parent) + "/") && r !== resolve(parent)) throw new Error("Path traversal blocked"); return r; }

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, "..", "data");
export const USERS_FILE = join(DATA_DIR, "users.json");
export const USERS_DIR = join(DATA_DIR, "users");
export const IMAGES_DIR = join(DATA_DIR, "images");

// Ensure data directories exist
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(USERS_DIR)) mkdirSync(USERS_DIR, { recursive: true });
if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true });

// ── Atomic file writes ──
export function atomicWrite(filePath, data, opts) {
  const tmp = filePath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, data, opts || {});
  renameSync(tmp, filePath);
}

// ── Session secret ──
const SECRET_FILE = join(DATA_DIR, "session.secret");
export function getSessionSecret() {
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, "utf8").trim();
  const s = crypto.randomBytes(48).toString("hex");
  writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

// ── User management ──
export function loadUsers() {
  if (existsSync(USERS_FILE)) { try { return JSON.parse(readFileSync(USERS_FILE, "utf8")); } catch {} }
  return [];
}
export function saveUsers(users) { atomicWrite(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 }); }
export function findUser(username) { return loadUsers().find(u => u.username.toLowerCase() === username.toLowerCase()); }
export function findUserById(id) { return loadUsers().find(u => u.id === id); }

// ── Per-user data paths ──
export function userDataDir(userId) {
  if (!safeHexId(userId)) throw new Error("Invalid userId");
  const dir = assertSafeChild(USERS_DIR, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
export function userStatePath(userId) { return join(userDataDir(userId), "state.json"); }
export function userKeysPath(userId) { return join(userDataDir(userId), "apikeys.json"); }

// ── Per-user state I/O ──
export function loadUserState(userId) {
  const p = userStatePath(userId);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return null;
}
export function saveUserState(userId, state) {
  const j = JSON.stringify(state);
  atomicWrite(userStatePath(userId), j, "utf8");
  return Math.round(j.length / 1024 / 1024 * 100) / 100;
}
export function loadUserKeys(userId) {
  const p = userKeysPath(userId);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return { anthropic: "", xai: "", openai: "", deepseek: "", zai: "", google: "", customEndpoints: [] };
}
export function saveUserKeys(userId, keys) {
  atomicWrite(userKeysPath(userId), JSON.stringify(keys, null, 2), { mode: 0o600 });
}

// ── Pending messages (disconnect recovery) ──
export function userPendingDir(userId) { const d = join(userDataDir(userId), "pending"); if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; }
export function savePending(userId, sessionId, msg) { if (!safeAlphanumId(sessionId)) return; if (!msg?.content && !msg?.thinking) return; atomicWrite(join(userPendingDir(userId), sessionId + ".json"), JSON.stringify(msg), "utf8"); }
export function loadPending(userId) {
  const d = join(userDataDir(userId), "pending");
  if (!existsSync(d)) return {};
  const result = {};
  for (const f of readdirSync(d).filter(f => f.endsWith(".json"))) {
    try { result[f.replace(".json", "")] = JSON.parse(readFileSync(join(d, f), "utf8")); } catch {}
  }
  return result;
}
export function clearPendingFiles(userId, sessionIds) { const d = join(userDataDir(userId), "pending"); if (!existsSync(d)) return; for (const sid of sessionIds) { if (!safeAlphanumId(sid)) continue; const f = join(d, sid + ".json"); if (existsSync(f)) try { rmSync(f); } catch {} } }

// ── Auth middleware ──
export function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  const user = findUserById(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: "User no longer exists" }); }
  req.session.role = user.role;
  return next();
}
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.role !== "admin") return res.status(403).json({ error: "Admin required" });
    next();
  });
}

// ── Campaign data paths ──
export function campaignsPath(userId) { return join(userDataDir(userId), "campaigns.json"); }
export function loadCampaigns(userId) {
  const p = campaignsPath(userId);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return [];
}
export function saveCampaigns(userId, campaigns) {
  atomicWrite(campaignsPath(userId), JSON.stringify(campaigns, null, 2), "utf8");
}

// ── Campaign version history ──
export function campaignVersionsDir(userId, campaignId) {
  if (!safeHexId(campaignId)) throw new Error("Invalid campaignId");
  const d = join(userDataDir(userId), "campaign_versions", campaignId);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
export function archiveCampaignVersion(userId, campaignId, version, stateSeed, systemPrompt) {
  const dir = campaignVersionsDir(userId, campaignId);
  const ts = new Date().toISOString();
  if (stateSeed) atomicWrite(join(dir, `seed_v${version}.md`), stateSeed, "utf8");
  if (systemPrompt) atomicWrite(join(dir, `system_prompt_v${version}.md`), systemPrompt, "utf8");
  // Write a manifest entry
  const manifestPath = join(dir, "manifest.json");
  let manifest = [];
  if (existsSync(manifestPath)) { try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch {} }
  manifest.push({ version, timestamp: ts, hasSeed: !!stateSeed, hasSystemPrompt: !!systemPrompt });
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}
export function loadCampaignVersions(userId, campaignId) {
  if (!safeHexId(campaignId)) return [];
  const dir = join(userDataDir(userId), "campaign_versions", campaignId);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return [];
  try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return []; }
}
export function loadCampaignVersionFile(userId, campaignId, filename) {
  if (!safeHexId(campaignId)) return null;
  // Sanitize filename — reject path traversal
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe !== filename) return null;
  const dir = join(userDataDir(userId), "campaign_versions", campaignId);
  const p = join(dir, safe);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

// ── Pipeline data paths ──
export function pipelinesDir(userId) {
  const d = join(userDataDir(userId), "pipelines");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
export function loadPipeline(userId, pipelineId) {
  if (!safeHexId(pipelineId)) return null;
  const p = join(pipelinesDir(userId), pipelineId + ".json");
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return null;
}
export function savePipeline(userId, pipeline) {
  if (!safeHexId(pipeline?.id)) throw new Error("Invalid pipeline id");
  atomicWrite(join(pipelinesDir(userId), pipeline.id + ".json"), JSON.stringify(pipeline, null, 2), "utf8");
}

// ── Wizard templates ──
const WIZARD_TEMPLATE_DEFAULTS = {
  exampleStateSeed: DEFAULT_EXAMPLE_STATE_SEED,
  exampleSystemPrompt: DEFAULT_EXAMPLE_SYSTEM_PROMPT,
  seedUpdateTemplate: DEFAULT_SEED_UPDATE_TEMPLATE,
  sysPromptUpdateTemplate: DEFAULT_SYSPROMPT_UPDATE_TEMPLATE
};

export function wizardTemplatesPath(userId) { return join(userDataDir(userId), "wizard_templates.json"); }
export function loadWizardTemplates(userId) {
  const p = wizardTemplatesPath(userId);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  // First access — create with defaults
  const defaults = { ...WIZARD_TEMPLATE_DEFAULTS };
  atomicWrite(p, JSON.stringify(defaults, null, 2), "utf8");
  return defaults;
}
export function saveWizardTemplates(userId, templates) {
  atomicWrite(wizardTemplatesPath(userId), JSON.stringify(templates, null, 2), "utf8");
}

// ═══════════════════════════════════════════════════════════
// Per-session file architecture (Phase 1 migration)
// ═══════════════════════════════════════════════════════════

// Session ID validation — supports both base36 (Date.now().toString(36) + random) and hex (crypto.randomBytes)
export function safeSessionId(id) { return typeof id === "string" && /^[a-z0-9]{1,20}$/.test(id); }

// Sessions directory
export function sessionsDir(userId) {
  const d = join(userDataDir(userId), "sessions");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

// Load individual session
export function loadSession(userId, sessionId) {
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return null;
  const p = join(sessionsDir(userId), sessionId + ".json");
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return null;
}

// Save individual session
export function saveSession(userId, session) {
  if (!safeSessionId(session?.id) && !safeAlphanumId(session?.id)) throw new Error("Invalid session id");
  atomicWrite(join(sessionsDir(userId), session.id + ".json"), JSON.stringify(session, null, 2), "utf8");
}

// Delete individual session file
export function deleteSessionFile(userId, sessionId) {
  if (!safeSessionId(sessionId) && !safeAlphanumId(sessionId)) return;
  const p = join(sessionsDir(userId), sessionId + ".json");
  if (existsSync(p)) try { rmSync(p); } catch {}
}

// Sessions metadata index
export function sessionsMetaPath(userId) { return join(userDataDir(userId), "sessions_meta.json"); }

export function loadSessionsMeta(userId) {
  const p = sessionsMetaPath(userId);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return {};
}

export function saveSessionsMeta(userId, meta) {
  atomicWrite(sessionsMetaPath(userId), JSON.stringify(meta, null, 2), "utf8");
}

// Update a single entry in sessions_meta (read-modify-write)
export function updateSessionMeta(userId, sessionId, fields) {
  const meta = loadSessionsMeta(userId);
  if (!meta[sessionId]) meta[sessionId] = {};
  Object.assign(meta[sessionId], fields);
  saveSessionsMeta(userId, meta);
}

// Remove a session from the meta index
export function removeSessionMeta(userId, sessionId) {
  const meta = loadSessionsMeta(userId);
  delete meta[sessionId];
  saveSessionsMeta(userId, meta);
}

// Build meta entry from a full session object
export function buildSessionMeta(session) {
  const msgs = session.messages || [];
  const lastMsg = msgs[msgs.length - 1];
  return {
    id: session.id,
    name: session.name || "(unnamed)",
    selectedModel: session.selectedModel || null,
    folderId: session.folderId || null,
    campaignId: session.campaignId || null,
    sessionType: session.sessionType || null,
    deletedAt: session.deletedAt || null,
    createdAt: session.createdAt || null,
    messageCount: msgs.length,
    lastActivity: lastMsg?.timestamp || session.createdAt || null,
  };
}

// User meta (preferences: activeId, folders, fontSize)
export function userMetaPath(userId) { return join(userDataDir(userId), "meta.json"); }

export function loadUserMeta(userId) {
  const p = userMetaPath(userId);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return { activeId: null, folders: [], fontSize: 14 };
}

export function saveUserMeta(userId, meta) {
  atomicWrite(userMetaPath(userId), JSON.stringify(meta, null, 2), "utf8");
}

// Migration flag
export function isMigrated(userId) {
  return existsSync(join(userDataDir(userId), "migrated.flag"));
}

// Migrate from monolithic state.json to per-session files
export function migrateToPerSession(userId) {
  if (isMigrated(userId)) return { already: true };
  const statePath = userStatePath(userId);
  if (!existsSync(statePath)) {
    // New user with no state — mark as migrated so per-session code paths are used
    sessionsDir(userId); // ensure sessions/ dir exists
    saveSessionsMeta(userId, {});
    saveUserMeta(userId, { activeId: null, folders: [], fontSize: 14 });
    writeFileSync(join(userDataDir(userId), "migrated.flag"), new Date().toISOString(), "utf8");
    return { migrated: true, sessionCount: 0 };
  }

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const sessions = state.sessions || {};
  const sessionIds = Object.keys(sessions);

  // Create sessions directory
  const dir = sessionsDir(userId);

  // Write individual session files
  const meta = {};
  for (const [sid, session] of Object.entries(sessions)) {
    atomicWrite(join(dir, sid + ".json"), JSON.stringify(session, null, 2), "utf8");
    meta[sid] = buildSessionMeta(session);
  }

  // Write sessions_meta.json
  saveSessionsMeta(userId, meta);

  // Write meta.json (preferences)
  saveUserMeta(userId, {
    activeId: state.activeId || null,
    folders: state.folders || [],
    fontSize: state.fontSize || 14,
  });

  // Backup original state.json
  const bakPath = statePath + ".bak";
  if (!existsSync(bakPath)) {
    writeFileSync(bakPath, readFileSync(statePath));
  }

  // Set migration flag
  writeFileSync(join(userDataDir(userId), "migrated.flag"), new Date().toISOString(), "utf8");

  return { migrated: true, sessionCount: sessionIds.length };
}
