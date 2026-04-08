// ═══════════════════════════════════════════════════════════
// USER REGISTRATION — open registration with email verification
// ═══════════════════════════════════════════════════════════

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { loadUsers, saveUsers, findUser, userDataDir } from "./shared.js";
import { sendVerificationEmail, isEmailEnabled } from "./email.js";

const REG_CODE_TTL = 10 * 60 * 1000; // 10 minutes
const REG_MAX_ATTEMPTS = 5;
const REG_MAX_SENDS = 6;
const REG_SEND_WINDOW = 10 * 60 * 1000;

// In-memory stores
const regPending = new Map(); // regToken → { username, email, passwordHash, code, codeHash, expiresAt, attempts, agreedToTerms }
const regSendRate = new Map(); // email → { count, windowStart }

// Prune expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of regPending) { if (now > v.expiresAt) regPending.delete(k); }
  for (const [k, v] of regSendRate) { if (now - v.windowStart > REG_SEND_WINDOW) regSendRate.delete(k); }
}, 60000);

function generateCode() { return crypto.randomInt(100000, 999999).toString(); }

function hashCode(code, secret) {
  return crypto.createHmac("sha256", secret).update(code).digest("hex");
}

function verifyCode(code, hash, secret) {
  const candidate = Buffer.from(hashCode(code, secret), "hex");
  const target = Buffer.from(hash, "hex");
  if (candidate.length !== target.length) return false;
  return crypto.timingSafeEqual(candidate, target);
}

function checkSendRate(email) {
  const now = Date.now();
  const entry = regSendRate.get(email);
  if (!entry || now - entry.windowStart > REG_SEND_WINDOW) return { allowed: true };
  if (entry.count >= REG_MAX_SENDS) return { allowed: false };
  return { allowed: true };
}
function recordSend(email) {
  const now = Date.now();
  const entry = regSendRate.get(email);
  if (!entry || now - entry.windowStart > REG_SEND_WINDOW) {
    regSendRate.set(email, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

function validateEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function validateUsername(username) {
  if (!username || typeof username !== "string") return "Username is required";
  if (username.length < 2 || username.length > 30) return "Username must be 2-30 characters";
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return "Username can only contain letters, numbers, hyphens, and underscores";
  return null;
}

function validatePassword(pw) {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 128) return "Password must be 128 characters or fewer";
  if (!/[a-z]/.test(pw)) return "Password must include a lowercase letter";
  if (!/[A-Z]/.test(pw)) return "Password must include an uppercase letter";
  if (!/[0-9]/.test(pw)) return "Password must include a number";
  return null;
}

/** Check if registration is enabled */
export function isRegistrationEnabled() {
  return isEmailEnabled();
}

/** POST /api/register — start registration, send verification email */
export async function handleRegister(req, res) {
  if (!isEmailEnabled()) return res.status(503).json({ error: "Registration is not available" });

  const { username, email, password, agreedToTerms } = req.body || {};

  // Validate terms agreement
  if (!agreedToTerms) return res.status(400).json({ error: "You must agree to the Terms of Service" });

  // Validate username
  const userErr = validateUsername(username);
  if (userErr) return res.status(400).json({ error: userErr });

  // Validate email
  if (!validateEmail(email)) return res.status(400).json({ error: "Valid email address required" });

  // Validate password
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  // Check if username is taken
  if (findUser(username)) return res.status(409).json({ error: "Username already taken" });

  // Check if email is already registered
  const users = loadUsers();
  if (users.find(u => u.email?.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  // Rate limit email sends
  const rateOk = checkSendRate(email.toLowerCase());
  if (!rateOk.allowed) return res.status(429).json({ error: "Too many attempts. Wait a few minutes." });

  // Hash password now (so we don't store plaintext in memory)
  const passwordHash = await bcrypt.hash(password, 12);

  // Generate verification code and token
  const code = generateCode();
  const regToken = crypto.randomBytes(24).toString("hex");
  const secret = crypto.randomBytes(16).toString("hex");

  regPending.set(regToken, {
    username,
    email: email.toLowerCase(),
    passwordHash,
    codeHash: hashCode(code, secret),
    secret,
    expiresAt: Date.now() + REG_CODE_TTL,
    attempts: 0,
    agreedToTerms: true,
    agreedAt: Date.now(),
  });

  try {
    await sendVerificationEmail(email, code);
    recordSend(email.toLowerCase());
    const masked = email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + "*".repeat(Math.min(b.length, 6)) + c);
    console.log(`Registration started: ${username} (${masked})`);
    res.json({ ok: true, regToken, emailMasked: masked });
  } catch (e) {
    console.error("Registration email failed:", e.message);
    regPending.delete(regToken);
    res.status(500).json({ error: "Failed to send verification email. Try again." });
  }
}

/** POST /api/register/verify — verify email code and create account */
export async function handleRegisterVerify(req, res) {
  const { regToken, code } = req.body || {};
  const pending = regPending.get(regToken);
  if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: "Verification expired. Please register again.", expired: true });

  pending.attempts++;
  if (pending.attempts > REG_MAX_ATTEMPTS) {
    regPending.delete(regToken);
    return res.status(429).json({ error: "Too many attempts. Please register again.", expired: true });
  }

  if (!code || !verifyCode(code.toString(), pending.codeHash, pending.secret)) {
    const remaining = REG_MAX_ATTEMPTS - pending.attempts;
    return res.status(401).json({ error: "Invalid code", remaining });
  }

  // Double-check username/email aren't taken (race condition guard)
  if (findUser(pending.username)) {
    regPending.delete(regToken);
    return res.status(409).json({ error: "Username was taken. Please register again.", expired: true });
  }
  const users = loadUsers();
  if (users.find(u => u.email?.toLowerCase() === pending.email)) {
    regPending.delete(regToken);
    return res.status(409).json({ error: "Email already registered. Please log in.", expired: true });
  }

  // Create the user
  const id = crypto.randomBytes(8).toString("hex");
  users.push({
    id,
    username: pending.username,
    email: pending.email,
    emailVerified: true,
    role: "user",
    passwordHash: pending.passwordHash,
    agreedToTerms: true,
    agreedToTermsAt: pending.agreedAt,
    createdAt: Date.now(),
  });
  saveUsers(users);
  userDataDir(id); // Create user data directory

  regPending.delete(regToken);

  // Auto-login
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Account created but login failed. Please log in manually." });
    req.session.userId = id;
    req.session.username = pending.username;
    req.session.role = "user";
    const clientIp = req.ip || "unknown";
    console.log(`Registration complete: ${pending.username} from ${clientIp}`);
    res.json({ ok: true, needsMfa: false });
  });
}

/** POST /api/register/resend — resend verification code */
export async function handleRegisterResend(req, res) {
  const { regToken } = req.body || {};
  const pending = regPending.get(regToken);
  if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: "Session expired. Please register again.", expired: true });

  const rateOk = checkSendRate(pending.email);
  if (!rateOk.allowed) return res.status(429).json({ error: "Too many codes sent. Wait a few minutes." });

  const code = generateCode();
  pending.codeHash = hashCode(code, pending.secret);
  pending.expiresAt = Date.now() + REG_CODE_TTL;
  pending.attempts = 0;

  try {
    await sendVerificationEmail(pending.email, code);
    recordSend(pending.email);
    res.json({ ok: true });
  } catch (e) {
    console.error("Registration resend failed:", e.message);
    res.status(500).json({ error: "Failed to send email. Try again." });
  }
}
