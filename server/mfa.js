// ═══════════════════════════════════════════════════════════
// MFA — Multi-factor authentication (email-only)
// ═══════════════════════════════════════════════════════════

import crypto from "crypto";
// [SMS REMOVED] import Twilio from "twilio";
import bcrypt from "bcryptjs";
import { existsSync, rmSync } from "fs";
import { loadUsers, saveUsers, findUserById, getSessionSecret, userDataDir, USERS_DIR } from "./shared.js";
import { sendVerificationEmail } from "./email.js";

// [SMS REMOVED] ── Twilio client (lazy-init) ──
// let twilioClient = null;
// function getTwilioClient() {
//   if (twilioClient) return twilioClient;
//   const sid = process.env.TWILIO_ACCOUNT_SID;
//   const token = process.env.TWILIO_AUTH_TOKEN;
//   if (!sid || !token) return null;
//   twilioClient = Twilio(sid, token);
//   return twilioClient;
// }

// [SMS REMOVED] const TWILIO_FROM = () => process.env.TWILIO_PHONE_NUMBER || "";
const MFA_CODE_LENGTH = 6;
const MFA_CODE_TTL = 5 * 60 * 1000; // 5 minutes
const MFA_MAX_ATTEMPTS = 5;
const MFA_MAX_SENDS = 6;
const MFA_SEND_WINDOW = 10 * 60 * 1000; // 10 minutes
const MFA_TRUST_DAYS = parseInt(process.env.MFA_TRUST_DAYS || "30", 10);
const MFA_TRUST_MAX_DEVICES = 10;
const TRUST_COOKIE = "sf.trust";

// ── In-memory stores ──
const mfaPending = new Map(); // mfaSessionToken → { userId, username, role, codeHash, expiresAt, attempts, phone }
const mfaSendRate = new Map(); // userId → { count, windowStart }

// Prune expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mfaPending) { if (now > v.expiresAt) mfaPending.delete(k); }
  for (const [k, v] of mfaSendRate) { if (now - v.windowStart > MFA_SEND_WINDOW) mfaSendRate.delete(k); }
}, 60000);

// ── Helpers ──
function generateCode() { return crypto.randomInt(100000, 999999).toString(); }

function newSecret() { return crypto.randomBytes(16).toString("hex"); }

function hashCode(code, secret) {
  return crypto.createHmac("sha256", secret).update(code).digest("hex");
}

function verifyCode(code, hash, secret) {
  const candidate = Buffer.from(hashCode(code, secret), "hex");
  const target = Buffer.from(hash, "hex");
  if (candidate.length !== target.length) return false;
  return crypto.timingSafeEqual(candidate, target);
}

// [SMS REMOVED] Phone utility functions
// function normalizePhone(phone) {
//   if (typeof phone !== "string") return null;
//   const digits = phone.replace(/\D/g, "");
//   if (digits.length === 10) return "+1" + digits;
//   if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
//   if (phone.startsWith("+") && digits.length >= 10 && digits.length <= 15) return "+" + digits;
//   return null;
// }
// function validateE164(phone) {
//   return typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone);
// }
// function maskPhone(phone) {
//   if (!phone || phone.length < 6) return "***";
//   return "***-***-" + phone.slice(-4);
// }

function generateTrustToken() { return crypto.randomBytes(32).toString("hex"); }

function userAgentLabel(ua) {
  if (!ua) return "Unknown device";
  // Extract browser + OS in a compact label
  const browser = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|Brave)[/\s]?([\d.]*)/)?.[0] || "";
  const os = ua.match(/(Windows|Mac OS X|Linux|Android|iOS|iPhone)[/\s]?([\d._]*)/)?.[0]?.replace(/_/g, ".") || "";
  return [browser, os].filter(Boolean).join(" / ") || ua.substring(0, 40);
}

