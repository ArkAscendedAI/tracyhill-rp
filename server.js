import express from "express";
import compression from "compression";
import session from "express-session";
import bcrypt from "bcryptjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import https from "https";
import http from "http";
import { execSync } from "child_process";
import campaignRoutes from "./server/campaigns.js";
import pipelineRoutes, { cleanOrphanedPipelines } from "./server/pipeline.js";
import wizardRoutes from "./server/wizard.js";
import pipelineMultiRoutes from "./server/pipeline-multi.js";
import wizardMultiRoutes from "./server/wizard-multi.js";
import sessionRoutes from "./server/sessions.js";
import { loadSession, saveSession, isMigrated, updateSessionMeta, loadSessionsMeta, loadUserMeta, saveUserMeta, buildSessionMeta, deleteSessionFile, removeSessionMeta } from "./server/shared.js";
import { isMfaEnabled, parseTrustToken, checkTrustedDevice, createMfaChallenge, setTrustCookie, handleSendCode, handleVerify, handleEnroll, handleEnrollVerify, handleGetMfaStatus, handleRevokeDevice, handleRevokeAllDevices, handleUpdatePhone, handleUpdatePhoneVerify, handleForgotPassword, handleForgotPasswordSendCode, handleForgotPasswordVerify, handleForgotPasswordReset, handleDeleteRequest, handleDeleteSendCode, handleDeleteConfirm, handleDeleteExecute } from "./server/mfa.js";
import { PRIVACY_HTML, TERMS_HTML } from "./server/legal.js";
import { isRegistrationEnabled, handleRegister, handleRegisterVerify, handleRegisterResend } from "./server/register.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const USERS_FILE = join(DATA_DIR, "users.json");
const USERS_DIR = join(DATA_DIR, "users");
const DIST_DIR = join(__dirname, "dist");
const SECRET_FILE = join(DATA_DIR, "session.secret");
const IMAGES_DIR = join(DATA_DIR, "images");

// Legacy paths (for migration)
const LEGACY_CREDS = join(DATA_DIR, "credentials.json");
const LEGACY_HASH = join(DATA_DIR, "password.hash");
const LEGACY_STATE = join(DATA_DIR, "state.json");
const LEGACY_KEYS = join(DATA_DIR, "apikeys.json");

const PORT = process.env.PORT || 3000;
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const CC_HOST = process.env.CLAUDE_CODE_HOST || "";
const CC_PORT = process.env.CLAUDE_CODE_PORT || "7700";
const CC_SECRET = process.env.CLAUDE_CODE_SECRET || "";
const CODEX_HOST = process.env.CODEX_HOST || "";
const CODEX_PORT = process.env.CODEX_PORT || "7701";
const CODEX_SECRET = process.env.CODEX_SECRET || "";

// Rate limiter (per-IP + per-username)
const MAX_FAILURES = 3;
const LOCKOUT_MS = 30 * 60 * 1000;
const failureMap = new Map(); // keyed by IP or "user:<username>"
function checkRateLimit(key) { const e = failureMap.get(key); if (!e) return { blocked: false }; if (Date.now() - e.lastAttempt > LOCKOUT_MS) { failureMap.delete(key); return { blocked: false }; } if (e.count >= MAX_FAILURES) return { blocked: true, remainSec: Math.ceil((LOCKOUT_MS - (Date.now() - e.lastAttempt)) / 1000) }; return { blocked: false }; }
function recordFailure(key) { const e = failureMap.get(key) || { count: 0, lastAttempt: 0 }; e.count++; e.lastAttempt = Date.now(); failureMap.set(key, e); return Math.min(8000, 1000 * Math.pow(2, e.count - 1)); }
function clearFailures(...keys) { for (const k of keys) failureMap.delete(k); }

// Per-user concurrent proxy request limiter
const MAX_CONCURRENT_PROXY = 10;
const activeProxyCount = new Map(); // userId → count
function acquireProxy(userId) { const c = activeProxyCount.get(userId) || 0; if (c >= MAX_CONCURRENT_PROXY) return false; activeProxyCount.set(userId, c + 1); return true; }
function releaseProxy(userId) { const c = activeProxyCount.get(userId) || 0; if (c <= 1) activeProxyCount.delete(userId); else activeProxyCount.set(userId, c - 1); }

// Dummy hash for timing-safe login (prevent username enumeration)
const DUMMY_HASH = "$2a$12$000000000000000000000uDuFGbBTOTJuaJUIJPHBW0PKlGVK3YFe";

// Password complexity: 8+ chars, must include uppercase, lowercase, and number
function validatePassword(pw) {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 128) return "Password must be 128 characters or fewer";
  if (!/[a-z]/.test(pw)) return "Password must include a lowercase letter";
  if (!/[A-Z]/.test(pw)) return "Password must include an uppercase letter";
  if (!/[0-9]/.test(pw)) return "Password must include a number";
  return null;
}

// Path-safety helpers (prevent traversal attacks)
function safeHexId(id) { return typeof id === "string" && /^[a-f0-9]{1,48}$/.test(id); }
function safeAlphanumId(id) { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id); }

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(USERS_DIR)) mkdirSync(USERS_DIR, { recursive: true });
if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true });

function atomicWrite(filePath, data, opts) {
  const tmp = filePath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, data, opts || {});
  renameSync(tmp, filePath);
}

function getSessionSecret() {
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, "utf8").trim();
  const s = crypto.randomBytes(48).toString("hex");
  writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

// ═══════════════════════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════════════════════

function loadUsers() {
  if (existsSync(USERS_FILE)) { try { return JSON.parse(readFileSync(USERS_FILE, "utf8")); } catch {} }
  return [];
}
function saveUsers(users) { atomicWrite(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 }); }
function findUser(username) { return loadUsers().find(u => u.username.toLowerCase() === username.toLowerCase()); }
function findUserById(id) { return loadUsers().find(u => u.id === id); }

function userDataDir(userId) {
  if (!safeHexId(userId)) throw new Error("Invalid userId");
  const dir = join(USERS_DIR, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
function userStatePath(userId) { return join(userDataDir(userId), "state.json"); }
function userKeysPath(userId) { return join(userDataDir(userId), "apikeys.json"); }

function loadUserState(userId) {
  const p = userStatePath(userId);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return null;
}
function saveUserState(userId, state) {
  const j = JSON.stringify(state);
  atomicWrite(userStatePath(userId), j, "utf8");
  return Math.round(j.length / 1024 / 1024 * 100) / 100;
}
function loadUserKeys(userId) {
  const p = userKeysPath(userId);
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return { anthropic: "", xai: "", openai: "", deepseek: "", zai: "", google: "" };
}
function saveUserKeys(userId, keys) {
  atomicWrite(userKeysPath(userId), JSON.stringify(keys, null, 2), { mode: 0o600 });
}
function userPendingDir(userId) { const d = join(userDataDir(userId), "pending"); if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; }
function savePending(userId, sessionId, msg) { if (!safeAlphanumId(sessionId)) return; if (!msg?.content && !msg?.thinking) return; atomicWrite(join(userPendingDir(userId), sessionId + ".json"), JSON.stringify(msg), "utf8"); }
function loadPending(userId) {
  const d = join(userDataDir(userId), "pending");
  if (!existsSync(d)) return {};
  const result = {};
  for (const f of readdirSync(d).filter(f => f.endsWith(".json"))) {
    try { result[f.replace(".json", "")] = JSON.parse(readFileSync(join(d, f), "utf8")); } catch {}
  }
  return result;
}
function clearPendingFiles(userId, sessionIds) { const d = join(userDataDir(userId), "pending"); if (!existsSync(d)) return; for (const sid of sessionIds) { if (!safeAlphanumId(sid)) continue; const f = join(d, sid + ".json"); if (existsSync(f)) try { rmSync(f); } catch {} } }

// ═══════════════════════════════════════════════════════════
// SERVER-SIDE SSE PARSERS (for accumulating responses when browser disconnects)
// ═══════════════════════════════════════════════════════════

function parseAccumulatedAnthropicSSE(raw) {
  const st = { text: "", thinking: "", usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, blockType: null, stopReason: null };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.type === "message_start" && evt.message?.usage) { st.usage.input = evt.message.usage.input_tokens || 0; st.usage.cacheRead = evt.message.usage.cache_read_input_tokens || 0; st.usage.cacheCreation = evt.message.usage.cache_creation_input_tokens || 0; }
      if (evt.type === "content_block_start") st.blockType = evt.content_block?.type || "text";
      if (evt.type === "content_block_delta") { if (evt.delta?.type === "thinking_delta" || st.blockType === "thinking") st.thinking += (evt.delta?.thinking || ""); else if (evt.delta?.type === "text_delta" || evt.delta?.text !== undefined) st.text += (evt.delta?.text || ""); }
      if (evt.type === "content_block_stop") st.blockType = null;
      if (evt.type === "message_delta") { if (evt.usage) st.usage.output = evt.usage.output_tokens || 0; if (evt.delta?.stop_reason) st.stopReason = evt.delta.stop_reason; }
    } catch {}
  }
  return st;
}

function parseAccumulatedChatCompletionsSSE(raw) {
  const st = { text: "", thinking: "", usage: { input: 0, output: 0 }, stopReason: null };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") continue;
    try {
      const evt = JSON.parse(line.slice(6));
      if (evt.choices?.[0]?.finish_reason) { const fr = evt.choices[0].finish_reason; st.stopReason = (fr === "length" || fr === "insufficient_system_resource") ? "max_tokens" : fr; }
      if (evt.choices?.[0]?.delta?.content) st.text += evt.choices[0].delta.content;
      if (evt.choices?.[0]?.delta?.reasoning_content) st.thinking += evt.choices[0].delta.reasoning_content;
      if (evt.choices?.[0]?.delta?.reasoning?.content) st.thinking += evt.choices[0].delta.reasoning.content;
      if (evt.usage) { st.usage.input = evt.usage.prompt_tokens || 0; st.usage.output = evt.usage.completion_tokens || 0; }
    } catch {}
  }
  return st;
}

function parseAccumulatedResponsesSSE(raw) {
  const st = { text: "", thinking: "", usage: { input: 0, output: 0 }, stopReason: null };
  let pendingEvent = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event: ")) { pendingEvent = line.slice(7).trim(); continue; }
    if (line.startsWith("data: ") && pendingEvent) {
      const evtName = pendingEvent; pendingEvent = null;
      try {
        const d = JSON.parse(line.slice(6));
        if (evtName === "response.reasoning_summary_text.delta" || evtName === "response.reasoning_text.delta") st.thinking += d.delta || "";
        if (evtName === "response.output_text.delta") st.text += d.delta || "";
        if (evtName === "response.completed") { const u = d.response?.usage || d.usage; if (u) { st.usage.input = u.input_tokens || 0; st.usage.output = u.output_tokens || 0; } }
        if (evtName === "response.incomplete") st.stopReason = "max_tokens";
      } catch {}
    }
  }
  return st;
}

