import crypto from "node:crypto";
import type session from "express-session";

import type { CurrentUserResponse } from "@tracyhill-rp/contracts";

import { comparePassword, hashPassword, validateEmail, validatePassword, validateUsername } from "../../lib/password";
import { HttpError } from "../../lib/httpError";
import { recordSystemEvent } from "../system/systemEvents";
import { createId } from "../../lib/ids";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { UserRepository } from "../users/userRepository";
import type { AuthEmailService } from "../../services/authEmail";

const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;
// Pre-computed bcrypt hash of an unguessable constant — used only to equalize
// login timing for unknown usernames. Never matches a real password.
const DUMMY_PASSWORD_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBp4LRHK0H8mX5o0bPLxYy0VVDeOnW";
const REGISTRATION_MAX_ATTEMPTS = 5;
const REGISTRATION_MAX_SENDS = 6;
const REGISTRATION_SEND_WINDOW_MS = 10 * 60 * 1000;
const PASSWORD_RESET_VERIFIED_TTL_MS = 5 * 60 * 1000;
const ACCOUNT_DELETION_VERIFIED_TTL_MS = 5 * 60 * 1000;
const TRUST_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TRUST_DEVICE_MAX_COUNT = 10;

type TrustedDeviceRecord = {
  token: string;
  label: string;
  createdAt: number;
  lastUsed: number;
};

type PendingRegistration = {
  username: string;
  email: string;
  passwordHash: string;
  codeHash: string;
  secret: string;
  expiresAt: number;
  attempts: number;
};

type PendingPasswordReset = {
  userId: string;
  email: string;
  codeHash: string;
  secret: string;
  expiresAt: number;
  attempts: number;
  verified: boolean;
  // dummy entries are created for non-existent users / users without email,
  // so the response shape is constant and the SPA flow looks identical from the outside.
  // No real email is ever sent for dummy entries, and the random code never matches
  // any submission, so verifyCode will always reject -- producing the same "Invalid code"
  // and 429 errors that a real wrong-code attempt would yield.
  dummy: boolean;
};

type PendingMfaChallenge = {
  userId: string;
  username: string;
  role: "admin" | "user";
  email: string;
  codeHash: string;
  secret: string;
  expiresAt: number;
  attempts: number;
};

type PendingAccountDeletion = {
  userId: string;
  email: string;
  codeHash: string;
  secret: string;
  expiresAt: number;
  attempts: number;
  verified: boolean;
};