// ── Check code sending rate limit ──
function checkSendRate(userId) {
  const now = Date.now();
  const entry = mfaSendRate.get(userId);
  if (!entry || now - entry.windowStart > MFA_SEND_WINDOW) return { allowed: true };
  if (entry.count >= MFA_MAX_SENDS) return { allowed: false };
  return { allowed: true };
}
function recordSend(userId) {
  const now = Date.now();
  const entry = mfaSendRate.get(userId);
  if (!entry || now - entry.windowStart > MFA_SEND_WINDOW) {
    mfaSendRate.set(userId, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

// [SMS REMOVED] ── Send SMS via Twilio ──
// async function sendSmsCode(toPhone, code) {
//   const client = getTwilioClient();
//   if (!client) throw new Error("Twilio not configured");
//   await client.messages.create({
//     body: `Your TracyHill verification code is: ${code}. Don't share this code with anyone. TracyHill will never ask for this code.`,
//     from: TWILIO_FROM(),
//     to: toPhone,
//   });
// }

// ═══════════════════════════════════════════════════════════
// EXPORTED FUNCTIONS (called from server.js)
// ═══════════════════════════════════════════════════════════

/** Check if MFA is configured (email via SendGrid) */
export function isMfaEnabled() {
  // [SMS REMOVED] Was: return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
  return !!process.env.SENDGRID_API_KEY;
}

/** Parse trust cookie from request */
export function parseTrustToken(req) {
  const raw = req.headers?.cookie || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${TRUST_COOKIE}=([a-f0-9]{64})`));
  return match ? match[1] : null;
}

/** Check if a user has a valid trust token (timing-safe comparison) */
export function checkTrustedDevice(user, token) {
  if (!token || !user.trustedDevices?.length) return false;
  const now = Date.now();
  const maxAge = MFA_TRUST_DAYS * 24 * 60 * 60 * 1000;
  const tokenBuf = Buffer.from(token, "hex");
  for (const d of user.trustedDevices) {
    if ((now - d.createdAt) >= maxAge) continue;
    const dBuf = Buffer.from(d.token, "hex");
    if (tokenBuf.length === dBuf.length && crypto.timingSafeEqual(tokenBuf, dBuf)) {
      // Persist lastUsed update
      const users = loadUsers();
      const u = users.find(u2 => u2.id === user.id);
      if (u) { const dev = (u.trustedDevices || []).find(d2 => d2.token === d.token); if (dev) dev.lastUsed = now; saveUsers(users); }
      return true;
    }
  }
  return false;
}

/** Create a pending MFA session after successful password auth.
 *  Sends code via email.
 *  Returns { mfaSessionToken, method, emailMasked } */
export async function createMfaChallenge(user, req) {
  const token = crypto.randomBytes(24).toString("hex");
  // [SMS REMOVED] const hasPhone = user.mfaPhone && user.mfaPhoneVerified;
  // [SMS REMOVED] const method = hasPhone ? "sms" : "email";
  const method = "email";

  const secret = newSecret();
  const pending = {
    userId: user.id,
    username: user.username,
    role: user.role,
    // [SMS REMOVED] phone: user.mfaPhone || null,
    email: user.email || null,
    method,
    secret,
    codeHash: null,
    expiresAt: Date.now() + MFA_CODE_TTL,
    attempts: 0,
  };

  const code = generateCode();
  pending.codeHash = hashCode(code, pending.secret);
  const rateOk = checkSendRate(user.id);

  if (rateOk.allowed) {
    try {
      // [SMS REMOVED] if (hasPhone) { await sendSmsCode(user.mfaPhone, code); } else
      if (user.email) {
        await sendVerificationEmail(user.email, code);
      } else {
        // No email — shouldn't happen, but handle gracefully
        pending.codeHash = null;
      }
      recordSend(user.id);
    } catch (e) {
      console.error(`MFA email send failed for ${user.username}:`, e.message);
      pending.codeHash = null;
    }
  }

  mfaPending.set(token, pending);

  const emailMasked = user.email ? user.email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + "*".repeat(Math.min(b.length, 6)) + c) : null;
  // [SMS REMOVED] const hasAlternate = hasPhone && !!user.email;
  return {
    mfaSessionToken: token,
    method,
    // [SMS REMOVED] phoneLast4: hasPhone ? maskPhone(user.mfaPhone) : null,
    emailMasked: emailMasked,
    hasAlternate: false,
    codeSent: !!pending.codeHash,
  };
}

/** Set trust cookie on response */
export function setTrustCookie(res, token, secure) {
  const maxAge = MFA_TRUST_DAYS * 24 * 60 * 60 * 1000;
  res.cookie(TRUST_COOKIE, token, {
    maxAge,
    httpOnly: true,
    secure: secure,
    sameSite: "lax",
    path: "/",
  });
}

// ── Route handlers (mounted individually from server.js for simplicity) ──

/** POST /api/mfa/send-code — resend MFA code via email */
export async function handleSendCode(req, res) {
  const { mfaSessionToken } = req.body || {};
  // [SMS REMOVED] const { method: requestedMethod } = req.body || {};
  const pending = mfaPending.get(mfaSessionToken);
  if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: "Session expired. Please log in again." });

  // [SMS REMOVED] Method switching (was SMS/email toggle)
  // if (requestedMethod === "email" && pending.email) pending.method = "email";
  // else if (requestedMethod === "sms" && pending.phone) pending.method = "sms";
  pending.method = "email";

  const rateOk = checkSendRate(pending.userId);
  if (!rateOk.allowed) return res.status(429).json({ error: "Too many codes sent. Wait a few minutes." });

  const code = generateCode();
  pending.codeHash = hashCode(code, pending.secret);
  pending.expiresAt = Date.now() + MFA_CODE_TTL; // Reset timer on resend
  // Do not reset attempts on resend — prevents brute-force expansion

  try {
    // [SMS REMOVED] if (pending.method === "sms" && pending.phone) { await sendSmsCode(pending.phone, code); } else
    if (pending.email) {
      await sendVerificationEmail(pending.email, code);
    } else {
      return res.status(400).json({ error: "No delivery method available" });
    }
    recordSend(pending.userId);
    res.json({ ok: true, method: pending.method });
  } catch (e) {
    console.error("MFA resend failed:", e.message);
    res.status(500).json({ error: "Failed to send code. Try again." });
  }
}

/** POST /api/mfa/verify — verify MFA code and complete login */
export async function handleVerify(req, res) {
  const { mfaSessionToken, code, trustDevice } = req.body || {};
  const pending = mfaPending.get(mfaSessionToken);
  if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: "Session expired. Please log in again.", expired: true });
  if (!pending.codeHash) return res.status(400).json({ error: "No code has been sent yet" });

  pending.attempts++;
  if (pending.attempts > MFA_MAX_ATTEMPTS) {
    mfaPending.delete(mfaSessionToken);
    return res.status(429).json({ error: "Too many attempts. Please log in again.", expired: true });
  }

  if (!code || !verifyCode(code.toString(), pending.codeHash, pending.secret)) {
    const remaining = MFA_MAX_ATTEMPTS - pending.attempts;
    return res.status(401).json({ error: "Invalid code", remaining });
  }

  // Code is valid — complete authentication
  mfaPending.delete(mfaSessionToken);

  // Handle trust device
  let trustToken = null;
  if (trustDevice) {
    trustToken = generateTrustToken();
    const users = loadUsers();
    const user = users.find(u => u.id === pending.userId);
    if (user) {
      if (!user.trustedDevices) user.trustedDevices = [];
      user.trustedDevices.push({
        token: trustToken,
        label: userAgentLabel(req.headers["user-agent"]),
        createdAt: Date.now(),
        lastUsed: Date.now(),
      });
      // Cap trusted devices
      if (user.trustedDevices.length > MFA_TRUST_MAX_DEVICES) {
        user.trustedDevices.sort((a, b) => a.lastUsed - b.lastUsed);
        user.trustedDevices = user.trustedDevices.slice(-MFA_TRUST_MAX_DEVICES);
      }
      saveUsers(users);
    }
  }

  // Create full session
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Authentication error" });
    req.session.userId = pending.userId;
    req.session.username = pending.username;
    req.session.role = pending.role;
    const clientIp = req.ip || "unknown";
    console.log(`MFA verified: ${pending.username} from ${clientIp}`);

    if (trustToken) {
      setTrustCookie(res, trustToken, req.secure || req.headers["x-forwarded-proto"] === "https");
    }
    res.json({ ok: true });
  });
}

// [SMS REMOVED] Phone enrollment handlers — commented out entirely
// /** POST /api/mfa/enroll — set phone number and send verification code */
// export async function handleEnroll(req, res) { ... }
// /** POST /api/mfa/enroll/verify — verify enrollment code and complete login */
// export async function handleEnrollVerify(req, res) { ... }
// Full code preserved in git history at commit before SMS removal
export async function handleEnroll(req, res) { res.status(410).json({ error: "SMS enrollment has been disabled" }); }
export async function handleEnrollVerify(req, res) { res.status(410).json({ error: "SMS enrollment has been disabled" }); }

/** GET /api/account/mfa — get MFA status (authenticated) */
export function handleGetMfaStatus(req, res) {
  const user = findUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const devices = (user.trustedDevices || []).map((d, i) => ({
    id: i,
    tokenPreview: d.token.substring(0, 8) + "...",
    label: d.label,
    createdAt: d.createdAt,
    lastUsed: d.lastUsed,
  }));

  res.json({
    // [SMS REMOVED] phone: user.mfaPhone ? maskPhone(user.mfaPhone) : null,
    // [SMS REMOVED] phoneVerified: !!user.mfaPhoneVerified,
    trustedDevices: devices,
  });
}

/** DELETE /api/account/mfa/trusted-devices/:id — revoke one device by index */
export function handleRevokeDevice(req, res) {
  const idx = parseInt(req.params.token, 10);
  if (isNaN(idx) || idx < 0) return res.status(400).json({ error: "Invalid device ID" });

  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.trustedDevices || idx >= user.trustedDevices.length) return res.status(404).json({ error: "Device not found" });

  user.trustedDevices.splice(idx, 1);
  saveUsers(users);

  res.json({ ok: true });
}

/** DELETE /api/account/mfa/trusted-devices — revoke all devices */
export function handleRevokeAllDevices(req, res) {
  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const count = (user.trustedDevices || []).length;
  user.trustedDevices = [];
  saveUsers(users);

  res.json({ ok: true, removed: count });
}

// [SMS REMOVED] Phone update handlers — commented out entirely
// /** POST /api/account/mfa/update-phone — change phone number */
// export async function handleUpdatePhone(req, res) { ... }
// /** POST /api/account/mfa/update-phone/verify — verify new phone number */
// export async function handleUpdatePhoneVerify(req, res) { ... }
// Full code preserved in git history at commit before SMS removal
export async function handleUpdatePhone(req, res) { res.status(410).json({ error: "SMS phone management has been disabled" }); }
export async function handleUpdatePhoneVerify(req, res) { res.status(410).json({ error: "SMS phone management has been disabled" }); }

// ═══════════════════════════════════════════════════════════
// FORGOT PASSWORD
// ═══════════════════════════════════════════════════════════

const RESET_CODE_TTL = 10 * 60 * 1000; // 10 minutes

/** POST /api/forgot-password — initiate password reset */
export async function handleForgotPassword(req, res) {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "Username is required" });

  const user = loadUsers().find(u => u.username.toLowerCase() === username.toLowerCase());

  // Always respond the same to prevent username enumeration
  const genericMsg = { ok: true, message: "If the account exists, a verification code has been sent." };

  if (!user) {
    // Fake delay to prevent timing-based enumeration
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    return res.json(genericMsg);
  }

  // [SMS REMOVED] const hasPhone = user.mfaPhone && user.mfaPhoneVerified;
  const hasEmail = !!user.email;
  if (!hasEmail) return res.json(genericMsg); // No way to send code

  const rateOk = checkSendRate("reset:" + user.id);
  if (!rateOk.allowed) return res.json(genericMsg); // Same response to prevent enumeration

  const method = "email"; // [SMS REMOVED] was: hasPhone ? "sms" : "email"
  const code = generateCode();
  const token = crypto.randomBytes(24).toString("hex");
  const secret = newSecret();

  const pending = {
    userId: user.id,
    username: user.username,
    // [SMS REMOVED] phone: user.mfaPhone || null,
    email: user.email || null,
    method,
    secret,
    codeHash: hashCode(code, secret),
    expiresAt: Date.now() + RESET_CODE_TTL,
    attempts: 0,
    hasAlternate: false, // [SMS REMOVED] was: hasPhone && hasEmail
  };

  try {
    // [SMS REMOVED] if (method === "sms") { await sendSmsCode(user.mfaPhone, code); } else
    await sendVerificationEmail(user.email, code);
    recordSend("reset:" + user.id);
  } catch (e) {
    console.error("Forgot password send failed:", e.message);
    return res.json(genericMsg);
  }

  mfaPending.set("reset:" + token, pending);

  const emailMasked = user.email ? user.email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + "*".repeat(Math.min(b.length, 6)) + c) : null;
  const clientIp = req.ip || "unknown";
  console.log(`Password reset requested: ${user.username} from ${clientIp} (email)`);

  res.json({
    ok: true,
    resetToken: token,
    method,
    // [SMS REMOVED] phoneLast4: hasPhone ? maskPhone(user.mfaPhone) : null,
    emailMasked,
    hasAlternate: false,
  });
}

/** POST /api/forgot-password/send-code — resend code for password reset (email only) */
export async function handleForgotPasswordSendCode(req, res) {
  const { resetToken } = req.body || {};
  // [SMS REMOVED] const { method: requestedMethod } = req.body || {};
  const pending = mfaPending.get("reset:" + resetToken);
  if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: "Session expired. Please try again.", expired: true });

  // [SMS REMOVED] Method switching
  // if (requestedMethod === "email" && pending.email) pending.method = "email";
  // else if (requestedMethod === "sms" && pending.phone) pending.method = "sms";
  pending.method = "email";

  const rateOk = checkSendRate("reset:" + pending.userId);
  if (!rateOk.allowed) return res.status(429).json({ error: "Too many codes sent. Wait a few minutes." });

  const code = generateCode();
  pending.codeHash = hashCode(code, pending.secret);
  pending.expiresAt = Date.now() + RESET_CODE_TTL;
  // Do not reset attempts on resend — prevents brute-force expansion

  try {
    // [SMS REMOVED] if (pending.method === "sms" && pending.phone) { await sendSmsCode(pending.phone, code); } else
    if (pending.email) {
      await sendVerificationEmail(pending.email, code);
    } else {
      return res.status(400).json({ error: "No delivery method available" });
    }
    recordSend("reset:" + pending.userId);
    res.json({ ok: true, method: pending.method });
  } catch (e) {
    console.error("Reset resend failed:", e.message);
    res.status(500).json({ error: "Failed to send code. Try again." });
  }
}

/** POST /api/forgot-password/verify — verify code and allow password reset */
export async function handleForgotPasswordVerify(req, res) {
  const { resetToken, code } = req.body || {};
  const pending = mfaPending.get("reset:" + resetToken);
  if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: "Session expired. Please try again.", expired: true });

  pending.attempts++;
  if (pending.attempts > MFA_MAX_ATTEMPTS) {
    mfaPending.delete("reset:" + resetToken);
    return res.status(429).json({ error: "Too many attempts. Please try again.", expired: true });
  }

  if (!code || !verifyCode(code.toString(), pending.codeHash, pending.secret)) {
    const remaining = MFA_MAX_ATTEMPTS - pending.attempts;
    return res.status(401).json({ error: "Invalid code", remaining });
  }

  // Code verified — mark as verified (allow password change)
  pending.verified = true;
  pending.expiresAt = Date.now() + 5 * 60 * 1000; // 5 more minutes to set password
  res.json({ ok: true });
}

/** POST /api/forgot-password/reset — set new password (after code verification) */
export async function handleForgotPasswordReset(req, res) {
  const { resetToken, newPassword } = req.body || {};
  const pending = mfaPending.get("reset:" + resetToken);
  if (!pending || Date.now() > pending.expiresAt || !pending.verified) {
    return res.status(400).json({ error: "Session expired. Please try again.", expired: true });
  }

  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (newPassword.length > 128) return res.status(400).json({ error: "Password must be 128 characters or fewer" });
  if (!/[a-z]/.test(newPassword)) return res.status(400).json({ error: "Password must include a lowercase letter" });
  if (!/[A-Z]/.test(newPassword)) return res.status(400).json({ error: "Password must include an uppercase letter" });
  if (!/[0-9]/.test(newPassword)) return res.status(400).json({ error: "Password must include a number" });

  const users = loadUsers();
  const user = users.find(u => u.id === pending.userId);
  if (!user) { mfaPending.delete("reset:" + resetToken); return res.status(400).json({ error: "User not found" }); }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  // Revoke all trusted devices on password reset (security)
  user.trustedDevices = [];
  saveUsers(users);

  mfaPending.delete("reset:" + resetToken);
  const clientIp = req.ip || "unknown";
  console.log(`Password reset complete: ${user.username} from ${clientIp}`);
  res.json({ ok: true });
}

// ═══════════════════════════════════════════════════════════
// ACCOUNT DELETION
// ═══════════════════════════════════════════════════════════

const DELETE_CODE_TTL = 10 * 60 * 1000;

/** POST /api/account/delete-request — initiate account deletion (sends MFA code) */
export async function handleDeleteRequest(req, res) {
  const user = findUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  // [SMS REMOVED] const hasPhone = user.mfaPhone && user.mfaPhoneVerified;
  const hasEmail = !!user.email;
  if (!hasEmail) return res.status(400).json({ error: "No verification method available" });

  const rateOk = checkSendRate("delete:" + user.id);
  if (!rateOk.allowed) return res.status(429).json({ error: "Too many attempts. Wait a few minutes." });

  const method = "email"; // [SMS REMOVED] was: hasPhone ? "sms" : "email"
  const code = generateCode();
  const token = crypto.randomBytes(24).toString("hex");
  const secret = newSecret();

  const pending = {
    userId: user.id,
    username: user.username,
    // [SMS REMOVED] phone: user.mfaPhone || null,
    email: user.email || null,
    method,
    secret,
    codeHash: hashCode(code, secret),
    expiresAt: Date.now() + DELETE_CODE_TTL,
    attempts: 0,
    hasAlternate: false, // [SMS REMOVED] was: hasPhone && hasEmail
    verified: false,
  };

  try {
    // [SMS REMOVED] if (method === "sms") await sendSmsCode(user.mfaPhone, code);
    await sendVerificationEmail(user.email, code);
    recordSend("delete:" + user.id);
  } catch (e) {
    console.error("Delete request send failed:", e.message);
    return res.status(500).json({ error: "Failed to send verification code" });
  }

  mfaPending.set("delete:" + token, pending);

  const emailMasked = user.email ? user.email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + "*".repeat(Math.min(b.length, 6)) + c) : null;
  const clientIp = req.ip || "unknown";
  console.log(`Account deletion requested: ${user.username} from ${clientIp}`);

  res.json({
    ok: true,
    deleteToken: token,
    method,
    // [SMS REMOVED] phoneLast4: hasPhone ? maskPhone(user.mfaPhone) : null,
    emailMasked,
    hasAlternate: false,
  });
}

/** POST /api/account/delete-request/send-code — resend code for deletion (email only) */
export async function handleDeleteSendCode(req, res) {
  const { deleteToken } = req.body || {};
  // [SMS REMOVED] const { method: requestedMethod } = req.body || {};
  const pending = mfaPending.get("delete:" + deleteToken);
  if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: "Session expired.", expired: true });
  if (pending.userId !== req.session.userId) return res.status(403).json({ error: "Unauthorized" });

  // [SMS REMOVED] Method switching
  // if (requestedMethod === "email" && pending.email) pending.method = "email";
  // else if (requestedMethod === "sms" && pending.phone) pending.method = "sms";
  pending.method = "email";

  const rateOk = checkSendRate("delete:" + pending.userId);
  if (!rateOk.allowed) return res.status(429).json({ error: "Too many codes sent. Wait a few minutes." });

  const code = generateCode();
  pending.codeHash = hashCode(code, pending.secret);
  pending.expiresAt = Date.now() + DELETE_CODE_TTL;
  // Do not reset attempts on resend — prevents brute-force expansion

  try {
    // [SMS REMOVED] if (pending.method === "sms" && pending.phone) await sendSmsCode(pending.phone, code);
    if (pending.email) await sendVerificationEmail(pending.email, code);
    else return res.status(400).json({ error: "No delivery method" });
    recordSend("delete:" + pending.userId);
    res.json({ ok: true, method: pending.method });
  } catch (e) {
    res.status(500).json({ error: "Failed to send code" });
  }
}

/** POST /api/account/delete-confirm — verify MFA code for deletion */
export async function handleDeleteConfirm(req, res) {
  const { deleteToken, code } = req.body || {};
  const pending = mfaPending.get("delete:" + deleteToken);
  if (!pending || Date.now() > pending.expiresAt) return res.status(400).json({ error: "Session expired.", expired: true });
  if (pending.userId !== req.session.userId) return res.status(403).json({ error: "Unauthorized" });

  pending.attempts++;
  if (pending.attempts > MFA_MAX_ATTEMPTS) {
    mfaPending.delete("delete:" + deleteToken);
    return res.status(429).json({ error: "Too many attempts.", expired: true });
  }

  if (!code || !verifyCode(code.toString(), pending.codeHash, pending.secret)) {
    const remaining = MFA_MAX_ATTEMPTS - pending.attempts;
    return res.status(401).json({ error: "Invalid code", remaining });
  }

  pending.verified = true;
  pending.expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes to confirm
  res.json({ verified: true });
}

/** DELETE /api/account/delete-execute — permanently delete account (after MFA verification) */
export async function handleDeleteExecute(req, res) {
  const { deleteToken } = req.body || {};
  const pending = mfaPending.get("delete:" + deleteToken);
  if (!pending || Date.now() > pending.expiresAt || !pending.verified) {
    return res.status(400).json({ error: "Verification expired. Start over.", expired: true });
  }
  if (pending.userId !== req.session.userId) return res.status(403).json({ error: "Unauthorized" });

  const userId = pending.userId;
  const username = pending.username;
  const clientIp = req.ip || "unknown";

  // Remove user from users.json
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) { mfaPending.delete("delete:" + deleteToken); return res.status(404).json({ error: "User not found" }); }

  // Prevent deleting the last admin
  const user = users[idx];
  if (user.role === "admin") {
    const adminCount = users.filter(u => u.role === "admin").length;
    if (adminCount <= 1) { mfaPending.delete("delete:" + deleteToken); return res.status(400).json({ error: "Cannot delete the last admin account" }); }
  }

  users.splice(idx, 1);
  saveUsers(users);

  // Delete user data directory (conversations, campaigns, keys, everything)
  try {
    const dir = userDataDir(userId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`Failed to delete data dir for ${username}:`, e.message);
  }

  mfaPending.delete("delete:" + deleteToken);

  // Destroy session (log out)
  req.session.destroy(() => {
    res.clearCookie("sf.sid");
    res.clearCookie("sf.trust", { path: "/", httpOnly: true, sameSite: "lax" });
    console.log(`Account deleted: ${username} (${userId}) from ${clientIp}`);
    res.json({ ok: true });
  });
}