function parseAccumulatedGeminiSSE(raw) {
  const st = { text: "", thinking: "", usage: { input: 0, output: 0 }, stopReason: null };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      const c = evt.candidates?.[0];
      if (c?.finishReason) st.stopReason = c.finishReason === "MAX_TOKENS" ? "max_tokens" : c.finishReason;
      if (c?.content?.parts) { for (const p of c.content.parts) { if (p.thought && p.text) st.thinking += p.text; else if (p.text) st.text += p.text; } }
      if (evt.usageMetadata) { st.usage.input = evt.usageMetadata.promptTokenCount || 0; st.usage.output = evt.usageMetadata.candidatesTokenCount || 0; }
    } catch {}
  }
  return st;
}

// ═══════════════════════════════════════════════════════════
// MIGRATION FROM SINGLE-USER
// ═══════════════════════════════════════════════════════════

function migrate() {
  if (loadUsers().length > 0) return; // Already migrated

  let username = null, passwordHash = null;

  // Read legacy credentials
  if (existsSync(LEGACY_CREDS)) {
    try { const c = JSON.parse(readFileSync(LEGACY_CREDS, "utf8")); username = c.username; passwordHash = c.passwordHash; } catch {}
  }
  if (!passwordHash && existsSync(LEGACY_HASH)) {
    passwordHash = readFileSync(LEGACY_HASH, "utf8").trim();
  }

  if (!passwordHash) return; // No legacy data to migrate

  // Create admin user
  const adminId = crypto.randomBytes(8).toString("hex");
  const admin = { id: adminId, username: username || "admin", role: "admin", passwordHash, createdAt: Date.now() };
  saveUsers([admin]);
  console.log(`✓  Migrated legacy user "${admin.username}" as admin (id: ${adminId})`);

  // Move state
  if (existsSync(LEGACY_STATE)) {
    const dir = userDataDir(adminId);
    try {
      const state = readFileSync(LEGACY_STATE, "utf8");
      writeFileSync(join(dir, "state.json"), state, "utf8");
      console.log(`✓  Migrated sessions to admin account`);
    } catch (e) { console.error("Migration: state failed:", e.message); }
  }

  // Move API keys
  if (existsSync(LEGACY_KEYS)) {
    const dir = userDataDir(adminId);
    try {
      const keys = readFileSync(LEGACY_KEYS, "utf8");
      writeFileSync(join(dir, "apikeys.json"), keys, { mode: 0o600 });
      console.log(`✓  Migrated API keys to admin account`);
    } catch (e) { console.error("Migration: keys failed:", e.message); }
  }
}

migrate();

// ═══════════════════════════════════════════════════════════
// EXPRESS SETUP
// ═══════════════════════════════════════════════════════════

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);
app.use(compression({ filter: (req, res) => (req.path.startsWith("/api/proxy") || req.path.includes("/stream") || req.path === "/api/codex/send") ? false : compression.filter(req, res) }));
app.use(express.json({ limit: "50mb" }));

// IP Allowlist
const ALLOWED_IPS = (process.env.ALLOWED_IPS || "127.0.0.1,::1,::ffff:127.0.0.1")
  .split(",").map(s => s.trim()).filter(Boolean);
// IP allowlist: checks direct TCP peer (not X-Forwarded-For) to gate which
// infrastructure hosts can reach the app — intended to allow only the reverse proxy
app.use((req, res, next) => {
  const raw = req.socket.remoteAddress || "";
  const norm = raw.replace(/^::ffff:/, "");
  if (ALLOWED_IPS.includes("*") || ALLOWED_IPS.includes(raw) || ALLOWED_IPS.includes(norm)) return next();
  console.warn(`Blocked connection from ${raw} (${norm})`);
  res.status(403).send("Forbidden");
});

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'");
  if (TRUST_PROXY) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

const sessionStore = new session.MemoryStore();
app.use(session({
  store: sessionStore,
  secret: getSessionSecret(), resave: false, saveUninitialized: false, name: "sf.sid",
  cookie: { maxAge: SESSION_MAX_AGE, httpOnly: true, secure: TRUST_PROXY, sameSite: "lax" },
}));
// Prune expired sessions every 15 minutes to prevent memory leak
setInterval(() => { sessionStore.all?.((err, sessions) => { if (err || !sessions) return; /* MemoryStore auto-expires, but touching .all triggers internal cleanup */ }); }, 15 * 60 * 1000).unref();

// CSRF protection: verify Origin header on state-changing requests
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next(); // Non-browser clients (curl, etc.) don't send Origin
  try { const host = new URL(origin).host; if (host === req.headers.host) return next(); } catch {}
  console.warn(`CSRF blocked: origin=${origin} host=${req.headers.host}`);
  return res.status(403).json({ error: "Cross-origin request blocked" });
});

// ═══════════════════════════════════════════════════════════
// LOGIN PAGE
// ═══════════════════════════════════════════════════════════