export class AuthService {
  private readonly pendingRegistrations = new Map<string, PendingRegistration>();
  private readonly registrationSendRate = new Map<string, { count: number; windowStart: number }>();
  private readonly pendingPasswordResets = new Map<string, PendingPasswordReset>();
  private readonly passwordResetSendRate = new Map<string, { count: number; windowStart: number }>();
  private readonly pendingMfaChallenges = new Map<string, PendingMfaChallenge>();
  private readonly mfaSendRate = new Map<string, { count: number; windowStart: number }>();
  private readonly pendingAccountDeletions = new Map<string, PendingAccountDeletion>();
  private readonly accountDeletionSendRate = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly users: UserRepository,
    private readonly generatedImages: GeneratedImageRepository,
    private readonly imageStore: ImageStore,
    private readonly authEmail: AuthEmailService,
  ) {}

  async login(payload: { username: string; password: string }, requestSession: session.Session & Partial<session.SessionData>, trustedDeviceToken?: string | null) {
    const user = this.users.findByUsername(payload.username);
    if (!user) {
      // Equalize response timing with the wrong-password path: skipping the
      // hash comparison made unknown-username responses measurably faster,
      // which let response latency classify whether an account exists.
      await comparePassword(payload.password, DUMMY_PASSWORD_HASH);
      return null;
    }
    const ok = await comparePassword(payload.password, user.passwordHash);
    if (!ok) return null;
    if (this.shouldRequireMfa(user)) {
      if (trustedDeviceToken && this.useTrustedDevice(user.id, trustedDeviceToken)) {
        requestSession.userId = user.id;
        requestSession.role = user.role as "admin" | "user";
        return { id: user.id, username: user.username, role: user.role as "admin" | "user" };
      }
      requestSession.userId = undefined;
      requestSession.role = undefined;
      return this.issueMfaChallenge(user as typeof user & { email: string });
    }
    requestSession.userId = user.id;
    requestSession.role = user.role as "admin" | "user";
    return { id: user.id, username: user.username, role: user.role as "admin" | "user" };
  }

  async register(payload: { username: string; email: string; password: string; agreedToTerms: true }, requestSession: session.Session & Partial<session.SessionData>) {
    this.pruneRegistrations();
    if (!this.authEmail.isAvailable()) throw new HttpError(503, "Registration is not available");
    const username = payload.username.trim();
    const email = payload.email.trim().toLowerCase();
    const usernameError = validateUsername(username);
    if (usernameError) throw new HttpError(400, usernameError);
    const emailError = validateEmail(email);
    if (emailError) throw new HttpError(400, emailError);
    const passwordError = validatePassword(payload.password);
    if (passwordError) throw new HttpError(400, passwordError);
    if (!payload.agreedToTerms) throw new HttpError(400, "You must agree to the Terms of Service");
    if (this.users.findByUsername(username)) throw new HttpError(409, "Username already taken");
    if (this.users.findByEmail(email)) throw new HttpError(409, "An account with this email already exists");
    const sendRate = this.getRegistrationSendRate(email);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many attempts. Wait a few minutes.");

    const code = this.generateCode();
    const registrationToken = crypto.randomBytes(24).toString("hex");
    const secret = crypto.randomBytes(16).toString("hex");
    const passwordHash = await hashPassword(payload.password);
    const pending: PendingRegistration = {
      username,
      email,
      passwordHash,
      codeHash: this.hashCode(code, secret),
      secret,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
    };
    const delivery = await this.sendRegistrationCode(email, code);
    this.pendingRegistrations.set(registrationToken, pending);
    this.recordRegistrationSend(email);
    requestSession.userId = undefined;
    requestSession.role = undefined;
    return {
      verificationRequired: true as const,
      registrationToken,
      emailMasked: this.maskEmail(email),
      ...(delivery.devVerificationCode ? { devVerificationCode: delivery.devVerificationCode } : {}),
    };
  }

  async verifyRegistration(payload: { registrationToken: string; code: string }, requestSession: session.Session & Partial<session.SessionData>) {
    this.pruneRegistrations();
    const pending = this.pendingRegistrations.get(payload.registrationToken);
    if (!pending) throw new HttpError(400, "Verification expired. Please register again.");
    pending.attempts += 1;
    if (pending.attempts > REGISTRATION_MAX_ATTEMPTS) {
      this.pendingRegistrations.delete(payload.registrationToken);
      throw new HttpError(429, "Too many attempts. Please register again.");
    }
    if (!this.verifyCode(payload.code.trim(), pending.codeHash, pending.secret)) throw new HttpError(401, "Invalid code");
    if (this.users.findByUsername(pending.username)) {
      this.pendingRegistrations.delete(payload.registrationToken);
      throw new HttpError(409, "Username was taken. Please register again.");
    }
    if (this.users.findByEmail(pending.email)) {
      this.pendingRegistrations.delete(payload.registrationToken);
      throw new HttpError(409, "Email already registered. Please log in.");
    }
    const now = new Date().toISOString();
    const id = createId();
    this.users.createUser({
      id,
      username: pending.username,
      email: pending.email,
      emailVerified: 1,
      agreedToTerms: 1,
      role: "user",
      passwordHash: pending.passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    this.pendingRegistrations.delete(payload.registrationToken);
    requestSession.userId = id;
    requestSession.role = "user";
    return { id, username: pending.username, role: "user" as const };
  }

  async resendRegistration(payload: { registrationToken: string }) {
    this.pruneRegistrations();
    const pending = this.pendingRegistrations.get(payload.registrationToken);
    if (!pending) throw new HttpError(400, "Session expired. Please register again.");
    const sendRate = this.getRegistrationSendRate(pending.email);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const code = this.generateCode();
    // Count BEFORE the await (concurrent resends used to all pass the cap),
    // and only swap the active code AFTER delivery succeeds — a failed send
    // used to invalidate the code already sitting in the user's inbox.
    this.recordRegistrationSend(pending.email);
    const delivery = await this.sendRegistrationCode(pending.email, code);
    pending.codeHash = this.hashCode(code, pending.secret);
    pending.expiresAt = Date.now() + REGISTRATION_CODE_TTL_MS;
    pending.attempts = 0;
    return {
      emailMasked: this.maskEmail(pending.email),
      ...(delivery.devVerificationCode ? { devVerificationCode: delivery.devVerificationCode } : {}),
    };
  }

  async requestPasswordReset(payload: { username: string }) {
    this.pruneRegistrations();
    // Constant-shape response. Real-vs-dummy is invisible to the caller.
    const message = "If the account exists, a verification code has been sent.";
    const username = payload.username.trim();
    const user = username ? this.users.findByUsername(username) : null;
    const sendRate = user ? this.getSendRate(this.passwordResetSendRate, user.id) : null;
    const realRequest = Boolean(
      user?.email
      && this.authEmail.isAvailable()
      && (!sendRate || sendRate.count < REGISTRATION_MAX_SENDS),
    );
    const code = this.generateCode();
    const resetToken = crypto.randomBytes(24).toString("hex");
    const secret = crypto.randomBytes(16).toString("hex");
    const targetEmail = realRequest ? user!.email! : `${crypto.randomBytes(4).toString("hex")}@invalid.local`;
    const pending: PendingPasswordReset = {
      userId: realRequest ? user!.id : "__nonexistent__",
      email: targetEmail,
      codeHash: this.hashCode(code, secret),
      secret,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
      verified: false,
      dummy: !realRequest,
    };
    let devVerificationCode: string | undefined;
    if (realRequest) {
      try {
        const delivery = await this.authEmail.sendPasswordResetCode(user!.email!, code);
        devVerificationCode = delivery.devVerificationCode;
        this.recordSend(this.passwordResetSendRate, user!.id);
      } catch {
        // Mail send failed -- downgrade to dummy so we still return constant-shape,
        // but no email will be re-attempted on resend. The user can request again later.
        pending.dummy = true;
        pending.userId = "__nonexistent__";
      }
    }
    this.pendingPasswordResets.set(resetToken, pending);
    return {
      ok: true as const,
      message,
      resetToken,
      emailMasked: this.maskEmail(pending.email),
      ...(devVerificationCode ? { devVerificationCode } : {}),
    };
  }

  async resendMfaCode(payload: { mfaSessionToken: string }) {
    this.pruneRegistrations();
    const pending = this.pendingMfaChallenges.get(payload.mfaSessionToken);
    if (!pending) throw new HttpError(400, "Session expired. Please log in again.");
    const sendRate = this.getSendRate(this.mfaSendRate, pending.userId);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const code = this.generateCode();
    this.recordSend(this.mfaSendRate, pending.userId);
    const delivery = await this.sendMfaCode(pending.email, code);
    pending.codeHash = this.hashCode(code, pending.secret);
    pending.expiresAt = Date.now() + REGISTRATION_CODE_TTL_MS;
    // A fresh code resets the attempt budget — carrying it over made the new
    // code instantly 429 for users who'd mistyped the old one.
    pending.attempts = 0;
    return {
      emailMasked: this.maskEmail(pending.email),
      ...(delivery.devVerificationCode ? { devVerificationCode: delivery.devVerificationCode } : {}),
    };
  }

  async verifyMfaCode(
    payload: { mfaSessionToken: string; code: string; trustDevice?: boolean },
    requestSession: session.Session & Partial<session.SessionData>,
    userAgent?: string,
  ) {
    this.pruneRegistrations();
    const pending = this.pendingMfaChallenges.get(payload.mfaSessionToken);
    if (!pending) throw new HttpError(400, "Session expired. Please log in again.");
    pending.attempts += 1;
    if (pending.attempts > REGISTRATION_MAX_ATTEMPTS) {
      this.pendingMfaChallenges.delete(payload.mfaSessionToken);
      throw new HttpError(429, "Too many attempts. Please log in again.");
    }
    if (!this.verifyCode(payload.code.trim(), pending.codeHash, pending.secret)) throw new HttpError(401, "Invalid code");
    this.pendingMfaChallenges.delete(payload.mfaSessionToken);
    requestSession.userId = pending.userId;
    requestSession.role = pending.role;
    return {
      user: { id: pending.userId, username: pending.username, role: pending.role },
      ...(payload.trustDevice ? { trustedDeviceToken: this.addTrustedDevice(pending.userId, userAgent) } : {}),
    };
  }

  async resendPasswordReset(payload: { resetToken: string }) {
    this.pruneRegistrations();
    const pending = this.pendingPasswordResets.get(payload.resetToken);
    if (!pending) throw new HttpError(400, "Session expired. Please try again.");
    const sendRate = this.getSendRate(this.passwordResetSendRate, pending.userId);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const code = this.generateCode();
    if (pending.dummy) {
      // Dummy entry: skip the real email send. Response shape stays constant.
      return { emailMasked: this.maskEmail(pending.email) };
    }
    this.recordSend(this.passwordResetSendRate, pending.userId);
    const delivery = await this.sendPasswordResetCode(pending.email, code);
    pending.codeHash = this.hashCode(code, pending.secret);
    pending.expiresAt = Date.now() + REGISTRATION_CODE_TTL_MS;
    pending.verified = false;
    pending.attempts = 0;
    return {
      emailMasked: this.maskEmail(pending.email),
      ...(delivery.devVerificationCode ? { devVerificationCode: delivery.devVerificationCode } : {}),
    };
  }

  async verifyPasswordReset(payload: { resetToken: string; code: string }) {
    this.pruneRegistrations();
    const pending = this.pendingPasswordResets.get(payload.resetToken);
    if (!pending) throw new HttpError(400, "Session expired. Please try again.");
    pending.attempts += 1;
    if (pending.attempts > REGISTRATION_MAX_ATTEMPTS) {
      this.pendingPasswordResets.delete(payload.resetToken);
      throw new HttpError(429, "Too many attempts. Please try again.");
    }
    if (!this.verifyCode(payload.code.trim(), pending.codeHash, pending.secret)) throw new HttpError(401, "Invalid code");
    pending.verified = true;
    pending.expiresAt = Date.now() + PASSWORD_RESET_VERIFIED_TTL_MS;
  }

  async resetPassword(payload: { resetToken: string; newPassword: string }) {
    this.pruneRegistrations();
    const pending = this.pendingPasswordResets.get(payload.resetToken);
    if (!pending || !pending.verified) throw new HttpError(400, "Session expired. Please try again.");
    const passwordError = validatePassword(payload.newPassword);
    if (passwordError) throw new HttpError(400, passwordError);
    const user = this.users.findById(pending.userId);
    if (!user) {
      this.pendingPasswordResets.delete(payload.resetToken);
      throw new HttpError(400, "User not found");
    }
    this.users.updatePasswordHash(user.id, await hashPassword(payload.newPassword), new Date().toISOString());
    this.users.updateTrustedDevices(user.id, "[]", new Date().toISOString());
    this.pendingPasswordResets.delete(payload.resetToken);
    return { userId: user.id };
  }

  async requestAccountDeletion(userId: string) {
    this.pruneRegistrations();
    if (!this.authEmail.isAvailable()) throw new HttpError(503, "Account deletion verification is not available");
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    if (!user.email) throw new HttpError(400, "Add an email address before deleting this account");
    const sendRate = this.getSendRate(this.accountDeletionSendRate, user.id);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const code = this.generateCode();
    const deleteToken = crypto.randomBytes(24).toString("hex");
    const secret = crypto.randomBytes(16).toString("hex");
    const pending: PendingAccountDeletion = {
      userId: user.id,
      email: user.email,
      codeHash: this.hashCode(code, secret),
      secret,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
      verified: false,
    };
    const delivery = await this.sendAccountDeletionCode(user.email, code);
    this.pendingAccountDeletions.set(deleteToken, pending);
    this.recordSend(this.accountDeletionSendRate, user.id);
    return {
      deleteToken,
      emailMasked: this.maskEmail(user.email),
      ...(delivery.devVerificationCode ? { devVerificationCode: delivery.devVerificationCode } : {}),
    };
  }

  async resendAccountDeletion(payload: { deleteToken: string }, userId: string) {
    this.pruneRegistrations();
    const pending = this.pendingAccountDeletions.get(payload.deleteToken);
    if (!pending || pending.userId !== userId) throw new HttpError(400, "Delete session expired. Please start again.");
    const sendRate = this.getSendRate(this.accountDeletionSendRate, pending.userId);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const code = this.generateCode();
    this.recordSend(this.accountDeletionSendRate, pending.userId);
    const delivery = await this.sendAccountDeletionCode(pending.email, code);
    pending.codeHash = this.hashCode(code, pending.secret);
    pending.expiresAt = Date.now() + REGISTRATION_CODE_TTL_MS;
    pending.attempts = 0;
    pending.verified = false;
    return {
      emailMasked: this.maskEmail(pending.email),
      ...(delivery.devVerificationCode ? { devVerificationCode: delivery.devVerificationCode } : {}),
    };
  }

  async confirmAccountDeletion(payload: { deleteToken: string; code: string }, userId: string) {
    this.pruneRegistrations();
    const pending = this.pendingAccountDeletions.get(payload.deleteToken);
    if (!pending || pending.userId !== userId) throw new HttpError(400, "Delete session expired. Please start again.");
    pending.attempts += 1;
    if (pending.attempts > REGISTRATION_MAX_ATTEMPTS) {
      this.pendingAccountDeletions.delete(payload.deleteToken);
      throw new HttpError(429, "Too many attempts. Please start again.");
    }
    if (!this.verifyCode(payload.code.trim(), pending.codeHash, pending.secret)) throw new HttpError(401, "Invalid code");
    pending.verified = true;
    pending.expiresAt = Date.now() + ACCOUNT_DELETION_VERIFIED_TTL_MS;
  }


  private trustedDeviceStableId(token: string): number {
    // First 8 hex chars of the stored token → positive int31. Stable across
    // list reloads and TTL prunes, unlike the old array index.
    return Number.parseInt(token.slice(0, 8), 16) & 0x7fffffff;
  }

  listTrustedDevices(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const trustedDevices = this.loadTrustedDevices(user.id, user.trustedDevices);
    return trustedDevices.map((device) => ({
      id: this.trustedDeviceStableId(device.token),
      tokenPreview: `${device.token.slice(0, 8)}...`,
      label: device.label,
      createdAt: device.createdAt,
      lastUsed: device.lastUsed,
    }));
  }

  revokeTrustedDevice(userId: string, deviceId: number) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const trustedDevices = this.loadTrustedDevices(user.id, user.trustedDevices);
    // Match by STABLE id, not array index — a TTL prune or concurrent revoke
    // shifting the list used to make the click remove a different device.
    const idx = trustedDevices.findIndex((device) => this.trustedDeviceStableId(device.token) === deviceId);
    if (idx < 0) throw new HttpError(404, "Device not found");
    trustedDevices.splice(idx, 1);
    this.saveTrustedDevices(user.id, trustedDevices);
  }

  revokeAllTrustedDevices(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const trustedDevices = this.loadTrustedDevices(user.id, user.trustedDevices);
    this.saveTrustedDevices(user.id, []);
    return trustedDevices.length;
  }

  getMfaStatus(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    return {
      enabled: this.shouldRequireMfa(user),
      emailMasked: user.email ? this.maskEmail(user.email) : null,
      emailVerified: Boolean(user.emailVerified),
      trustedDevices: this.listTrustedDevices(userId),
    };
  }

  currentUser(requestSession: session.Session & Partial<session.SessionData>): CurrentUserResponse {
    if (!requestSession.userId) {
      return { authenticated: false, user: null };
    }
    const user = this.users.findById(requestSession.userId);
    if (!user) {
      return { authenticated: false, user: null };
    }
    return {
      authenticated: true,
      user: { id: user.id, username: user.username, role: user.role as "admin" | "user" },
    };
  }

  logout(requestSession: session.Session & Partial<session.SessionData>) {
    requestSession.userId = undefined;
    requestSession.role = undefined;
  }

  async changePassword(userId: string, payload: { currentPassword: string; newPassword: string }) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const passwordError = validatePassword(payload.newPassword);
    if (passwordError) throw new HttpError(400, passwordError);
    const valid = await comparePassword(payload.currentPassword, user.passwordHash);
    if (!valid) throw new HttpError(401, "Current password is incorrect");
    this.users.updatePasswordHash(userId, await hashPassword(payload.newPassword), new Date().toISOString());
  }

  async executeAccountDeletion(userId: string, payload: { deleteToken: string }) {
    this.pruneRegistrations();
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const pending = this.pendingAccountDeletions.get(payload.deleteToken);
    if (!pending || pending.userId !== userId || !pending.verified) throw new HttpError(400, "Delete session expired. Please start again.");
    if (user.role === "admin" && this.users.countAdmins() <= 1) throw new HttpError(400, "Cannot delete the last admin account");
    const images = this.generatedImages.listForUser(userId);
    this.users.deleteAccount(userId);
    this.pendingAccountDeletions.delete(payload.deleteToken);
    // Per-image best-effort: one failed disk unlink shouldn't strand the rest.
    // DB cascade already removed the metadata rows.
    for (const image of images) {
      try { this.imageStore.delete(image.id, image.mimeType); } catch { /* best effort */ }
    }
  }

  private pruneRegistrations() {
    const now = Date.now();
    for (const [token, pending] of this.pendingRegistrations.entries()) {
      if (pending.expiresAt <= now) this.pendingRegistrations.delete(token);
    }
    for (const [email, rate] of this.registrationSendRate.entries()) {
      if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= now) this.registrationSendRate.delete(email);
    }
    for (const [token, pending] of this.pendingPasswordResets.entries()) {
      if (pending.expiresAt <= now) this.pendingPasswordResets.delete(token);
    }
    for (const [userId, rate] of this.passwordResetSendRate.entries()) {
      if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= now) this.passwordResetSendRate.delete(userId);
    }
    for (const [token, pending] of this.pendingMfaChallenges.entries()) {
      if (pending.expiresAt <= now) this.pendingMfaChallenges.delete(token);
    }
    for (const [userId, rate] of this.mfaSendRate.entries()) {
      if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= now) this.mfaSendRate.delete(userId);
    }
    for (const [token, pending] of this.pendingAccountDeletions.entries()) {
      if (pending.expiresAt <= now) this.pendingAccountDeletions.delete(token);
    }
    for (const [userId, rate] of this.accountDeletionSendRate.entries()) {
      if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= now) this.accountDeletionSendRate.delete(userId);
    }
  }

  private generateCode() {
    return crypto.randomInt(100000, 999999).toString();
  }

  private hashCode(code: string, secret: string) {
    return crypto.createHmac("sha256", secret).update(code).digest("hex");
  }

  private verifyCode(code: string, hash: string, secret: string) {
    const candidate = Buffer.from(this.hashCode(code, secret), "hex");
    const target = Buffer.from(hash, "hex");
    return candidate.length === target.length && crypto.timingSafeEqual(candidate, target);
  }

  private maskEmail(email: string) {
    const at = email.indexOf("@");
    if (at <= 0) return "***";
    const local = email.slice(0, at);
    const domain = email.slice(at);
    // Old regex required >=2 leading chars and leaked 1-char local parts
    // entirely (and 2-char ones fully) to unauthenticated callers.
    if (local.length <= 2) return `${local[0] ?? "*"}***${domain}`;
    return `${local.slice(0, 2)}${"*".repeat(Math.max(local.length - 2, 3))}${domain}`;
  }

  private getSendRate(sendRateMap: Map<string, { count: number; windowStart: number }>, key: string) {
    const rate = sendRateMap.get(key);
    if (!rate) return null;
    if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= Date.now()) {
      sendRateMap.delete(key);
      return null;
    }
    return rate;
  }

  private getRegistrationSendRate(email: string) {
    return this.getSendRate(this.registrationSendRate, email);
  }

  private recordSend(sendRateMap: Map<string, { count: number; windowStart: number }>, key: string) {
    const now = Date.now();
    const existing = sendRateMap.get(key);
    // Rolling window: if the existing entry's window has lapsed, start fresh.
    // Previously this only checked via getSendRate which DOES expire stale
    // entries, but the recordSend path then just incremented the count without
    // ever refreshing windowStart -- anchoring the window to the first send and
    // effectively allowing burst timing right at window expiry.
    if (!existing || existing.windowStart + REGISTRATION_SEND_WINDOW_MS <= now) {
      sendRateMap.set(key, { count: 1, windowStart: now });
      return;
    }
    existing.count += 1;
  }

  private recordRegistrationSend(email: string) {
    this.recordSend(this.registrationSendRate, email);
  }

  private async sendRegistrationCode(email: string, code: string) {
    try {
      return await this.authEmail.sendRegistrationCode(email, code);
    } catch (error) {
      throw new HttpError(500, error instanceof Error ? "Failed to send verification email. Try again." : "Registration failed");
    }
  }

  private async sendPasswordResetCode(email: string, code: string) {
    try {
      return await this.authEmail.sendPasswordResetCode(email, code);
    } catch (error) {
      throw new HttpError(500, error instanceof Error ? "Failed to send verification email. Try again." : "Password reset failed");
    }
  }

  private shouldRequireMfa(user: ReturnType<UserRepository["findById"]>) {
    const eligible = Boolean(user?.email && user.emailVerified);
    if (eligible && !this.authEmail.isAvailable()) {
      // Email delivery unconfigured: the verification step CANNOT run, so the
      // sign-in proceeds single-factor. That trade-off is deliberate (the
      // alternative locks every user out on a config regression) but it must
      // never be silent — record it per the no-silent-failures rule.
      recordSystemEvent({
        userId: user!.id,
        source: "pipeline",
        severity: "error",
        message: "email delivery is unconfigured — verification-code sign-in step was skipped for this login",
      });
      return false;
    }
    return eligible && this.authEmail.isAvailable();
  }

  private loadTrustedDevices(userId: string, trustedDevicesRaw: string | null | undefined) {
    const trustedDevices = this.parseTrustedDevices(trustedDevicesRaw).filter((device) => (device.createdAt + TRUST_DEVICE_TTL_MS) > Date.now());
    if (trustedDevices.length !== this.parseTrustedDevices(trustedDevicesRaw).length) this.saveTrustedDevices(userId, trustedDevices);
    return trustedDevices;
  }

  private parseTrustedDevices(trustedDevicesRaw: string | null | undefined): TrustedDeviceRecord[] {
    if (!trustedDevicesRaw) return [];
    try {
      const parsed = JSON.parse(trustedDevicesRaw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((device): device is TrustedDeviceRecord => {
        return Boolean(
          device
          && typeof device === "object"
          && typeof device.token === "string"
          && typeof device.label === "string"
          && typeof device.createdAt === "number"
          && typeof device.lastUsed === "number",
        );
      });
    } catch {
      return [];
    }
  }

  private saveTrustedDevices(userId: string, trustedDevices: TrustedDeviceRecord[]) {
    this.users.updateTrustedDevices(userId, JSON.stringify(trustedDevices), new Date().toISOString());
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token, "hex").digest("hex");
  }

  private useTrustedDevice(userId: string, token: string) {
    const user = this.users.findById(userId);
    if (!user) return false;
    const trustedDevices = this.loadTrustedDevices(user.id, user.trustedDevices);
    const tokenHash = this.hashToken(token);
    const matchedIndex = trustedDevices.findIndex((device) => this.tokensMatch(device.token, tokenHash));
    if (matchedIndex === -1) return false;
    trustedDevices[matchedIndex] = {
      ...trustedDevices[matchedIndex],
      lastUsed: Date.now(),
    };
    this.saveTrustedDevices(user.id, trustedDevices);
    return true;
  }

  private addTrustedDevice(userId: string, userAgent?: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const now = Date.now();
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(token);
    const trustedDevices = this.loadTrustedDevices(user.id, user.trustedDevices);
    trustedDevices.push({
      token: tokenHash,
      label: this.userAgentLabel(userAgent),
      createdAt: now,
      lastUsed: now,
    });
    if (trustedDevices.length > TRUST_DEVICE_MAX_COUNT) {
      trustedDevices.sort((left, right) => left.lastUsed - right.lastUsed);
      trustedDevices.splice(0, trustedDevices.length - TRUST_DEVICE_MAX_COUNT);
    }
    this.saveTrustedDevices(user.id, trustedDevices);
    return token;
  }

  private tokensMatch(left: string, right: string) {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  private userAgentLabel(userAgent?: string) {
    if (!userAgent) return "Unknown device";
    const browser = userAgent.match(/(Chrome|Firefox|Safari|Edge|Opera|Brave)[/\s]?([\d.]*)/)?.[0] ?? "";
    const os = userAgent.match(/(Windows|Mac OS X|Linux|Android|iOS|iPhone)[/\s]?([\d._]*)/)?.[0]?.replace(/_/g, ".") ?? "";
    return [browser, os].filter(Boolean).join(" / ") || userAgent.slice(0, 40);
  }

  private async issueMfaChallenge(user: { id: string; username: string; role: string; email: string }) {
    const sendRate = this.getSendRate(this.mfaSendRate, user.id);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const token = crypto.randomBytes(24).toString("hex");
    const secret = crypto.randomBytes(16).toString("hex");
    const code = this.generateCode();
    const pending: PendingMfaChallenge = {
      userId: user.id,
      username: user.username,
      role: user.role as "admin" | "user",
      email: user.email,
      codeHash: this.hashCode(code, secret),
      secret,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
    };
    const delivery = await this.sendMfaCode(user.email, code);
    this.recordSend(this.mfaSendRate, user.id);
    this.pendingMfaChallenges.set(token, pending);
    return {
      mfaRequired: true as const,
      mfaSessionToken: token,
      emailMasked: this.maskEmail(user.email),
      ...(delivery.devVerificationCode ? { devVerificationCode: delivery.devVerificationCode } : {}),
    };
  }

  private async sendMfaCode(email: string, code: string) {
    try {
      return await this.authEmail.sendMfaCode(email, code);
    } catch (error) {
      throw new HttpError(500, error instanceof Error ? "Failed to send verification email. Try again." : "MFA failed");
    }
  }

  private async sendAccountDeletionCode(email: string, code: string) {
    try {
      return await this.authEmail.sendAccountDeletionCode(email, code);
    } catch (error) {
      throw new HttpError(500, error instanceof Error ? "Failed to send verification email. Try again." : "Account deletion failed");
    }
  }
}