// placeholder — was crashing on fresh install when users.json doesn't exist
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TracyHill RP — Login</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:wght@400;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}body{height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;font-family:'DM Sans',sans-serif}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;max-width:400px;width:100%}
h1{font-family:'JetBrains Mono',monospace;font-size:22px;margin-bottom:6px}h1 span{color:#3fb950}
p{color:#8b949e;font-size:13px;margin-bottom:24px;line-height:1.5}
input{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;color:#e6edf3;font-family:'JetBrains Mono',monospace;font-size:14px;margin-bottom:12px}
input:focus{outline:none;border-color:#58a6ff}
button{width:100%;padding:12px;background:#58a6ff;border:none;color:#fff;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;margin-top:4px}
button:disabled{opacity:.5;cursor:not-allowed}.error{color:#f85149;font-size:12px;margin-bottom:12px;font-family:'JetBrains Mono',monospace}
.warn{color:#d29922;font-size:12px;margin-top:12px;font-family:'JetBrains Mono',monospace;line-height:1.5}
.logo{display:block;margin:0 auto 16px;width:160px}
</style></head><body><div class="card">
<img class="logo" src="data:image/png;base64,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" alt="TracyHill RP"/><p>Authenticate to continue.</p>
<div id="error" class="error" style="display:none"></div>
<div id="step-login"><form id="form"><input type="text" id="user" placeholder="Username" autofocus autocomplete="username"/>
<input type="password" id="pw" placeholder="Password" autocomplete="current-password"/>
<button type="submit" id="btn">Unlock</button>
<div style="text-align:center;margin-top:12px"><a href="#" id="forgot-link" style="color:#58a6ff;font-size:12px;text-decoration:none;font-family:'JetBrains Mono',monospace">Forgot password?</a></div></form></div>
<div id="step-mfa" style="display:none"><p id="mfa-msg" style="margin-bottom:16px;color:#8b949e;font-size:13px"></p>
<div style="display:flex;gap:8px;justify-content:center;margin-bottom:16px"><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="one-time-code" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/></div>
<label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;cursor:pointer;font-size:13px;color:#8b949e"><input type="checkbox" id="trust-device" style="width:auto;margin:0;accent-color:#58a6ff"/> Trust this device</label>
<button id="verify-btn" style="width:100%;padding:12px;background:#58a6ff;border:none;color:#fff;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif">Verify</button>
<div style="text-align:center;margin-top:12px"><a href="#" id="resend-link" style="color:#58a6ff;font-size:12px;text-decoration:none;font-family:'JetBrains Mono',monospace">Resend code</a></div></div>
<div id="step-forgot" style="display:none"><p style="margin-bottom:16px;color:#8b949e;font-size:13px">Enter your username to reset your password.</p>
<input type="text" id="forgot-user" placeholder="Username" autocomplete="username" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;color:#e6edf3;font-family:'JetBrains Mono',monospace;font-size:14px;margin-bottom:12px"/>
<button id="forgot-btn" style="width:100%;padding:12px;background:#58a6ff;border:none;color:#fff;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;margin-top:4px">Send Reset Code</button>
<div style="text-align:center;margin-top:12px"><a href="#" id="forgot-back" style="color:#8b949e;font-size:12px;text-decoration:none;font-family:'JetBrains Mono',monospace">Back to login</a></div></div>
<div id="step-forgot-code" style="display:none"><p id="forgot-code-msg" style="margin-bottom:16px;color:#8b949e;font-size:13px"></p>
<div style="display:flex;gap:8px;justify-content:center;margin-bottom:16px"><input class="reset-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="reset-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="reset-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="reset-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="reset-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/><input class="reset-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" style="width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace"/></div>
<button id="forgot-verify-btn" style="width:100%;padding:12px;background:#58a6ff;border:none;color:#fff;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif">Verify</button>
<div style="text-align:center;margin-top:12px"><a href="#" id="forgot-resend" style="color:#58a6ff;font-size:12px;text-decoration:none;font-family:'JetBrains Mono',monospace">Resend code</a></div></div>
<div id="step-new-pw" style="display:none"><p style="margin-bottom:16px;color:#8b949e;font-size:13px">Choose a new password.</p>
<input type="password" id="new-pw" placeholder="New password (min 8 characters)" autocomplete="new-password" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;color:#e6edf3;font-family:'JetBrains Mono',monospace;font-size:14px;margin-bottom:12px"/>
<input type="password" id="new-pw2" placeholder="Confirm password" autocomplete="new-password" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;color:#e6edf3;font-family:'JetBrains Mono',monospace;font-size:14px;margin-bottom:12px"/>
<button id="reset-pw-btn" style="width:100%;padding:12px;background:#3fb950;border:none;color:#fff;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif">Reset Password</button></div>
<div id="warn" class="warn" style="display:none"></div>
<div id="register-link" style="text-align:center;margin-top:16px;display:none"><span style="color:#8b949e;font-size:13px">Don't have an account? </span><a href="/register" style="color:#58a6ff;font-size:13px;text-decoration:none;font-family:'JetBrains Mono',monospace">Create one</a></div></div>
<script>
const form=document.getElementById('form'),user=document.getElementById('user'),pw=document.getElementById('pw'),btn=document.getElementById('btn'),err=document.getElementById('error'),warn=document.getElementById('warn');
const stepLogin=document.getElementById('step-login'),stepMfa=document.getElementById('step-mfa'),stepForgot=document.getElementById('step-forgot'),stepForgotCode=document.getElementById('step-forgot-code'),stepNewPw=document.getElementById('step-new-pw');
const digits=document.querySelectorAll('.mfa-digit'),verifyBtn=document.getElementById('verify-btn'),trustCb=document.getElementById('trust-device'),resendLink=document.getElementById('resend-link'),mfaMsg=document.getElementById('mfa-msg');
// [SMS REMOVED] const altMethodLink=document.getElementById('alt-method-link'),altSep=document.getElementById('alt-sep');
const forgotLink=document.getElementById('forgot-link'),forgotUser=document.getElementById('forgot-user'),forgotBtn=document.getElementById('forgot-btn'),forgotBack=document.getElementById('forgot-back');
const forgotCodeMsg=document.getElementById('forgot-code-msg'),forgotVerifyBtn=document.getElementById('forgot-verify-btn'),forgotResend=document.getElementById('forgot-resend');
// [SMS REMOVED] const forgotAltMethod=document.getElementById('forgot-alt-method'),forgotAltSep=document.getElementById('forgot-alt-sep');
const resetDigits=document.querySelectorAll('.reset-digit'),newPw=document.getElementById('new-pw'),newPw2=document.getElementById('new-pw2'),resetPwBtn=document.getElementById('reset-pw-btn');
let mfaToken=null,mfaMethod=null,mfaEmailMasked=null; // [SMS REMOVED] mfaPhoneLast4, mfaHasAlt
let resetToken=null,resetMethod=null; // [SMS REMOVED] resetHasAlt
function showError(msg){err.textContent=msg;err.style.display='block';}
function hideError(){err.style.display='none';}
function showStep(step){for(const s of [stepLogin,stepMfa,stepForgot,stepForgotCode,stepNewPw])s.style.display='none';({login:stepLogin,mfa:stepMfa,forgot:stepForgot,forgotCode:stepForgotCode,newPw:stepNewPw})[step].style.display='block';}
function getCode(digs){return Array.from(digs).map(d=>d.value).join('');}
function clearDigs(digs){digs.forEach(d=>{d.value='';});digs[0].focus();}
function setupDigits(digs){digs.forEach((d,i)=>{d.addEventListener('input',()=>{if(d.value.length===1&&i<digs.length-1)digs[i+1].focus();});d.addEventListener('keydown',(e)=>{if(e.key==='Backspace'&&!d.value&&i>0){digs[i-1].focus();digs[i-1].value='';}});});
digs[0].addEventListener('paste',(e)=>{e.preventDefault();const t=(e.clipboardData||window.clipboardData).getData('text').replace(/\\D/g,'').slice(0,6);t.split('').forEach((c,i)=>{if(digs[i])digs[i].value=c;});if(t.length>0)digs[Math.min(t.length-1,5)].focus();});}
setupDigits(digits);setupDigits(resetDigits);
function mfaDest(){return mfaEmailMasked;} // [SMS REMOVED] was: mfaMethod==='sms'?mfaPhoneLast4:mfaEmailMasked
fetch('/api/session').then(r=>r.json()).then(d=>{if(d.needsSetup){warn.style.display='block';warn.textContent='No users configured. Run: docker exec -it tracyhill-rp node set-password.js';btn.disabled=true;user.disabled=true;pw.disabled=true;}if(d.registrationEnabled){document.getElementById('register-link').style.display='block';}});
// Login
form.addEventListener('submit',async(e)=>{e.preventDefault();hideError();btn.disabled=true;btn.textContent='Authenticating...';
try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.value,password:pw.value})});
const d=await r.json();
if(d.ok){window.location.reload();return;}
if(d.mfaRequired){mfaToken=d.mfaSessionToken;mfaMethod=d.method;mfaEmailMasked=d.emailMasked;if(d.codeSent===false){mfaMsg.textContent='Unable to send verification code. Try resending below.';showError('Code could not be sent. You may be sending too frequently.');}else{hideError();mfaMsg.textContent='Enter the 6-digit code sent to '+mfaDest();}showStep('mfa');clearDigs(digits);btn.disabled=false;btn.textContent='Unlock';return;}
err.textContent=d.error||'Invalid credentials';err.style.display='block';if(d.remaining!==undefined)err.textContent+='. '+d.remaining+' attempts remaining.';if(d.lockedFor)err.textContent='Locked out. Try again in '+Math.ceil(d.lockedFor/60)+' minutes.';}
catch(ex){showError('Connection failed');}btn.disabled=false;btn.textContent='Unlock';});
// MFA verify
verifyBtn.addEventListener('click',async()=>{hideError();const code=getCode(digits);if(code.length!==6){showError('Enter all 6 digits');return;}verifyBtn.disabled=true;verifyBtn.textContent='Verifying...';
try{const r=await fetch('/api/mfa/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mfaSessionToken:mfaToken,code,trustDevice:trustCb.checked})});
const d=await r.json();if(d.ok){window.location.reload();return;}
if(d.expired){showStep('login');showError(d.error);verifyBtn.disabled=false;verifyBtn.textContent='Verify';return;}
showError(d.error+(d.remaining!==undefined?' '+d.remaining+' attempts remaining.':''));clearDigs(digits);}
catch(ex){showError('Connection failed');}verifyBtn.disabled=false;verifyBtn.textContent='Verify';});
// MFA resend
resendLink.addEventListener('click',async(e)=>{e.preventDefault();hideError();resendLink.textContent='Sending...';
try{const r=await fetch('/api/mfa/send-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mfaSessionToken:mfaToken})});
const d=await r.json();if(d.expired){showStep('login');showError(d.error);return;}
if(d.ok){mfaMsg.textContent='New code sent. Check your email.';clearDigs(digits);}else{showError(d.error);}}
catch(ex){showError('Connection failed');}resendLink.textContent='Resend code';});
// [SMS REMOVED] MFA try another way handler removed
// Forgot password
forgotLink.addEventListener('click',(e)=>{e.preventDefault();hideError();forgotUser.value=user.value;showStep('forgot');});
forgotBack.addEventListener('click',(e)=>{e.preventDefault();hideError();showStep('login');});
forgotBtn.addEventListener('click',async()=>{hideError();if(!forgotUser.value.trim()){showError('Enter your username');return;}forgotBtn.disabled=true;forgotBtn.textContent='Sending...';
try{const r=await fetch('/api/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:forgotUser.value.trim()})});
const d=await r.json();if(d.resetToken){resetToken=d.resetToken;resetMethod=d.method;forgotCodeMsg.textContent='Enter the 6-digit code sent to '+d.emailMasked;showStep('forgotCode');clearDigs(resetDigits);}else if(d.ok){showError('If the account exists, a code has been sent. Check your email.');}else{showError(d.error);}}
catch(ex){showError('Connection failed');}forgotBtn.disabled=false;forgotBtn.textContent='Send Reset Code';});
// Forgot verify code
forgotVerifyBtn.addEventListener('click',async()=>{hideError();const code=getCode(resetDigits);if(code.length!==6){showError('Enter all 6 digits');return;}forgotVerifyBtn.disabled=true;forgotVerifyBtn.textContent='Verifying...';
try{const r=await fetch('/api/forgot-password/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resetToken,code})});
const d=await r.json();if(d.ok){showStep('newPw');hideError();}
else if(d.expired){showStep('forgot');showError(d.error);}
else{showError(d.error+(d.remaining!==undefined?' '+d.remaining+' attempts remaining.':''));clearDigs(resetDigits);}}
catch(ex){showError('Connection failed');}forgotVerifyBtn.disabled=false;forgotVerifyBtn.textContent='Verify';});
// Forgot resend
forgotResend.addEventListener('click',async(e)=>{e.preventDefault();hideError();forgotResend.textContent='Sending...';
try{const r=await fetch('/api/forgot-password/send-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resetToken})});
const d=await r.json();if(d.ok){forgotCodeMsg.textContent='New code sent. Check your email.';clearDigs(resetDigits);}else{showError(d.error);}}
catch(ex){showError('Connection failed');}forgotResend.textContent='Resend code';});
// [SMS REMOVED] Forgot try another way handler removed
// Set new password
resetPwBtn.addEventListener('click',async()=>{hideError();if(newPw.value!==newPw2.value){showError("Passwords don't match");return;}resetPwBtn.disabled=true;resetPwBtn.textContent='Resetting...';
try{const r=await fetch('/api/forgot-password/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resetToken,newPassword:newPw.value})});
const d=await r.json();if(d.ok){showStep('login');hideError();warn.style.display='block';warn.textContent='Password reset successful. You can now log in.';warn.style.color='#3fb950';}
else if(d.expired){showStep('forgot');showError(d.error);}
else{showError(d.error);}}
catch(ex){showError('Connection failed');}resetPwBtn.disabled=false;resetPwBtn.textContent='Reset Password';});
</script></body></html>`;

// Inject logo into login page
function getLoginHtml() { return LOGIN_HTML; }

// Registration page — same theme as login
function getRegisterHtml() {
return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TracyHill RP — Create Account</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:wght@400;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}body{height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;font-family:'DM Sans',sans-serif}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;max-width:400px;width:100%}
h1{font-family:'JetBrains Mono',monospace;font-size:22px;margin-bottom:6px}h1 span{color:#3fb950}
p{color:#8b949e;font-size:13px;margin-bottom:24px;line-height:1.5}
input[type="text"],input[type="email"],input[type="password"]{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;color:#e6edf3;font-family:'JetBrains Mono',monospace;font-size:14px;margin-bottom:12px}
input:focus{outline:none;border-color:#58a6ff}
button{width:100%;padding:12px;background:#58a6ff;border:none;color:#fff;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif;margin-top:4px}
button:disabled{opacity:.5;cursor:not-allowed}
.error{color:#f85149;font-size:12px;margin-bottom:12px;font-family:'JetBrains Mono',monospace}
.terms-check{display:flex;align-items:flex-start;gap:10px;margin:12px 0 4px;font-size:13px;color:#8b949e;cursor:pointer;line-height:1.4}
.terms-check input{width:auto;margin:3px 0 0;accent-color:#58a6ff;flex-shrink:0}
.terms-check a{color:#58a6ff;text-decoration:none}
.terms-check a:hover{text-decoration:underline}
.mfa-digit{width:44px;height:52px;text-align:center;font-size:22px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-family:'JetBrains Mono',monospace}
.mfa-digit:focus{outline:none;border-color:#58a6ff}
.login-link{text-align:center;margin-top:16px}
.login-link span{color:#8b949e;font-size:13px}
.login-link a{color:#58a6ff;font-size:13px;text-decoration:none;font-family:'JetBrains Mono',monospace}
</style></head><body><div class="card">
<h1>Create <span>Account</span></h1>
<p>Join TracyHill RP</p>
<div id="error" class="error" style="display:none"></div>
<div id="step-form">
<input type="text" id="reg-user" placeholder="Username" autofocus autocomplete="username"/>
<input type="email" id="reg-email" placeholder="Email address" autocomplete="email"/>
<input type="password" id="reg-pw" placeholder="Password (min 8 characters)" autocomplete="new-password"/>
<input type="password" id="reg-pw2" placeholder="Confirm password" autocomplete="new-password"/>
<label class="terms-check"><input type="checkbox" id="reg-terms"/>I agree to the <a href="/terms" target="_blank">Terms of Service</a> and <a href="/privacy" target="_blank">Privacy Policy</a></label>
<button id="reg-btn">Create Account</button>
</div>
<div id="step-verify" style="display:none">
<p id="verify-msg" style="margin-bottom:16px;color:#8b949e;font-size:13px"></p>
<div style="display:flex;gap:8px;justify-content:center;margin-bottom:16px"><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autocomplete="one-time-code"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]"/><input class="mfa-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]"/></div>
<button id="verify-btn">Verify Email</button>
<div style="text-align:center;margin-top:12px"><a href="#" id="resend-link" style="color:#58a6ff;font-size:12px;text-decoration:none;font-family:'JetBrains Mono',monospace">Resend code</a></div>
</div>
<div class="login-link"><span>Already have an account? </span><a href="/">Log in</a></div>
</div>
<script>
const err=document.getElementById('error'),stepForm=document.getElementById('step-form'),stepVerify=document.getElementById('step-verify');
const regUser=document.getElementById('reg-user'),regEmail=document.getElementById('reg-email'),regPw=document.getElementById('reg-pw'),regPw2=document.getElementById('reg-pw2'),regTerms=document.getElementById('reg-terms'),regBtn=document.getElementById('reg-btn');
const verifyMsg=document.getElementById('verify-msg'),verifyBtn=document.getElementById('verify-btn'),resendLink=document.getElementById('resend-link');
const digits=document.querySelectorAll('.mfa-digit');
let regToken=null;
function showError(msg){err.textContent=msg;err.style.display='block';}
function hideError(){err.style.display='none';}
function getCode(){return Array.from(digits).map(d=>d.value).join('');}
function clearDigits(){digits.forEach(d=>{d.value='';});digits[0].focus();}
digits.forEach((d,i)=>{d.addEventListener('input',()=>{if(d.value.length===1&&i<digits.length-1)digits[i+1].focus();});d.addEventListener('keydown',(e)=>{if(e.key==='Backspace'&&!d.value&&i>0){digits[i-1].focus();digits[i-1].value='';}});});
digits[0].addEventListener('paste',(e)=>{e.preventDefault();const t=(e.clipboardData||window.clipboardData).getData('text').replace(/\\D/g,'').slice(0,6);t.split('').forEach((c,i)=>{if(digits[i])digits[i].value=c;});if(t.length>0)digits[Math.min(t.length-1,5)].focus();});
regBtn.addEventListener('click',async()=>{hideError();
if(!regUser.value.trim()){showError('Username is required');return;}
if(!regEmail.value.trim()){showError('Email address is required');return;}
if(regPw.value!==regPw2.value){showError('Passwords don\\'t match');return;}
if(!regTerms.checked){showError('You must agree to the Terms of Service');return;}
regBtn.disabled=true;regBtn.textContent='Creating...';
try{const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:regUser.value.trim(),email:regEmail.value.trim(),password:regPw.value,agreedToTerms:true})});
const d=await r.json();if(d.ok){regToken=d.regToken;verifyMsg.textContent='Enter the 6-digit code sent to '+d.emailMasked;stepForm.style.display='none';stepVerify.style.display='block';hideError();clearDigits();}
else{showError(d.error||'Registration failed');}}catch(ex){showError('Connection failed');}regBtn.disabled=false;regBtn.textContent='Create Account';});
verifyBtn.addEventListener('click',async()=>{hideError();const code=getCode();if(code.length!==6){showError('Enter all 6 digits');return;}verifyBtn.disabled=true;verifyBtn.textContent='Verifying...';
try{const r=await fetch('/api/register/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({regToken,code})});
const d=await r.json();if(d.ok){window.location.href='/';}
else if(d.expired){stepVerify.style.display='none';stepForm.style.display='block';showError(d.error);}
else{showError(d.error+(d.remaining!==undefined?' '+d.remaining+' attempts remaining.':''));clearDigits();}}
catch(ex){showError('Connection failed');}verifyBtn.disabled=false;verifyBtn.textContent='Verify Email';});
resendLink.addEventListener('click',async(e)=>{e.preventDefault();hideError();resendLink.textContent='Sending...';
try{const r=await fetch('/api/register/resend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({regToken})});
const d=await r.json();if(d.expired){stepVerify.style.display='none';stepForm.style.display='block';showError(d.error);}
else if(d.ok){verifyMsg.textContent='New code sent. Check your email.';clearDigits();}else{showError(d.error);}}
catch(ex){showError('Connection failed');}resendLink.textContent='Resend code';});
</script></body></html>`;
}

// ═══════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  const user = findUserById(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: "User no longer exists" }); }
  // Refresh role from DB in case it changed
  req.session.role = user.role;
  return next();
}
function requireAdmin(req, res, next) {
  if (req.session?.role === "admin") return next();
  return res.status(403).json({ error: "Admin access required" });
}

// ═══════════════════════════════════════════════════════════
// CAMPAIGN & PIPELINE ROUTES (mounted from separate modules)
// ═══════════════════════════════════════════════════════════

app.use("/api/campaigns", campaignRoutes);
// Multi-model routes checked first — fall through to Anthropic handlers for claude-* models
app.use("/api/pipeline", pipelineMultiRoutes);
app.use("/api/wizard", wizardMultiRoutes);
// Frozen Anthropic-only handlers (pipeline.js, wizard.js — untouched)
app.use("/api/pipeline", pipelineRoutes);
app.use("/api/wizard", wizardRoutes);
app.use("/api/sessions", sessionRoutes);

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════

app.get("/api/session", (req, res) => {
  const users = loadUsers();
  const result = {
    authenticated: !!req.session?.userId,
    needsSetup: users.length === 0,
    user: req.session?.userId ? { id: req.session.userId, username: req.session.username, role: req.session.role } : null,
    mfaEnabled: isMfaEnabled(),
    registrationEnabled: isRegistrationEnabled(),
  };
  if (req.session?.userId) {
    const user = findUserById(req.session.userId);
    // [SMS REMOVED] if (user) { result.user.mfaPhone = !!user.mfaPhone && !!user.mfaPhoneVerified; }
  }
  res.json(result);
});

app.post("/api/login", async (req, res) => {
  const clientIp = req.ip || "unknown"; // Real client IP via trust proxy (socket.remoteAddress is always the reverse proxy)
  const rl = checkRateLimit(clientIp);
  if (rl.blocked) return res.status(429).json({ error: "Too many failed attempts", lockedFor: rl.remainSec });

  const users = loadUsers();
  if (users.length === 0) return res.status(503).json({ error: "No users configured." });

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });

  // Per-username rate limit (prevents distributed brute-force from many IPs)
  const userKey = `user:${(username || "").toLowerCase()}`;
  const urlRl = checkRateLimit(userKey);
  if (urlRl.blocked) return res.status(429).json({ error: "Too many failed attempts", lockedFor: urlRl.remainSec });

  try {
    const user = findUser(username);
    // Always run bcrypt.compare to prevent timing-based username enumeration
    const pMatch = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);

    if (user && pMatch) {
      clearFailures(clientIp, userKey);

      // MFA check — require MFA if configured and user has at least one verification method
      const hasAnyMfaMethod = !!user.email; // [SMS REMOVED] was: (user.mfaPhone && user.mfaPhoneVerified) || !!user.email
      if (isMfaEnabled() && hasAnyMfaMethod) {
        // Check for trusted device cookie
        const trustToken = parseTrustToken(req);
        if (trustToken && checkTrustedDevice(user, trustToken)) {
          // Trusted device — skip MFA, grant session directly (lastUsed persisted by checkTrustedDevice)
          return req.session.regenerate((err) => {
            if (err) return res.status(500).json({ error: "Authentication error" });
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;
            console.log(`Login success (trusted device): ${user.username} from ${clientIp}`);
            return res.json({ ok: true });
          });
        }
        // No valid trust token — initiate MFA challenge
        try {
          const challenge = await createMfaChallenge(user, req);
          console.log(`MFA challenge issued: ${user.username} from ${clientIp} (method: ${challenge.method})`);
          return res.json({ mfaRequired: true, ...challenge });
        } catch (e) {
          console.error("MFA challenge error:", e.message);
          return res.status(500).json({ error: "MFA service error. Try again." });
        }
      }

      // No MFA configured — original direct login
      // Regenerate session to prevent session fixation attacks
      return req.session.regenerate((err) => {
        if (err) { console.error("Session regeneration failed:", err); return res.status(500).json({ error: "Authentication error" }); }
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        console.log(`Login success: ${user.username} (${user.role}) from ${clientIp}`);
        return res.json({ ok: true });
      });
    }

    const delay = recordFailure(clientIp); recordFailure(userKey);
    const entry = failureMap.get(clientIp);
    console.warn(`Login failed for ${username} from ${clientIp} (${entry.count}/${MAX_FAILURES})`);
    await new Promise(r => setTimeout(r, delay));
    return res.status(401).json({ error: "Invalid credentials", remaining: Math.max(0, MAX_FAILURES - entry.count) });
  } catch (e) { console.error("Login error:", e); return res.status(500).json({ error: "Authentication error" }); }
});

app.post("/api/logout", (req, res) => { req.session.destroy(() => { res.clearCookie("sf.sid"); res.clearCookie("sf.trust", { path: "/", httpOnly: true, sameSite: "lax" }); res.json({ ok: true }); }); });

// ═══════════════════════════════════════════════════════════
// MFA ROUTES
// ═══════════════════════════════════════════════════════════

app.post("/api/mfa/send-code", handleSendCode);
app.post("/api/mfa/verify", handleVerify);
// [SMS REMOVED] app.post("/api/mfa/enroll", handleEnroll);
// [SMS REMOVED] app.post("/api/mfa/enroll/verify", handleEnrollVerify);
app.get("/api/account/mfa", requireAuth, handleGetMfaStatus);
app.delete("/api/account/mfa/trusted-devices/:token", requireAuth, handleRevokeDevice);
app.delete("/api/account/mfa/trusted-devices", requireAuth, handleRevokeAllDevices);
// [SMS REMOVED] app.post("/api/account/mfa/update-phone", requireAuth, handleUpdatePhone);
// [SMS REMOVED] app.post("/api/account/mfa/update-phone/verify", requireAuth, handleUpdatePhoneVerify);
app.post("/api/account/delete-request", requireAuth, handleDeleteRequest);
app.post("/api/account/delete-request/send-code", requireAuth, handleDeleteSendCode);
app.post("/api/account/delete-confirm", requireAuth, handleDeleteConfirm);
app.delete("/api/account/delete-execute", requireAuth, handleDeleteExecute);

// ═══════════════════════════════════════════════════════════
// FORGOT PASSWORD ROUTES (no auth required)
// ═══════════════════════════════════════════════════════════

app.post("/api/forgot-password", handleForgotPassword);
app.post("/api/forgot-password/send-code", handleForgotPasswordSendCode);
app.post("/api/forgot-password/verify", handleForgotPasswordVerify);
app.post("/api/forgot-password/reset", handleForgotPasswordReset);

// ═══════════════════════════════════════════════════════════
// USER DATA ROUTES (scoped to logged-in user)
// ═══════════════════════════════════════════════════════════

app.get("/api/pending", requireAuth, (req, res) => {
  try {
    const pending = loadPending(req.session.userId);
    const sids = Object.keys(pending);
    if (sids.length > 0) clearPendingFiles(req.session.userId, sids);
    res.json(pending);
  } catch { res.json({}); }
});

app.get("/api/state", requireAuth, (req, res) => {
  if (isMigrated(req.session.userId)) return res.status(410).json({ error: "Migrated to per-session storage. Use /api/sessions endpoints." });
  try { const s = loadUserState(req.session.userId); res.json(s); } catch { res.json(null); }
});
app.put("/api/state", requireAuth, (req, res) => {
  if (isMigrated(req.session.userId)) return res.status(410).json({ error: "Migrated to per-session storage. Use /api/sessions endpoints." });
  try {
    const incoming = req.body;
    const incomingSessions = Object.keys(incoming.sessions || {}).length;
    if (incomingSessions === 0) {
      const existing = loadUserState(req.session.userId);
      if (Object.keys(existing.sessions || {}).length > 0) return res.status(409).json({ error: "Rejected: empty state over existing data" });
    }
    const sz = saveUserState(req.session.userId, incoming); res.json({ ok: true, sizeMB: sz });
  } catch (e) { console.error("State save error:", e.message); res.status(500).json({ error: "Save failed" }); }
});

app.get("/api/keys", requireAuth, (req, res) => {
  const keys = loadUserKeys(req.session.userId);
  res.json({ anthropic: !!keys.anthropic, xai: !!keys.xai, openai: !!keys.openai, deepseek: !!keys.deepseek, zai: !!keys.zai, google: !!keys.google, customEndpoints: (keys.customEndpoints || []).map(ep => ({ id: ep.id, name: ep.name, baseUrl: ep.baseUrl, apiFormat: ep.apiFormat || "chat-completions", authHeader: ep.authHeader || "Bearer", models: ep.models || [], hasKey: !!ep.apiKey })) });
});
app.put("/api/keys", requireAuth, (req, res) => {
  const current = loadUserKeys(req.session.userId);
  const { anthropic, xai, openai, deepseek, zai, google, customEndpoints } = req.body || {};
  if (anthropic !== undefined) current.anthropic = (typeof anthropic === "string" ? anthropic : "").trim();
  if (xai !== undefined) current.xai = (typeof xai === "string" ? xai : "").trim();
  if (openai !== undefined) current.openai = (typeof openai === "string" ? openai : "").trim();
  if (deepseek !== undefined) current.deepseek = (typeof deepseek === "string" ? deepseek : "").trim();
  if (zai !== undefined) current.zai = (typeof zai === "string" ? zai : "").trim();
  if (google !== undefined) current.google = (typeof google === "string" ? google : "").trim();
  if (customEndpoints !== undefined && Array.isArray(customEndpoints)) {
    // Validate and sanitize custom endpoints
    const existingEps = current.customEndpoints || [];
    current.customEndpoints = customEndpoints.slice(0, 20).map(ep => {
      const epId = (typeof ep.id === "string" && /^ep_[a-f0-9]{6,12}$/.test(ep.id)) ? ep.id : "ep_" + crypto.randomBytes(4).toString("hex");
      const existing = existingEps.find(e => e.id === epId);
      // If apiKey not provided (undefined/null in JSON), keep existing key
      const apiKey = typeof ep.apiKey === "string" ? ep.apiKey.slice(0, 512) : (existing?.apiKey || "");
      return {
        id: epId,
        name: (typeof ep.name === "string" ? ep.name : "Custom").slice(0, 64),
        baseUrl: (typeof ep.baseUrl === "string" ? ep.baseUrl : "https://api.openai.com/v1").slice(0, 512),
        apiKey,
        apiFormat: ["chat-completions", "responses"].includes(ep.apiFormat) ? ep.apiFormat : "chat-completions",
        authHeader: ["Bearer", "api-key", "none"].includes(ep.authHeader) ? ep.authHeader : "Bearer",
        models: (Array.isArray(ep.models) ? ep.models : []).slice(0, 50).map(m => ({
          id: (typeof m.id === "string" ? m.id : "").slice(0, 128),
          label: (typeof m.label === "string" ? m.label : m.id || "Model").slice(0, 128),
          maxOut: Math.min(Math.max(parseInt(m.maxOut) || 4096, 1), 2097152),
          ctx: Math.min(Math.max(parseInt(m.ctx) || 128000, 1), 10000000)
        })).filter(m => m.id)
      };
    }).filter(ep => ep.name && ep.baseUrl);
  }
  saveUserKeys(req.session.userId, current);
  res.json({ ok: true, anthropic: !!current.anthropic, xai: !!current.xai, openai: !!current.openai, deepseek: !!current.deepseek, zai: !!current.zai, google: !!current.google, customEndpoints: (current.customEndpoints || []).map(ep => ({ id: ep.id, name: ep.name, baseUrl: ep.baseUrl, apiFormat: ep.apiFormat, authHeader: ep.authHeader, models: ep.models, hasKey: !!ep.apiKey })) });
});

// ═══════════════════════════════════════════════════════════
// STREAMING PROXY (uses logged-in user's keys, accumulates for browser-disconnect recovery)
// ═══════════════════════════════════════════════════════════

function streamingProxy(req, res, { hostname, path, headers, body, label, parseFn }) {
  const userId = req.session.userId;
  if (!acquireProxy(userId)) return res.status(429).json({ error: "Too many concurrent requests" });
  const sessionId = req.headers["x-session-id"] || null;
  const modelId = req.headers["x-model-id"] || null;
  const msgIndex = parseInt(req.headers["x-msg-count"], 10) || 0; // expected message count after assistant reply is appended
  let browserGone = false, proxyReleased = false;
  const releaseOnce = () => { if (!proxyReleased) { proxyReleased = true; releaseProxy(userId); } };
  const chunks = [];

  console.log(`${label} proxy: connecting to ${hostname}${path}...`);
  const proxyReq = https.request({ hostname, port: 443, path, method: "POST", headers }, (proxyRes) => {
    console.log(`${label} proxy: upstream responded ${proxyRes.statusCode}`);
    if (proxyRes.statusCode !== 200) {
      // Non-streaming error — pipe directly
      if (!browserGone) { res.writeHead(proxyRes.statusCode, { "Content-Type": proxyRes.headers["content-type"] || "application/json" }); proxyRes.pipe(res).on("error", () => {}); }
      else proxyRes.resume();
      proxyRes.on("end", releaseOnce); proxyRes.on("error", releaseOnce);
      return;
    }
    if (!browserGone) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no", "Transfer-Encoding": "chunked" });
    proxyRes.on("data", (chunk) => {
      chunks.push(chunk);
      if (!browserGone) try { res.write(chunk); } catch {}
    });
    proxyRes.on("end", () => {
      releaseOnce();
      if (!browserGone) try { res.end(); } catch {}
      // Always save pending as safety net (reverse proxy may mask browser disconnect)
      if (sessionId && parseFn) {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const st = parseFn(raw);
          if (st.text || st.thinking) {
            const truncated = st.stopReason === "max_tokens";
            const msg = { role: "assistant", content: st.text || "*[Response contained only thinking]*", thinking: st.thinking || null, model: modelId, usage: st.usage || null, pendingRecovered: true, msgIndex };
            if (truncated && browserGone) msg.content += "\n\n---\n\n**⚠ Output truncated** — response completed server-side after browser disconnected.";
            else if (truncated) msg.content += "\n\n---\n\n**⚠ Output truncated** — hit the model's max output token limit.";
            if (browserGone && isMigrated(userId)) {
              // Browser disconnected — server takes ownership, write directly to session file
              try {
                const session = loadSession(userId, sessionId);
                if (session) {
                  const { msgIndex: _, pendingRecovered: __, ...cleanMsg } = msg;
                  session.messages.push(cleanMsg);
                  saveSession(userId, session);
                  updateSessionMeta(userId, sessionId, { messageCount: session.messages.length, lastActivity: Date.now() });
                  console.log(`Appended response to session ${sessionId} for user ${userId} (${(msg.content?.length || 0)} chars, browserGone=true)`);
                } else { savePending(userId, sessionId, msg); }
              } catch (e) { console.error("Direct session append error:", e.message); savePending(userId, sessionId, msg); }
            } else {
              // Browser connected — client will save the message via its own API call after stream completes
              // Still save pending as safety net (client may fail to save)
              savePending(userId, sessionId, msg);
              console.log(`Saved pending response for user ${userId}, session ${sessionId} (${(st.text?.length || 0)} chars, browserGone=${browserGone})`);
            }
          }
        } catch (e) { console.error("Pending save error:", e.message); }
      }
    });
    proxyRes.on("error", (e) => {
      releaseOnce();
      console.error(`${label} upstream error:`, e.message);
      if (!browserGone) try { res.end(); } catch {}
      // Save whatever was accumulated before the error
      if (sessionId && parseFn && chunks.length > 0) {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const st = parseFn(raw);
          if (st.text || st.thinking) {
            const msg = { role: "assistant", content: (st.text || "*[Response contained only thinking]*") + "\n\n---\n\n*[Stream interrupted: " + e.message + "]*", thinking: st.thinking || null, model: modelId, usage: st.usage || null, pendingRecovered: true, msgIndex };
            if (browserGone && isMigrated(userId)) {
              try {
                const session = loadSession(userId, sessionId);
                if (session) {
                  const { msgIndex: _, pendingRecovered: __, ...cleanMsg } = msg;
                  session.messages.push(cleanMsg);
                  saveSession(userId, session);
                  updateSessionMeta(userId, sessionId, { messageCount: session.messages.length, lastActivity: Date.now() });
                  console.log(`Appended partial response to session ${sessionId} for user ${userId} (${(msg.content?.length || 0)} chars, error: ${e.message})`);
                } else { savePending(userId, sessionId, msg); }
              } catch (e3) { console.error("Direct session append error (on upstream error):", e3.message); savePending(userId, sessionId, msg); }
            } else {
              savePending(userId, sessionId, msg);
              console.log(`Saved partial pending for user ${userId}, session ${sessionId} (${(st.text?.length || 0)} chars, error: ${e.message})`);
            }
          }
        } catch (e2) { console.error("Pending save error (on upstream error):", e2.message); }
      }
    });
  });
  proxyReq.on("error", (e) => { releaseOnce(); console.error(`${label} proxy error:`, e.message); if (!browserGone) { if (!res.headersSent) res.status(502).json({ error: "Proxy error" }); else try { res.end(); } catch {} } });
  proxyReq.setTimeout(300000, () => { proxyReq.destroy(new Error("Upstream timeout (5min)")); }); // 5 minute timeout
  req.on("close", () => { browserGone = true; }); // Do NOT destroy proxyReq — let it finish
  proxyReq.write(body); proxyReq.end();
}

app.post("/api/proxy/anthropic", requireAuth, (req, res) => {
  const keys = loadUserKeys(req.session.userId);
  if (!keys.anthropic) return res.status(400).json({ error: "No Anthropic API key configured. Add one in Settings." });
  if (!req.body?.model || !req.body?.messages) return res.status(400).json({ error: "Invalid request body" });
  const body = JSON.stringify(req.body);
  console.log(`Anthropic proxy: model=${req.body.model} msgs=${req.body.messages.length} bodySize=${Buffer.byteLength(body)} user=${req.session.userId}`);
  streamingProxy(req, res, { hostname: "api.anthropic.com", path: "/v1/messages", headers: { "Content-Type": "application/json", "x-api-key": keys.anthropic, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) }, body, label: "Anthropic", parseFn: parseAccumulatedAnthropicSSE });
});

app.post("/api/proxy/xai", requireAuth, (req, res) => {
  const keys = loadUserKeys(req.session.userId);
  if (!keys.xai) return res.status(400).json({ error: "No xAI API key configured. Add one in Settings." });
  if (!req.body?.model || !req.body?.messages) return res.status(400).json({ error: "Invalid request body" });
  const body = JSON.stringify(req.body);
  streamingProxy(req, res, { hostname: "api.x.ai", path: "/v1/chat/completions", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${keys.xai}`, "Content-Length": Buffer.byteLength(body) }, body, label: "xAI", parseFn: parseAccumulatedChatCompletionsSSE });
});

app.post("/api/proxy/openai", requireAuth, (req, res) => {
  const keys = loadUserKeys(req.session.userId);
  if (!keys.openai) return res.status(400).json({ error: "No OpenAI API key configured. Add one in Settings." });
  if (!req.body?.model || !req.body?.messages) return res.status(400).json({ error: "Invalid request body" });
  const body = JSON.stringify(req.body);
  streamingProxy(req, res, { hostname: "api.openai.com", path: "/v1/chat/completions", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${keys.openai}`, "Content-Length": Buffer.byteLength(body) }, body, label: "OpenAI", parseFn: parseAccumulatedChatCompletionsSSE });
});

app.post("/api/proxy/openai-responses", requireAuth, (req, res) => {
  const keys = loadUserKeys(req.session.userId);
  if (!keys.openai) return res.status(400).json({ error: "No OpenAI API key configured. Add one in Settings." });
  if (!req.body?.model || !req.body?.input) return res.status(400).json({ error: "Invalid request body" });
  const body = JSON.stringify(req.body);
  streamingProxy(req, res, { hostname: "api.openai.com", path: "/v1/responses", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${keys.openai}`, "Content-Length": Buffer.byteLength(body) }, body, label: "OpenAI Responses", parseFn: parseAccumulatedResponsesSSE });
});

app.post("/api/proxy/zai", requireAuth, (req, res) => {
  const keys = loadUserKeys(req.session.userId);
  if (!keys.zai) return res.status(400).json({ error: "No z.ai API key configured. Add one in Settings." });
  if (!req.body?.model || !req.body?.messages) return res.status(400).json({ error: "Invalid request body" });
  const body = JSON.stringify(req.body);
  streamingProxy(req, res, { hostname: "api.z.ai", path: "/api/paas/v4/chat/completions", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${keys.zai}`, "Content-Length": Buffer.byteLength(body) }, body, label: "z.ai", parseFn: parseAccumulatedChatCompletionsSSE });
});

app.post("/api/proxy/deepseek", requireAuth, (req, res) => {
  const keys = loadUserKeys(req.session.userId);
  if (!keys.deepseek) return res.status(400).json({ error: "No DeepSeek API key configured. Add one in Settings." });
  if (!req.body?.model || !req.body?.messages) return res.status(400).json({ error: "Invalid request body" });
  // Strip reasoning_content from assistant messages — DeepSeek returns 400 if present
  const cleaned = { ...req.body, messages: req.body.messages.map(m => m.role === "assistant" ? { role: m.role, content: m.content } : m) };
  const body = JSON.stringify(cleaned);
  streamingProxy(req, res, { hostname: "api.deepseek.com", path: "/chat/completions", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${keys.deepseek}`, "Content-Length": Buffer.byteLength(body) }, body, label: "DeepSeek", parseFn: parseAccumulatedChatCompletionsSSE });
});

app.post("/api/proxy/google", requireAuth, (req, res) => {
  const keys = loadUserKeys(req.session.userId);
  if (!keys.google) return res.status(400).json({ error: "No Google API key configured. Add one in Settings." });
  const model = req.body?.model;
  if (!model || !req.body?.contents) return res.status(400).json({ error: "Invalid request body" });
  const body = JSON.stringify(req.body);
  streamingProxy(req, res, { hostname: "generativelanguage.googleapis.com", path: `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, headers: { "Content-Type": "application/json", "x-goog-api-key": keys.google, "Content-Length": Buffer.byteLength(body) }, body, label: "Google", parseFn: parseAccumulatedGeminiSSE });
});

// ═══════════════════════════════════════════════════════════
// CUSTOM ENDPOINT PROXY (user-defined OpenAI-compatible APIs)
// ═══════════════════════════════════════════════════════════

function flexibleStreamingProxy(req, res, { hostname, port, protocol, path, headers, body, label, parseFn }) {
  const userId = req.session.userId;
  if (!acquireProxy(userId)) return res.status(429).json({ error: "Too many concurrent requests" });
  const sessionId = req.headers["x-session-id"] || null;
  const modelId = req.headers["x-model-id"] || null;
  const msgIndex = parseInt(req.headers["x-msg-count"], 10) || 0;
  let browserGone = false, proxyReleased = false;
  const releaseOnce = () => { if (!proxyReleased) { proxyReleased = true; releaseProxy(userId); } };
  const chunks = [];
  const mod = protocol === "http" ? http : https;

  console.log(`${label} proxy: connecting to ${protocol}://${hostname}:${port}${path}...`);
  const proxyReq = mod.request({ hostname, port, path, method: "POST", headers }, (proxyRes) => {
    console.log(`${label} proxy: upstream responded ${proxyRes.statusCode}`);
    if (proxyRes.statusCode !== 200) {
      if (!browserGone) { res.writeHead(proxyRes.statusCode, { "Content-Type": proxyRes.headers["content-type"] || "application/json" }); proxyRes.pipe(res).on("error", () => {}); }
      else proxyRes.resume();
      proxyRes.on("end", releaseOnce); proxyRes.on("error", releaseOnce);
      return;
    }
    if (!browserGone) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no", "Transfer-Encoding": "chunked" });
    proxyRes.on("data", (chunk) => { chunks.push(chunk); if (!browserGone) try { res.write(chunk); } catch {} });
    proxyRes.on("end", () => {
      releaseOnce();
      if (!browserGone) try { res.end(); } catch {}
      if (sessionId && parseFn) {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const st = parseFn(raw);
          if (st.text || st.thinking) {
            const truncated = st.stopReason === "max_tokens";
            const msg = { role: "assistant", content: st.text || "*[Response contained only thinking]*", thinking: st.thinking || null, model: modelId, usage: st.usage || null, pendingRecovered: true, msgIndex };
            if (truncated && browserGone) msg.content += "\n\n---\n\n**⚠ Output truncated** — response completed server-side after browser disconnected.";
            else if (truncated) msg.content += "\n\n---\n\n**⚠ Output truncated** — hit the model's max output token limit.";
            if (browserGone && isMigrated(userId)) {
              try {
                const session = loadSession(userId, sessionId);
                if (session) { const { msgIndex: _, pendingRecovered: __, ...cleanMsg } = msg; session.messages.push(cleanMsg); saveSession(userId, session); updateSessionMeta(userId, sessionId, { messageCount: session.messages.length, lastActivity: Date.now() }); console.log(`Appended response to session ${sessionId} for user ${userId} (${(msg.content?.length || 0)} chars, browserGone=true)`); }
                else { savePending(userId, sessionId, msg); }
              } catch (e) { console.error("Direct session append error:", e.message); savePending(userId, sessionId, msg); }
            } else { savePending(userId, sessionId, msg); console.log(`Saved pending response for user ${userId}, session ${sessionId} (${(st.text?.length || 0)} chars, browserGone=${browserGone})`); }
          }
        } catch (e) { console.error("Pending save error:", e.message); }
      }
    });
    proxyRes.on("error", (e) => {
      releaseOnce();
      console.error(`${label} upstream error:`, e.message);
      if (!browserGone) try { res.end(); } catch {}
      if (sessionId && parseFn && chunks.length > 0) {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const st = parseFn(raw);
          if (st.text || st.thinking) {
            const msg = { role: "assistant", content: (st.text || "*[Response contained only thinking]*") + "\n\n---\n\n*[Stream interrupted: " + e.message + "]*", thinking: st.thinking || null, model: modelId, usage: st.usage || null, pendingRecovered: true, msgIndex };
            if (browserGone && isMigrated(userId)) {
              try { const session = loadSession(userId, sessionId); if (session) { const { msgIndex: _, pendingRecovered: __, ...cleanMsg } = msg; session.messages.push(cleanMsg); saveSession(userId, session); updateSessionMeta(userId, sessionId, { messageCount: session.messages.length, lastActivity: Date.now() }); } else { savePending(userId, sessionId, msg); } }
              catch (e3) { console.error("Direct session append error (on upstream error):", e3.message); savePending(userId, sessionId, msg); }
            } else { savePending(userId, sessionId, msg); }
          }
        } catch (e2) { console.error("Pending save error (on upstream error):", e2.message); }
      }
    });
  });
  proxyReq.on("error", (e) => { releaseOnce(); console.error(`${label} proxy error:`, e.message); if (!browserGone) { if (!res.headersSent) res.status(502).json({ error: "Proxy error" }); else try { res.end(); } catch {} } });
  proxyReq.setTimeout(300000, () => { proxyReq.destroy(new Error("Upstream timeout (5min)")); });
  req.on("close", () => { browserGone = true; });
  proxyReq.write(body); proxyReq.end();
}

app.post("/api/proxy/custom", requireAuth, (req, res) => {
  const endpointId = req.headers["x-custom-endpoint-id"];
  if (!endpointId) return res.status(400).json({ error: "Missing X-Custom-Endpoint-Id header" });
  const keys = loadUserKeys(req.session.userId);
  const ep = (keys.customEndpoints || []).find(e => e.id === endpointId);
  if (!ep) return res.status(400).json({ error: "Custom endpoint not found" });
  const isResponses = ep.apiFormat === "responses";
  if (isResponses && (!req.body?.model || !req.body?.input)) return res.status(400).json({ error: "Invalid request body (responses format requires model + input)" });
  if (!isResponses && (!req.body?.model || !req.body?.messages)) return res.status(400).json({ error: "Invalid request body (chat-completions format requires model + messages)" });
  // Parse baseUrl
  let parsed;
  try { parsed = new URL(ep.baseUrl); } catch { return res.status(400).json({ error: "Invalid base URL configured for this endpoint" }); }
  const protocol = parsed.protocol === "http:" ? "http" : "https";
  const hostname = parsed.hostname;
  const port = parseInt(parsed.port) || (protocol === "https" ? 443 : 80);
  const basePath = parsed.pathname.replace(/\/+$/, ""); // strip trailing slashes
  const apiPath = basePath + (isResponses ? "/responses" : "/chat/completions");
  // Build auth headers
  const hdrs = { "Content-Type": "application/json" };
  if (ep.authHeader === "Bearer" && ep.apiKey) hdrs["Authorization"] = `Bearer ${ep.apiKey}`;
  else if (ep.authHeader === "api-key" && ep.apiKey) hdrs["api-key"] = ep.apiKey;
  const body = JSON.stringify(req.body);
  hdrs["Content-Length"] = Buffer.byteLength(body);
  const parseFn = isResponses ? parseAccumulatedResponsesSSE : parseAccumulatedChatCompletionsSSE;
  flexibleStreamingProxy(req, res, { hostname, port, protocol, path: apiPath, headers: hdrs, body, label: `Custom(${ep.name})`, parseFn });
});

// ═══════════════════════════════════════════════════════════
// IMAGE GENERATION & SERVING
// ═══════════════════════════════════════════════════════════

// Serve generated images (no auth — images are referenced by random ID)
app.get("/api/images/:id", (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, "");
  const png = join(IMAGES_DIR, id + ".png");
  const jpg = join(IMAGES_DIR, id + ".jpg");
  if (existsSync(png)) { res.setHeader("Content-Type", "image/png"); res.setHeader("Cache-Control", "public, max-age=86400"); res.send(readFileSync(png)); }
  else if (existsSync(jpg)) { res.setHeader("Content-Type", "image/jpeg"); res.setHeader("Cache-Control", "public, max-age=86400"); res.send(readFileSync(jpg)); }
  else res.status(404).send("Not found");
});

// Helper: make an HTTPS request, collect full response body
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, port: 443, path, method: "POST", headers }, (proxyRes) => {
      const chunks = []; proxyRes.on("data", c => chunks.push(c)); proxyRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: proxyRes.statusCode, data: JSON.parse(raw) }); } catch { resolve({ status: proxyRes.statusCode, data: { error: { message: raw } } }); }
      }); proxyRes.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => { req.destroy(new Error("Request timeout (2min)")); });
    req.write(body); req.end();
  });
}

// OpenAI image generation (gpt-image-1, dall-e-3)
app.post("/api/imagegen/openai", requireAuth, async (req, res) => {
  try {
    const keys = loadUserKeys(req.session.userId);
    if (!keys.openai) return res.status(400).json({ error: "No OpenAI API key configured." });
    const { prompt, model, size, quality, output_format, style } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const params = { model: model || "gpt-image-1", prompt, n: 1, size: size || "auto", response_format: "b64_json" };
    if (quality) params.quality = quality;
    if (output_format) params.output_format = output_format;
    if (style) params.style = style;
    const body = JSON.stringify(params);
    const r = await httpsPost("api.openai.com", "/v1/images/generations", { "Content-Type": "application/json", "Authorization": `Bearer ${keys.openai}`, "Content-Length": Buffer.byteLength(body) }, body);
    if (r.status !== 200) return res.status(r.status).json({ error: r.data?.error?.message || "Image generation failed" });

    const b64 = r.data?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image in response" });

    const imageId = crypto.randomBytes(16).toString("hex");
    writeFileSync(join(IMAGES_DIR, imageId + ".png"), Buffer.from(b64, "base64"));
    res.json({ imageId, revisedPrompt: r.data.data[0].revised_prompt || null, usage: r.data.usage || null });
  } catch (e) { console.error("Image gen error:", e.message); res.status(500).json({ error: "Image generation failed" }); }
});

// z.ai image generation (cogview-4) — returns URL, we fetch and save
app.post("/api/imagegen/zai", requireAuth, async (req, res) => {
  try {
    const keys = loadUserKeys(req.session.userId);
    if (!keys.zai) return res.status(400).json({ error: "No z.ai API key configured." });
    const { prompt, model, size } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const body = JSON.stringify({ model: model || "cogview-4-250304", prompt, size: size || "1024x1024" });
    const r = await httpsPost("api.z.ai", "/api/paas/v4/images/generations", { "Content-Type": "application/json", "Authorization": `Bearer ${keys.zai}`, "Content-Length": Buffer.byteLength(body) }, body);
    if (r.status !== 200) return res.status(r.status).json({ error: r.data?.error?.message || "Image generation failed" });

    const imageUrl = r.data?.data?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: "No image URL in response" });

    // Fetch the image from the temporary URL and save locally
    const imgData = await new Promise((resolve, reject) => {
      const imgReq = https.get(imageUrl, (imgRes) => {
        if (imgRes.statusCode !== 200) { imgRes.resume(); return reject(new Error(`Image download failed: ${imgRes.statusCode}`)); }
        const chunks = []; imgRes.on("data", c => chunks.push(c)); imgRes.on("end", () => resolve(Buffer.concat(chunks))); imgRes.on("error", reject);
      });
      imgReq.on("error", reject);
      imgReq.setTimeout(60000, () => { imgReq.destroy(new Error("Image download timeout")); });
    });

    const imageId = crypto.randomBytes(16).toString("hex");
    writeFileSync(join(IMAGES_DIR, imageId + ".png"), imgData);
    res.json({ imageId, revisedPrompt: null });
  } catch (e) { console.error("z.ai image gen error:", e.message); res.status(500).json({ error: "Image generation failed" }); }
});

// xAI image generation (grok-imagine-image, grok-imagine-image-pro)
app.post("/api/imagegen/xai", requireAuth, async (req, res) => {
  try {
    const keys = loadUserKeys(req.session.userId);
    if (!keys.xai) return res.status(400).json({ error: "No xAI API key configured." });
    const { prompt, model, aspect_ratio, resolution } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const body = JSON.stringify({ model: model || "grok-imagine-image-pro", prompt, n: 1, response_format: "b64_json", ...(aspect_ratio ? { aspect_ratio } : {}), ...(resolution ? { resolution } : {}) });
    const r = await httpsPost("api.x.ai", "/v1/images/generations", { "Content-Type": "application/json", "Authorization": `Bearer ${keys.xai}`, "Content-Length": Buffer.byteLength(body) }, body);
    if (r.status !== 200) return res.status(r.status).json({ error: r.data?.error?.message || "Image generation failed" });

    const b64 = r.data?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image in response" });

    const imageId = crypto.randomBytes(16).toString("hex");
    writeFileSync(join(IMAGES_DIR, imageId + ".jpg"), Buffer.from(b64, "base64"));
    res.json({ imageId, revisedPrompt: r.data.data[0].revised_prompt || null });
  } catch (e) { console.error("xAI image gen error:", e.message); res.status(500).json({ error: "Image generation failed" }); }
});

// Google image generation (Gemini generateContent with responseModalities: IMAGE)
app.post("/api/imagegen/google", requireAuth, async (req, res) => {
  try {
    const keys = loadUserKeys(req.session.userId);
    if (!keys.google) return res.status(400).json({ error: "No Google API key configured." });
    const { prompt, model, aspectRatio, imageSize } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const mdl = model || "gemini-3.1-flash-image-preview";
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) } } });
    const r = await httpsPost("generativelanguage.googleapis.com", `/v1beta/models/${encodeURIComponent(mdl)}:generateContent`, { "Content-Type": "application/json", "x-goog-api-key": keys.google, "Content-Length": Buffer.byteLength(body) }, body);
    if (r.status !== 200) return res.status(r.status).json({ error: r.data?.error?.message || "Image generation failed" });

    // Find the image part in the response
    const parts = r.data?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith("image/"));
    if (!imgPart) return res.status(500).json({ error: "No image in response" });

    const ext = imgPart.inlineData.mimeType.includes("jpeg") || imgPart.inlineData.mimeType.includes("jpg") ? ".jpg" : ".png";
    const imageId = crypto.randomBytes(16).toString("hex");
    writeFileSync(join(IMAGES_DIR, imageId + ext), Buffer.from(imgPart.inlineData.data, "base64"));

    // Check for text part (revised prompt or caption)
    const textPart = parts.find(p => p.text);
    res.json({ imageId, revisedPrompt: textPart?.text || null });
  } catch (e) { console.error("Google image gen error:", e.message); res.status(500).json({ error: "Image generation failed" }); }
});

// ═══════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = loadUsers().map(u => ({
    id: u.id, username: u.username, role: u.role, createdAt: u.createdAt,
    hasAnthropicKey: !!loadUserKeys(u.id).anthropic,
    hasXaiKey: !!loadUserKeys(u.id).xai,
    hasOpenaiKey: !!loadUserKeys(u.id).openai,
    hasZaiKey: !!loadUserKeys(u.id).zai,
    sessionCount: (() => { try { if (isMigrated(u.id)) { return Object.keys(loadSessionsMeta(u.id)).length; } const s = loadUserState(u.id); return s?.sessions ? Object.keys(s.sessions).length : 0; } catch { return 0; } })(),
  }));
  res.json(users);
});

app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 2 || username.length > 30) return res.status(400).json({ error: "Username must be 2-30 characters" });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (findUser(username)) return res.status(409).json({ error: "Username already exists" });

  const userRole = role === "admin" ? "admin" : "user";
  const id = crypto.randomBytes(8).toString("hex");
  const passwordHash = await bcrypt.hash(password, 12);
  const users = loadUsers();
  users.push({ id, username, role: userRole, passwordHash, createdAt: Date.now() });
  saveUsers(users);
  userDataDir(id); // Create directory
  console.log(`Admin ${req.session.username} created user "${username}" (${userRole})`);
  res.json({ ok: true, id, username, role: userRole });
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === req.session.userId) return res.status(400).json({ error: "Cannot delete your own account" });
  const users = loadUsers();
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: "User not found" });

  // Remove user data (validate id to prevent path traversal)
  if (!safeHexId(id)) return res.status(400).json({ error: "Invalid user id" });
  const dir = join(USERS_DIR, id);
  if (existsSync(dir)) { try { rmSync(dir, { recursive: true }); } catch {} }

  saveUsers(users.filter(u => u.id !== id));
  console.log(`Admin ${req.session.username} deleted user "${user.username}"`);
  res.json({ ok: true });
});

app.put("/api/admin/users/:id/password", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body || {};
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const users = loadUsers();
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.passwordHash = await bcrypt.hash(password, 12);
  saveUsers(users);
  console.log(`Admin ${req.session.username} reset password for "${user.username}"`);
  res.json({ ok: true });
});

app.put("/api/admin/users/:id/role", requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { role } = req.body || {};
  if (!["admin", "user"].includes(role)) return res.status(400).json({ error: "Role must be 'admin' or 'user'" });
  if (id === req.session.userId) return res.status(400).json({ error: "Cannot change your own role" });

  const users = loadUsers();
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.role = role;
  saveUsers(users);
  console.log(`Admin ${req.session.username} changed role of "${user.username}" to ${role}`);
  res.json({ ok: true });
});

// Admin view user sessions
app.get("/api/admin/users/:id/sessions", requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const user = findUserById(id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (isMigrated(id)) {
    const meta = loadSessionsMeta(id);
    const sessions = Object.values(meta).map(m => ({
      id: m.id, name: m.name, selectedModel: m.selectedModel, messageCount: m.messageCount || 0, createdAt: m.createdAt,
    })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.json({ sessions, username: user.username });
  }
  const state = loadUserState(id);
  if (!state?.sessions) return res.json({ sessions: [], username: user.username });
  const sessions = Object.values(state.sessions).map(s => ({
    id: s.id, name: s.name, selectedModel: s.selectedModel, messageCount: s.messages?.length || 0, createdAt: s.createdAt,
  })).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ sessions, username: user.username });
});

app.get("/api/admin/users/:uid/sessions/:sid", requireAuth, requireAdmin, (req, res) => {
  const { uid, sid } = req.params;
  const user = findUserById(uid);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (isMigrated(uid)) {
    const session = loadSession(uid, sid);
    if (!session) return res.status(404).json({ error: "Session not found" });
    return res.json({ session, username: user.username });
  }
  const state = loadUserState(uid);
  const session = state?.sessions?.[sid];
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ session, username: user.username });
});

// Admin: purge all generated images (files + references in all user sessions)
app.delete("/api/admin/images", requireAuth, requireAdmin, (req, res) => {
  try {
    const files = readdirSync(IMAGES_DIR).filter(f => f.endsWith(".png") || f.endsWith(".jpg"));
    for (const f of files) rmSync(join(IMAGES_DIR, f));
    // Strip generatedImage from all user sessions
    const users = loadUsers();
    for (const u of users) {
      if (isMigrated(u.id)) {
        const meta = loadSessionsMeta(u.id);
        for (const sid of Object.keys(meta)) {
          const session = loadSession(u.id, sid);
          if (!session?.messages) continue;
          let changed = false;
          for (const msg of session.messages) {
            if (msg.generatedImage) { delete msg.generatedImage; changed = true; }
          }
          if (changed) saveSession(u.id, session);
        }
      } else {
        const state = loadUserState(u.id);
        if (!state?.sessions) continue;
        let changed = false;
        for (const [sk, s] of Object.entries(state.sessions)) {
          if (!s.messages) continue;
          const cleaned = s.messages.map(m => { if (m.generatedImage) { changed = true; const { generatedImage, ...rest } = m; return rest; } return m; });
          if (changed) state.sessions[sk] = { ...s, messages: cleaned };
        }
        if (changed) saveUserState(u.id, state);
      }
    }
    console.log(`Admin ${req.session.username} purged ${files.length} generated images`);
    res.json({ ok: true, deleted: files.length });
  } catch (e) { console.error("Image purge error:", e.message); res.status(500).json({ error: "Operation failed" }); }
});

// Admin: storage stats
app.get("/api/admin/storage", requireAuth, requireAdmin, (req, res) => {
  try {
    // Disk usage via df (works on Alpine/Linux in Docker)
    let diskFree = 0, diskTotal = 0, diskUsed = 0;
    try {
      const df = execSync("df -B1 /app/data 2>/dev/null || df -B1 / 2>/dev/null", { encoding: "utf8" });
      const lines = df.trim().split("\n"); if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        diskTotal = parseInt(parts[1]) || 0; diskUsed = parseInt(parts[2]) || 0; diskFree = parseInt(parts[3]) || 0;
      }
    } catch {}

    // Data directory breakdown
    const dirSize = (dir) => {
      if (!existsSync(dir)) return 0;
      let total = 0;
      const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else try { total += statSync(p).size; } catch {} } };
      walk(dir); return total;
    };
    const imagesSize = dirSize(IMAGES_DIR);
    const usersSize = dirSize(USERS_DIR);
    const imageCount = existsSync(IMAGES_DIR) ? readdirSync(IMAGES_DIR).filter(f => f.endsWith(".png") || f.endsWith(".jpg")).length : 0;

    res.json({ diskTotal, diskUsed, diskFree, dataDir: { images: imagesSize, imageCount, users: usersSize, total: imagesSize + usersSize } });
  } catch (e) { console.error("Storage stats error:", e.message); res.status(500).json({ error: "Failed to retrieve storage stats" }); }
});

// ═══════════════════════════════════════════════════════════
// CHANGE OWN PASSWORD
// ═══════════════════════════════════════════════════════════

app.put("/api/account/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Current and new password required" });
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  saveUsers(users);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// CLAUDE CODE PROXY (admin-only → external agent service)
// ═══════════════════════════════════════════════════════════

// Load agent proxy TLS CA certs from file paths (set via env vars)
function loadCaCert(envVar, label) {
  const certPath = process.env[envVar];
  if (!certPath) return null;
  try { return readFileSync(certPath, "utf8"); } catch (e) { console.warn(`Warning: could not load ${label} CA cert from ${certPath}: ${e.message}`); return null; }
}
const CC_CA = loadCaCert("CLAUDE_CODE_CA_PATH", "Claude Code");
const CODEX_CA = loadCaCert("CODEX_CA_PATH", "Codex");

function agentProxy(req, { name, host, port, secret, ca, servername }, method, path, body, res, stream) {
  if (!host) { res.status(503).json({ error: `${name} not configured` }); return; }
  const opts = { hostname: host, port: parseInt(port, 10), path, method, ca, servername, checkServerIdentity: () => undefined, headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" } };
  let browserGone = false;
  const proxyReq = https.request(opts, (proxyRes) => {
    if (stream && proxyRes.statusCode === 200) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no" });
      proxyRes.on("data", (chunk) => { if (!browserGone) try { res.write(chunk); } catch {} });
      proxyRes.on("end", () => { if (!browserGone) try { res.end(); } catch {} });
      proxyRes.on("error", () => { if (!browserGone) try { res.end(); } catch {} });
    } else if (stream) {
      // Non-200 on a streaming request — send SSE error then close
      const chunks = [];
      proxyRes.on("data", c => chunks.push(c));
      proxyRes.on("end", () => {
        if (!browserGone) {
          try {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store" });
            const errBody = Buffer.concat(chunks).toString();
            let errMsg = `${name} error (${proxyRes.statusCode})`;
            try { errMsg = JSON.parse(errBody).error || errMsg; } catch {}
            res.write(`event: error\ndata: ${JSON.stringify({ message: errMsg })}\n\n`);
            res.end();
          } catch {}
        }
      });
    } else {
      const chunks = [];
      proxyRes.on("data", c => chunks.push(c));
      proxyRes.on("end", () => {
        try { res.writeHead(proxyRes.statusCode, { "Content-Type": proxyRes.headers["content-type"] || "application/json" }); res.end(Buffer.concat(chunks)); } catch {}
      });
    }
  });
  req.on("close", () => {
    browserGone = true;
    // For non-streaming requests, don't kill upstream (let POST /sessions complete)
    // For streaming subscriptions, upstream is just an SSE reader — safe to destroy
    if (stream) proxyReq.destroy();
  });
  proxyReq.on("error", (e) => { if (browserGone) return; console.error(`${name} proxy error:`, e.message); if (!res.headersSent) res.status(502).json({ error: `${name} service unavailable` }); });
  proxyReq.setTimeout(600000, () => { proxyReq.destroy(new Error(`${name} timeout (10min)`)); });
  if (body) proxyReq.write(JSON.stringify(body));
  proxyReq.end();
}

const claudeCodeService = { name: "Claude Code", host: CC_HOST, port: CC_PORT, secret: CC_SECRET, ca: CC_CA, servername: "claude-agent" };
const codexService = { name: "Codex", host: CODEX_HOST, port: CODEX_PORT, secret: CODEX_SECRET, ca: CODEX_CA, servername: "codex-agent" };

app.post("/api/claude-code/upload", requireAuth, requireAdmin, (req, res) => { agentProxy(req, claudeCodeService, "POST", "/upload", req.body, res, false); });
app.post("/api/claude-code/send", requireAuth, requireAdmin, (req, res) => { agentProxy(req, claudeCodeService, "POST", "/sessions", req.body, res, false); });
app.get("/api/claude-code/sessions", requireAuth, requireAdmin, (req, res) => { agentProxy(req, claudeCodeService, "GET", "/sessions", null, res, false); });
app.get("/api/claude-code/sessions/:id/messages", requireAuth, requireAdmin, (req, res) => { if (!safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" }); agentProxy(req, claudeCodeService, "GET", `/sessions/${encodeURIComponent(req.params.id)}/messages`, null, res, false); });
app.get("/api/claude-code/sessions/:id/stream", requireAuth, requireAdmin, (req, res) => { if (!safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" }); const after = parseInt(req.query.after || "-1", 10); agentProxy(req, claudeCodeService, "GET", `/sessions/${encodeURIComponent(req.params.id)}/stream?after=${after}`, null, res, true); });
app.get("/api/claude-code/sessions/:id/status", requireAuth, requireAdmin, (req, res) => { if (!safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" }); agentProxy(req, claudeCodeService, "GET", `/sessions/${encodeURIComponent(req.params.id)}/status`, null, res, false); });
app.post("/api/claude-code/sessions/:id/interrupt", requireAuth, requireAdmin, (req, res) => { if (!safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" }); agentProxy(req, claudeCodeService, "POST", `/sessions/${encodeURIComponent(req.params.id)}/interrupt`, null, res, false); });
app.delete("/api/claude-code/sessions/:id", requireAuth, requireAdmin, (req, res) => { if (!safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" }); agentProxy(req, claudeCodeService, "DELETE", `/sessions/${encodeURIComponent(req.params.id)}`, null, res, false); });

app.get("/api/codex/status", requireAuth, requireAdmin, (req, res) => { agentProxy(req, codexService, "GET", "/status", null, res, false); });
app.post("/api/codex/upload", requireAuth, requireAdmin, (req, res) => { agentProxy(req, codexService, "POST", "/upload", req.body, res, false); });
app.post("/api/codex/send", requireAuth, requireAdmin, (req, res) => { agentProxy(req, codexService, "POST", "/sessions", req.body, res, true); });
app.get("/api/codex/sessions", requireAuth, requireAdmin, (req, res) => { agentProxy(req, codexService, "GET", "/sessions", null, res, false); });
app.get("/api/codex/sessions/:id/messages", requireAuth, requireAdmin, (req, res) => { if (!safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" }); agentProxy(req, codexService, "GET", `/sessions/${encodeURIComponent(req.params.id)}/messages`, null, res, false); });
app.get("/api/codex/sessions/:id/output/:itemId", requireAuth, requireAdmin, (req, res) => {
  if (!safeAlphanumId(req.params.id) || !safeAlphanumId(req.params.itemId)) return res.status(400).json({ error: "Invalid id" });
  agentProxy(req, codexService, "GET", `/sessions/${encodeURIComponent(req.params.id)}/output/${encodeURIComponent(req.params.itemId)}`, null, res, false);
});
app.post("/api/codex/sessions/:id/interrupt", requireAuth, requireAdmin, (req, res) => {
  if (!safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" });
  agentProxy(req, codexService, "POST", `/sessions/${encodeURIComponent(req.params.id)}/interrupt`, null, res, false);
});
app.delete("/api/codex/sessions/:id", requireAuth, requireAdmin, (req, res) => { if (!safeAlphanumId(req.params.id)) return res.status(400).json({ error: "Invalid session id" }); agentProxy(req, codexService, "DELETE", `/sessions/${encodeURIComponent(req.params.id)}`, null, res, false); });

// ═══════════════════════════════════════════════════════════
// PUBLIC PAGES (no auth required)
// ═══════════════════════════════════════════════════════════

app.get("/privacy", (req, res) => { res.setHeader("Content-Type", "text/html"); res.send(PRIVACY_HTML); });
app.get("/terms", (req, res) => { res.setHeader("Content-Type", "text/html"); res.send(TERMS_HTML); });
app.get("/register", (req, res) => { if (!isRegistrationEnabled()) return res.redirect("/"); res.setHeader("Content-Type", "text/html"); res.send(getRegisterHtml()); });
app.post("/api/register", handleRegister);
app.post("/api/register/verify", handleRegisterVerify);
app.post("/api/register/resend", handleRegisterResend);

// ═══════════════════════════════════════════════════════════
// STATIC FILES WITH AUTH GATE
// ═══════════════════════════════════════════════════════════

app.use((req, res, next) => { if (req.session?.userId) return next(); res.setHeader("Content-Type", "text/html"); res.send(getLoginHtml()); });
app.use(express.static(DIST_DIR));
app.get("*", (req, res) => { const p = join(DIST_DIR, "index.html"); if (existsSync(p)) res.sendFile(p); else res.status(500).send("App not built. Run: npm run build"); });

app.listen(PORT, "0.0.0.0", () => {
  const users = loadUsers();
  const admins = users.filter(u => u.role === "admin");
  console.log(`TracyHill RP running on http://0.0.0.0:${PORT}`);
  if (ALLOWED_IPS.includes("*")) console.warn("⚠  ALLOWED_IPS=* — IP allowlist DISABLED (all connections accepted)");
  else console.log(`✓  Allowed IPs: ${ALLOWED_IPS.join(", ")}`);
  console.log(`✓  Rate limit: ${MAX_FAILURES} failures → ${LOCKOUT_MS / 60000} min lockout (per-IP + per-username)`);
  console.log(`✓  Users: ${users.length} total, ${admins.length} admin(s)`);
  if (users.length === 0) console.log("⚠  No users! Run: node set-password.js");
  console.log(`✓  Trust proxy: ${TRUST_PROXY ? "ON" : "OFF"}`);
  console.log(`✓  Security headers: enabled`);
  cleanOrphanedPipelines(USERS_DIR);
  console.log(`✓  Proxy mode: per-user API keys`);
});
