import crypto from "node:crypto";
import type session from "express-session";

import type { CurrentUserResponse, SecondFactorMethod } from "@tracyhill-rp/contracts";
import { createLogger } from "@tracyhill-rp/logging";

import { comparePassword, hashPassword, validateEmail, validatePassword, validateUsername } from "../../lib/password";
import { HttpError } from "../../lib/httpError";
import { recordSystemEvent, type SystemEventSource } from "../system/systemEvents";
import { createId } from "../../lib/ids";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { UserRepository, type UserCampaignCascade } from "../users/userRepository";
import type { AuthEmailService } from "../../services/authEmail";
import { LEGACY_TWO_FACTOR, type TwoFactorSettings } from "../settings/settingsService";
import { looksLikeRecoveryCode, type TwoFactorService } from "./twoFactorService";
import type { InviteService } from "./inviteService";

const INVITE_CLOSED: Record<"used" | "expired" | "revoked", string> = {
  used: "This invite has already been used.",
  expired: "This invite has expired. Ask for a new one.",
  revoked: "This invite was withdrawn.",
};

const logger = createLogger("auth-service");
// Sign-in / account-security events belong on their own source, not under
// "pipeline".
const AUTH_EVENT_SOURCE: SystemEventSource = "auth";

const PUBLIC_RESET_EMAIL_MASK = "***@***";

const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;
// Pre-computed bcrypt hash of an unguessable constant — used only to equalize
// login timing for unknown usernames. Never matches a real password.
const DUMMY_PASSWORD_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBp4LRHK0H8mX5o0bPLxYy0VVDeOnW";
const REGISTRATION_MAX_ATTEMPTS = 5;
// Wrong second-factor codes one account may spend across all its challenges in a window. Each correct-password sign-in
// opens a fresh challenge with REGISTRATION_MAX_ATTEMPTS tries, so without this budget someone who has the password and
// many source addresses could keep guessing codes. Checked only at the code step, which a wrong password never reaches,
// so the refusal says nothing about the password.
const MFA_ACCOUNT_MAX_FAILURES = 10;
const MFA_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const REGISTRATION_MAX_SENDS = 6;
const REGISTRATION_SEND_WINDOW_MS = 10 * 60 * 1000;
const PASSWORD_RESET_VERIFIED_TTL_MS = 5 * 60 * 1000;
const ACCOUNT_DELETION_VERIFIED_TTL_MS = 5 * 60 * 1000;
const TRUST_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TRUST_DEVICE_MAX_COUNT = 10;
// Setting up an authenticator at sign-in (Required) takes longer than typing a code.
const TWO_FACTOR_SETUP_TTL_MS = 30 * 60 * 1000;

type TrustedDeviceRecord = {
  token: string;
  label: string;
  createdAt: number;
  lastUsed: number;
};

type PendingRegistration = {
  username: string;
  email: string;
  agreedToTerms: boolean;
  passwordHash: string;
  codeHash: string;
  secret: string;
  expiresAt: number;
  attempts: number;
};

type PendingPasswordReset = {
  userId: string;
  credentials: string;
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
  // The send-budget key this token shares with every other request for the
  // same identity: real accounts key on the user id,
  // unresolvable usernames on the case-folded requested name. Keying dummies
  // per TOKEN gave every request a fresh resend budget — a resend on the sixth
  // token answered 429 for a real account and 200 for a nonexistent one.
  rateKey: string;
};

type PendingMfaChallenge = {
  userId: string;
  credentials: string;
  username: string;
  role: "admin" | "user";
  // The verified address email codes go to; null when email codes do not apply to this sign-in.
  email: string | null;
  // What this sign-in accepts: the authenticator, a recovery code, an email code.
  methods: SecondFactorMethod[];
  // The email code, once one was sent.
  codeHash: string | null;
  secret: string | null;
  expiresAt: number;
  attempts: number;
};

// Required two-factor and none set up yet: the account sets up an authenticator before it is signed in.
type PendingTwoFactorSetup = {
  userId: string;
  credentials: string;
  username: string;
  role: "admin" | "user";
  expiresAt: number;
  attempts: number;
};

type PendingAccountDeletion = {
  userId: string;
  credentials: string;
  email: string;
  codeHash: string;
  secret: string;
  expiresAt: number;
  attempts: number;
  verified: boolean;
};

// Authenticated "set / change my email": admin-created
// accounts start with email NULL and previously had NO way to acquire one, which
// permanently locked them out of MFA and the staged self-delete flow. The code
// goes to the NEW address, so a typo can't verify.
type PendingEmailChange = {
  userId: string;
  credentials: string;
  email: string;
  codeHash: string;
  secret: string;
  expiresAt: number;
  attempts: number;
};

export class AuthService {
  private readonly pendingRegistrations = new Map<string, PendingRegistration>();
  private readonly registrationSendRate = new Map<string, { count: number; windowStart: number }>();
  private readonly pendingPasswordResets = new Map<string, PendingPasswordReset>();
  private readonly passwordResetSendRate = new Map<string, { count: number; windowStart: number }>();
  private readonly pendingMfaChallenges = new Map<string, PendingMfaChallenge>();
  private readonly pendingTwoFactorSetups = new Map<string, PendingTwoFactorSetup>();
  private readonly mfaSendRate = new Map<string, { count: number; windowStart: number }>();
  private readonly mfaAccountFailures = new Map<string, { count: number; windowStart: number }>();
  private readonly pendingAccountDeletions = new Map<string, PendingAccountDeletion>();
  private readonly accountDeletionSendRate = new Map<string, { count: number; windowStart: number }>();
  private readonly pendingEmailChanges = new Map<string, PendingEmailChange>();
  private readonly emailChangeSendRate = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly users: UserRepository,
    private readonly generatedImages: GeneratedImageRepository,
    private readonly imageStore: ImageStore,
    private readonly authEmail: AuthEmailService,
    // Campaign-scoped cascade for account deletion — runs the campaign SERVICE
    // delete path per campaign so this path inherits whatever that path learns
    // to clean up. Optional only so unit tests can omit it.
    private readonly deleteUserCampaigns?: UserCampaignCascade,
    // Signs the account out of every subscription provider on the runner, as admin deletion does (AdminService
    // .deleteUser): the runner removes a user's home, and the provider tokens in it, only on logout (2026-10-01).
    private readonly disconnectSubscriptions?: (userId: string) => Promise<void>,
    // The server's sign-up settings (Admin: Server settings → Accounts). Absent in unit tests: sign-up open,
    // terms required, as before the settings existed.
    private readonly signUpPolicy: { registrationOpen(): boolean; termsRequired(): boolean } = { registrationOpen: () => true, termsRequired: () => true },
    // Two-factor: the server's policy and the authenticator store. Absent in unit tests: email codes for
    // verified addresses only, the behavior before the settings existed.
    private readonly twoFactor?: { settings: () => TwoFactorSettings; service: TwoFactorService },
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
    if (!ok || this.credentialFingerprint(this.users.findById(user.id)) !== this.credentialFingerprint(user)) return null;
    const secondFactor = this.secondFactorFor(user);
    if (secondFactor.kind === "challenge") {
      if (trustedDeviceToken && this.useTrustedDevice(user.id, trustedDeviceToken)) {
        requestSession.userId = user.id;
        requestSession.role = user.role as "admin" | "user";
        return { id: user.id, username: user.username, role: user.role as "admin" | "user" };
      }
      requestSession.userId = undefined;
      requestSession.role = undefined;
      return this.issueMfaChallenge(user, secondFactor);
    }
    if (secondFactor.kind === "setup") {
      // A trusted device skips a code, never the setup the server requires.
      requestSession.userId = undefined;
      requestSession.role = undefined;
      return this.issueTwoFactorSetup(user);
    }
    requestSession.userId = user.id;
    requestSession.role = user.role as "admin" | "user";
    return { id: user.id, username: user.username, role: user.role as "admin" | "user" };
  }

  async register(payload: { username: string; email: string; password: string; agreedToTerms?: boolean }, requestSession: session.Session & Partial<session.SessionData>) {
    this.pruneRegistrations();
    if (!this.authEmail.isAvailable()) throw new HttpError(503, "Registration is not available");
    if (!this.signUpPolicy.registrationOpen()) throw new HttpError(403, "Sign-up is closed on this server. Ask the administrator for an account.");
    const username = payload.username.trim();
    const email = payload.email.trim().toLowerCase();
    const usernameError = validateUsername(username);
    if (usernameError) throw new HttpError(400, usernameError);
    const emailError = validateEmail(email);
    if (emailError) throw new HttpError(400, emailError);
    const passwordError = validatePassword(payload.password);
    if (passwordError) throw new HttpError(400, passwordError);
    if (this.signUpPolicy.termsRequired() && !payload.agreedToTerms) throw new HttpError(400, "You must agree to the Terms of Service");
    if (this.users.findByUsername(username)) throw new HttpError(409, "Username already taken");
    if (this.users.findByEmail(email)) throw new HttpError(409, "An account with this email already exists");
    const sendRate = this.getRegistrationSendRate(email);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many attempts. Wait a few minutes.");

    const code = this.generateCode();
    const registrationToken = crypto.randomBytes(24).toString("hex");
    const secret = crypto.randomBytes(16).toString("hex");
    this.recordRegistrationSend(email);
    const passwordHash = await hashPassword(payload.password);
    const pending: PendingRegistration = {
      username,
      email,
      agreedToTerms: Boolean(payload.agreedToTerms),
      passwordHash,
      codeHash: this.hashCode(code, secret),
      secret,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
    };
    const delivery = await this.sendRegistrationCode(email, code);
    this.pendingRegistrations.set(registrationToken, pending);
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
    // Closed between the form and the code: the account is not created.
    if (!this.signUpPolicy.registrationOpen()) {
      this.pendingRegistrations.delete(payload.registrationToken);
      throw new HttpError(403, "Sign-up is closed on this server. Ask the administrator for an account.");
    }
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
      agreedToTerms: pending.agreedToTerms ? 1 : 0,
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
    // One send budget per requested identity whether or not it resolves: the
    // account lookup is COLLATE NOCASE, so the fold mirrors what a real account
    // would share across spellings.
    const rateKey = user ? user.id : `dummy:${username.toLowerCase()}`;
    const sendRate = this.getSendRate(this.passwordResetSendRate, rateKey);
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
      credentials: this.credentialFingerprint(user),
      email: targetEmail,
      codeHash: this.hashCode(code, secret),
      secret,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
      verified: false,
      dummy: !realRequest,
      rateKey,
    };
    let devVerificationCode: string | undefined;
    // Count BEFORE the await on both branches: concurrent requests
    // used to all pass the cap. The same key counts the real send, the
    // budget-exhausted or mail-down dummy for a real account, and the dummy
    // for an unknown username, so the count-to-429 across requests matches.
    this.recordSend(this.passwordResetSendRate, rateKey);
    if (realRequest) {
      try {
        const delivery = await this.authEmail.sendPasswordResetCode(user!.email!, code);
        devVerificationCode = delivery.devVerificationCode;
      } catch (error) {
        // Mail send failed -- downgrade to dummy so we still return constant-shape,
        // but no email will be re-attempted on resend. The user can request again later.
        // Constant-shape to the CALLER is right; silent to the OPERATOR is not:
        // a SendGrid outage used to leave no trace anywhere.
        const reason = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, userId: user!.id }, "password-reset email delivery failed");
        recordSystemEvent({
          userId: user!.id,
          source: AUTH_EVENT_SOURCE,
          severity: "error",
          message: `password-reset email delivery failed: ${reason.slice(0, 200)}`,
        });
        pending.dummy = true;
        pending.userId = "__nonexistent__";
      }
    } else {
      // Equalize timing with the real send path (a SendGrid round-trip)
      // so response latency doesn't classify whether the account exists.
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.floor(Math.random() * 200)));
    }
    this.pendingPasswordResets.set(resetToken, pending);
    return {
      ok: true as const,
      message,
      resetToken,
      // No prefix, length or domain information before identity proof.
      emailMasked: PUBLIC_RESET_EMAIL_MASK,
      ...(devVerificationCode ? { devVerificationCode } : {}),
    };
  }

  async resendMfaCode(payload: { mfaSessionToken: string }) {
    this.pruneRegistrations();
    const pending = this.pendingMfaChallenges.get(payload.mfaSessionToken);
    if (!pending) throw new HttpError(400, "Session expired. Please log in again.");
    // Also how an account with an authenticator asks for an email code instead, where email codes apply.
    if (!pending.methods.includes("email") || !pending.email) throw new HttpError(400, "This sign-in has no email code. Use your authenticator app or a recovery code.");
    const sendRate = this.getSendRate(this.mfaSendRate, pending.userId);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const code = this.generateCode();
    const secret = pending.secret ?? crypto.randomBytes(16).toString("hex");
    this.recordSend(this.mfaSendRate, pending.userId);
    const delivery = await this.sendMfaCode(pending.email, code);
    pending.secret = secret;
    pending.codeHash = this.hashCode(code, secret);
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
    if (this.mfaAccountLocked(pending.userId)) {
      this.pendingMfaChallenges.delete(payload.mfaSessionToken);
      throw new HttpError(429, "Too many wrong codes for this account. Wait 15 minutes, then sign in again.");
    }
    pending.attempts += 1;
    if (pending.attempts > REGISTRATION_MAX_ATTEMPTS) {
      this.pendingMfaChallenges.delete(payload.mfaSessionToken);
      throw new HttpError(429, "Too many attempts. Please log in again.");
    }
    if (!this.acceptSecondFactor(pending, payload.code)) {
      this.recordMfaFailure(pending.userId, pending.username);
      throw new HttpError(401, "Invalid code");
    }
    this.mfaAccountFailures.delete(pending.userId);
    this.pendingMfaChallenges.delete(payload.mfaSessionToken);
    requestSession.userId = pending.userId;
    requestSession.role = pending.role;
    return {
      user: { id: pending.userId, username: pending.username, role: pending.role },
      ...(payload.trustDevice ? { trustedDeviceToken: this.addTrustedDevice(pending.userId, userAgent) } : {}),
    };
  }

  private mfaAccountLocked(userId: string): boolean {
    const entry = this.mfaAccountFailures.get(userId);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > MFA_ACCOUNT_WINDOW_MS) {
      this.mfaAccountFailures.delete(userId);
      return false;
    }
    return entry.count >= MFA_ACCOUNT_MAX_FAILURES;
  }

  private recordMfaFailure(userId: string, username: string) {
    const now = Date.now();
    const entry = this.mfaAccountFailures.get(userId);
    const current = entry && now - entry.windowStart <= MFA_ACCOUNT_WINDOW_MS ? entry : { count: 0, windowStart: now };
    current.count += 1;
    this.mfaAccountFailures.set(userId, current);
    if (current.count === MFA_ACCOUNT_MAX_FAILURES) {
      recordSystemEvent({
        userId,
        source: AUTH_EVENT_SOURCE,
        severity: "warn",
        message: `second-factor codes for ${username} are refused for 15 minutes after ${MFA_ACCOUNT_MAX_FAILURES} wrong codes`,
      });
    }
  }

  async resendPasswordReset(payload: { resetToken: string }) {
    this.pruneRegistrations();
    const pending = this.pendingPasswordResets.get(payload.resetToken);
    if (!pending) throw new HttpError(400, "Session expired. Please try again.");
    // The budget key is the one the request minted (per identity, never per
    // token): a nonexistent username's sixth request must 429 on
    // resend exactly like a real account's sixth.
    const sendRate = this.getSendRate(this.passwordResetSendRate, pending.rateKey);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const code = this.generateCode();
    // The resend used to answer with the full-domain mask
    // (`de***@example.com` vs `a6***@invalid.local`), skip the send-rate counter
    // AND skip the timing-equalizing delay — three tells that undid the
    // enumeration-safe initial request. Both branches now mirror it exactly.
    this.recordSend(this.passwordResetSendRate, pending.rateKey);
    let devVerificationCode: string | undefined;
    if (pending.dummy) {
      // Dummy entry: no real email, but the same latency the real send has.
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.floor(Math.random() * 200)));
    } else {
      const delivery = await this.sendPasswordResetCode(pending.email, code);
      devVerificationCode = delivery.devVerificationCode;
    }
    // Every state transition a real token gets, the dummy gets too:
    // the dummy branch used to return before these, so after a resend a wrong
    // code answered 400 "expired" (dummy) vs 401 (real) once the original TTL
    // lapsed, and five wrong codes then a resend answered 429 vs 401 — status
    // codes that classified whether the username exists.
    pending.codeHash = this.hashCode(code, pending.secret);
    pending.expiresAt = Date.now() + REGISTRATION_CODE_TTL_MS;
    pending.verified = false;
    pending.attempts = 0;
    return {
      emailMasked: PUBLIC_RESET_EMAIL_MASK,
      ...(devVerificationCode ? { devVerificationCode } : {}),
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
    // Consume every existing proof before yielding so two verified tokens cannot
    // race the password hash. In-flight mail remains bound to the old credentials.
    this.invalidateProofs(user.id);
    const passwordHash = await hashPassword(payload.newPassword);
    if (this.credentialFingerprint(this.users.findById(user.id)) !== pending.credentials) {
      throw new HttpError(400, "Credentials changed. Please start again.");
    }
    this.users.updatePasswordHash(user.id, passwordHash, new Date().toISOString());
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
      credentials: this.credentialFingerprint(user),
      email: user.email,
      codeHash: this.hashCode(code, secret),
      secret,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
      verified: false,
    };
    this.recordSend(this.accountDeletionSendRate, user.id);
    const delivery = await this.sendAccountDeletionCode(user.email, code);
    this.pendingAccountDeletions.set(deleteToken, pending);
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

  /**
   * Step 1 of the authenticated email set/change: re-prove the
   * password (the address is the MFA channel, so redirecting it is as
   * sensitive as changing the password), then send a code to the NEW address.
   */
  async requestEmailChange(userId: string, payload: { email: string; currentPassword: string }) {
    this.pruneRegistrations();
    if (!this.authEmail.isAvailable()) throw new HttpError(503, "Email verification is not available");
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const email = payload.email.trim().toLowerCase();
    const emailError = validateEmail(email);
    if (emailError) throw new HttpError(400, emailError);
    const valid = await comparePassword(payload.currentPassword, user.passwordHash);
    if (!valid) throw new HttpError(401, "Current password is incorrect");
    if (user.email === email && user.emailVerified) throw new HttpError(400, "That is already your verified email address");
    const existing = this.users.findByEmail(email);
    if (existing && existing.id !== user.id) throw new HttpError(409, "An account with this email already exists");
    const sendRate = this.getSendRate(this.emailChangeSendRate, user.id);
    if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
    const code = this.generateCode();
    const emailToken = crypto.randomBytes(24).toString("hex");
    const secret = crypto.randomBytes(16).toString("hex");
    const pending: PendingEmailChange = {
      userId: user.id,
      credentials: this.credentialFingerprint(user),
      email,
      codeHash: this.hashCode(code, secret),
      secret,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
    };
    this.recordSend(this.emailChangeSendRate, user.id);
    const delivery = await this.sendEmailChangeCode(email, code);
    this.pendingEmailChanges.set(emailToken, pending);
    return {
      emailToken,
      emailMasked: this.maskEmail(email),
      ...(delivery.devVerificationCode ? { devVerificationCode: delivery.devVerificationCode } : {}),
    };
  }

  /** Step 2: the code proves the caller controls the new inbox → store it verified. */
  async verifyEmailChange(payload: { emailToken: string; code: string }, userId: string) {
    this.pruneRegistrations();
    const pending = this.pendingEmailChanges.get(payload.emailToken);
    if (!pending || pending.userId !== userId) throw new HttpError(400, "Verification expired. Please start again.");
    pending.attempts += 1;
    if (pending.attempts > REGISTRATION_MAX_ATTEMPTS) {
      this.pendingEmailChanges.delete(payload.emailToken);
      throw new HttpError(429, "Too many attempts. Please start again.");
    }
    if (!this.verifyCode(payload.code.trim(), pending.codeHash, pending.secret)) throw new HttpError(401, "Invalid code");
    const existing = this.users.findByEmail(pending.email);
    if (existing && existing.id !== userId) {
      this.pendingEmailChanges.delete(payload.emailToken);
      throw new HttpError(409, "An account with this email already exists");
    }
    this.users.updateEmail(userId, pending.email, 1, new Date().toISOString());
    this.invalidateProofs(userId);
    this.users.updateTrustedDevices(userId, "[]", new Date().toISOString());
    return { emailMasked: this.maskEmail(pending.email) };
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
    const policy = this.twoFactorSettings();
    return {
      // Pure read: the status query must never record the "step was
      // skipped for this login" event — only an actual login does. The server's two-factor policy decides whether
      // email codes apply at all.
      enabled: policy.policy !== "off" && policy.email && this.isMfaEligible(user) && this.authEmail.isAvailable(),
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
    const credentials = this.credentialFingerprint(user);
    if (this.credentialFingerprint(this.users.findById(userId)) !== credentials) throw new HttpError(401, "Credentials changed. Please start again.");
    this.invalidateProofs(userId);
    const passwordHash = await hashPassword(payload.newPassword);
    if (this.credentialFingerprint(this.users.findById(userId)) !== credentials) throw new HttpError(401, "Credentials changed. Please start again.");
    this.users.updatePasswordHash(userId, passwordHash, new Date().toISOString());
    // A self-service password change is the compromise response a user reaches
    // for first; the reset and admin-reset paths already revoke the 30-day
    // MFA-bypassing trusted devices, and this path was the odd one out.
    this.users.updateTrustedDevices(userId, "[]", new Date().toISOString());
  }

  async executeAccountDeletion(userId: string, payload: { deleteToken: string }) {
    this.pruneRegistrations();
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const pending = this.pendingAccountDeletions.get(payload.deleteToken);
    if (!pending || pending.userId !== userId || !pending.verified) throw new HttpError(400, "Delete session expired. Please start again.");
    if (user.role === "admin" && this.users.countAdmins() <= 1) throw new HttpError(400, "Cannot delete the last admin account");
    const images = this.generatedImages.listForUser(userId);
    void this.disconnectSubscriptions?.(userId).catch(() => undefined);
    this.users.deleteAccount(userId, this.deleteUserCampaigns);
    this.invalidateProofs(userId);
    // Per-image best-effort: one failed disk unlink shouldn't strand the rest.
    // DB cascade already removed the metadata rows.
    for (const image of images) {
      try { this.imageStore.delete(image.id, image.mimeType); } catch { /* best effort */ }
    }
  }

  private credentialFingerprint(user: { passwordHash: string; email?: string | null; emailVerified?: number | null } | null | undefined): string {
    return user ? crypto.createHash("sha256").update(JSON.stringify([user.passwordHash, user.email ?? null, user.emailVerified ?? 0])).digest("hex") : "";
  }

  private invalidateProofs(userId: string) {
    for (const pendingMap of [this.pendingPasswordResets, this.pendingMfaChallenges, this.pendingAccountDeletions, this.pendingEmailChanges, this.pendingTwoFactorSetups]) {
      for (const [token, pending] of pendingMap) if (pending.userId === userId) pendingMap.delete(token);
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
      if (pending.expiresAt <= now || (!pending.dummy && pending.credentials !== this.credentialFingerprint(this.users.findById(pending.userId)))) this.pendingPasswordResets.delete(token);
    }
    for (const [userId, rate] of this.passwordResetSendRate.entries()) {
      if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= now) this.passwordResetSendRate.delete(userId);
    }
    for (const [token, pending] of this.pendingMfaChallenges.entries()) {
      if (pending.expiresAt <= now || pending.credentials !== this.credentialFingerprint(this.users.findById(pending.userId))) this.pendingMfaChallenges.delete(token);
    }
    for (const [userId, rate] of this.mfaSendRate.entries()) {
      if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= now) this.mfaSendRate.delete(userId);
    }
    for (const [token, pending] of this.pendingTwoFactorSetups.entries()) {
      if (pending.expiresAt <= now || pending.credentials !== this.credentialFingerprint(this.users.findById(pending.userId))) this.pendingTwoFactorSetups.delete(token);
    }
    for (const [token, pending] of this.pendingAccountDeletions.entries()) {
      if (pending.expiresAt <= now || pending.credentials !== this.credentialFingerprint(this.users.findById(pending.userId))) this.pendingAccountDeletions.delete(token);
    }
    for (const [userId, rate] of this.accountDeletionSendRate.entries()) {
      if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= now) this.accountDeletionSendRate.delete(userId);
    }
    for (const [token, pending] of this.pendingEmailChanges.entries()) {
      if (pending.expiresAt <= now || pending.credentials !== this.credentialFingerprint(this.users.findById(pending.userId))) this.pendingEmailChanges.delete(token);
    }
    for (const [userId, rate] of this.emailChangeSendRate.entries()) {
      if ((rate.windowStart + REGISTRATION_SEND_WINDOW_MS) <= now) this.emailChangeSendRate.delete(userId);
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

  /** Pure: does this account qualify for the email second factor at all? */
  private isMfaEligible(user: ReturnType<UserRepository["findById"]>) {
    return Boolean(user?.email && user.emailVerified);
  }

  /** Login-path only: the event below must never fire from a status read. */
  private requireMfaForLogin(user: ReturnType<UserRepository["findById"]>) {
    const eligible = this.isMfaEligible(user);
    if (eligible && !this.authEmail.isAvailable()) {
      // Email delivery unconfigured: the verification step CANNOT run, so the
      // sign-in proceeds single-factor. That trade-off is deliberate (the
      // alternative locks every user out on a config regression) but it must
      // never be silent — record it per the no-silent-failures rule.
      recordSystemEvent({
        userId: user!.id,
        source: AUTH_EVENT_SOURCE,
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

  /**
   * What this sign-in asks for after the password. Login-path only: the email-skipped event inside
   * requireMfaForLogin must never fire from a status read.
   */
  private secondFactorFor(user: NonNullable<ReturnType<UserRepository["findById"]>>): { kind: "none" } | { kind: "setup" } | { kind: "challenge"; totp: boolean; email: boolean } {
    const policy = this.twoFactorSettings();
    if (policy.policy === "off") return { kind: "none" };
    const totp = policy.totp && Boolean(this.twoFactor?.service.isEnabled(user.id));
    const email = policy.email && this.requireMfaForLogin(user);
    if (totp || email) return { kind: "challenge", totp, email };
    return policy.policy === "required" && this.twoFactor ? { kind: "setup" } : { kind: "none" };
  }

  private twoFactorSettings(): TwoFactorSettings {
    return this.twoFactor?.settings() ?? LEGACY_TWO_FACTOR;
  }

  private requireTwoFactorService(): TwoFactorService {
    if (!this.twoFactor) throw new HttpError(503, "Two-factor is not available on this server");
    return this.twoFactor.service;
  }

  private async issueMfaChallenge(user: { id: string; username: string; role: string; email: string | null; passwordHash: string; emailVerified?: number | null }, factors: { totp: boolean; email: boolean }) {
    const token = crypto.randomBytes(24).toString("hex");
    const methods: SecondFactorMethod[] = [...(factors.totp ? ["totp", "recovery"] as const : []), ...(factors.email ? ["email"] as const : [])];
    const pending: PendingMfaChallenge = {
      userId: user.id,
      credentials: this.credentialFingerprint(user),
      username: user.username,
      role: user.role as "admin" | "user",
      email: factors.email ? user.email : null,
      methods,
      codeHash: null,
      secret: null,
      expiresAt: Date.now() + REGISTRATION_CODE_TTL_MS,
      attempts: 0,
    };
    let devVerificationCode: string | undefined;
    // An account whose only factor is email gets its code at once, exactly as before authenticators (an older app
    // expects it). One with an authenticator is asked for that code first and requests an email code only if it wants
    // one.
    if (factors.email && !factors.totp && user.email) {
      const sendRate = this.getSendRate(this.mfaSendRate, user.id);
      if (sendRate && sendRate.count >= REGISTRATION_MAX_SENDS) throw new HttpError(429, "Too many codes sent. Wait a few minutes.");
      const secret = crypto.randomBytes(16).toString("hex");
      const code = this.generateCode();
      this.recordSend(this.mfaSendRate, user.id);
      const delivery = await this.sendMfaCode(user.email, code);
      pending.secret = secret;
      pending.codeHash = this.hashCode(code, secret);
      devVerificationCode = delivery.devVerificationCode;
    }
    this.pendingMfaChallenges.set(token, pending);
    const emailSent = pending.codeHash !== null;
    return {
      mfaRequired: true as const,
      mfaSessionToken: token,
      emailMasked: emailSent && user.email ? this.maskEmail(user.email) : "",
      methods,
      emailSent,
      ...(devVerificationCode ? { devVerificationCode } : {}),
    };
  }

  /** An authenticator code (each step once), a recovery code (each once), or the email code this sign-in sent. */
  private acceptSecondFactor(pending: PendingMfaChallenge, typed: string): boolean {
    const code = typed.trim();
    const service = this.twoFactor?.service;
    if (service && pending.methods.includes("totp") && /^\d{6}$/.test(code.replace(/\s/g, "")) && service.verifyCode(pending.userId, code)) return true;
    if (service && pending.methods.includes("recovery") && looksLikeRecoveryCode(code) && service.useRecoveryCode(pending.userId, code)) return true;
    return Boolean(pending.codeHash && pending.secret && this.verifyCode(code, pending.codeHash, pending.secret));
  }

  private issueTwoFactorSetup(user: { id: string; username: string; role: string; email?: string | null; passwordHash: string; emailVerified?: number | null }) {
    const token = crypto.randomBytes(24).toString("hex");
    this.pendingTwoFactorSetups.set(token, {
      userId: user.id,
      credentials: this.credentialFingerprint(user),
      username: user.username,
      role: user.role as "admin" | "user",
      expiresAt: Date.now() + TWO_FACTOR_SETUP_TTL_MS,
      attempts: 0,
    });
    return { twoFactorSetupRequired: true as const, setupToken: token };
  }

  private pendingSetup(setupToken: string): PendingTwoFactorSetup {
    this.pruneRegistrations();
    const pending = this.pendingTwoFactorSetups.get(setupToken);
    if (!pending) throw new HttpError(400, "Setup expired. Please sign in again.");
    return pending;
  }

  /** Required two-factor at sign-in: a new authenticator secret for the account the setup token belongs to. */
  startForcedTwoFactorSetup(payload: { setupToken: string }) {
    const pending = this.pendingSetup(payload.setupToken);
    return this.requireTwoFactorService().startSetup(pending.userId, pending.username);
  }

  /** Confirms the new authenticator with a current code, and signs the account in. */
  confirmForcedTwoFactorSetup(
    payload: { setupToken: string; code: string; trustDevice?: boolean },
    requestSession: session.Session & Partial<session.SessionData>,
    userAgent?: string,
  ) {
    const pending = this.pendingSetup(payload.setupToken);
    pending.attempts += 1;
    if (pending.attempts > REGISTRATION_MAX_ATTEMPTS) {
      this.pendingTwoFactorSetups.delete(payload.setupToken);
      throw new HttpError(429, "Too many attempts. Please sign in again.");
    }
    const recoveryCodes = this.requireTwoFactorService().confirmSetup(pending.userId, payload.code);
    this.pendingTwoFactorSetups.delete(payload.setupToken);
    requestSession.userId = pending.userId;
    requestSession.role = pending.role;
    return {
      user: { id: pending.userId, username: pending.username, role: pending.role },
      recoveryCodes,
      ...(payload.trustDevice ? { trustedDeviceToken: this.addTrustedDevice(pending.userId, userAgent) } : {}),
    };
  }

  /** Public: what the invite page needs before its form. */
  peekInvite(token: string, invites: InviteService) {
    const invite = invites.find(token);
    const termsRequired = this.signUpPolicy.termsRequired();
    if (!invite) return { valid: false, username: null, termsRequired, reason: "This invite link is not valid." };
    if (invite.status !== "open") return { valid: false, username: null, termsRequired, reason: INVITE_CLOSED[invite.status] };
    return { valid: true, username: invite.username, termsRequired, reason: null };
  }

  /**
   * An invite link creates the person's account with their own password, then signs them in, or, under Required
   * two-factor, hands them to authenticator setup as a sign-in would.
   */
  async acceptInvite(
    payload: { token: string; username: string; password: string; agreedToTerms?: boolean },
    invites: InviteService,
    requestSession: session.Session & Partial<session.SessionData>,
  ) {
    const invite = invites.find(payload.token);
    if (!invite) throw new HttpError(404, "This invite link is not valid.");
    if (invite.status !== "open") throw new HttpError(410, INVITE_CLOSED[invite.status]);
    const username = (invite.username ?? payload.username).trim();
    const usernameError = validateUsername(username);
    if (usernameError) throw new HttpError(400, usernameError);
    const passwordError = validatePassword(payload.password);
    if (passwordError) throw new HttpError(400, passwordError);
    if (this.signUpPolicy.termsRequired() && !payload.agreedToTerms) throw new HttpError(400, "You must agree to the Terms of Service");
    if (this.users.findByUsername(username)) throw new HttpError(409, "Username already taken");
    const passwordHash = await hashPassword(payload.password);
    const now = new Date().toISOString();
    const id = createId();
    const created = invites.acceptWith(payload.token, {
      id,
      username,
      email: null,
      emailVerified: 0,
      agreedToTerms: payload.agreedToTerms ? 1 : 0,
      trustedDevices: "[]",
      role: invite.role,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    if (!created) throw new HttpError(410, "This invite was used or withdrawn while the form was open.");
    const user = this.users.findById(id)!;
    if (this.secondFactorFor(user).kind === "setup") {
      requestSession.userId = undefined;
      requestSession.role = undefined;
      return this.issueTwoFactorSetup(user);
    }
    requestSession.userId = id;
    requestSession.role = invite.role;
    return { id, username, role: invite.role };
  }

  /** The signed-in account's two-factor, and what the server allows. */
  twoFactorStatus(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    const policy = this.twoFactorSettings();
    return {
      policy: policy.policy,
      methods: { totp: policy.totp, email: policy.email },
      totp: this.twoFactor?.service.status(userId) ?? { enabled: false, recoveryCodesLeft: 0 },
      email: { active: policy.policy !== "off" && policy.email && this.isMfaEligible(user) && this.authEmail.isAvailable() },
    };
  }

  async startTotp(userId: string, password: string) {
    const user = await this.requirePassword(userId, password);
    if (!this.twoFactorSettings().totp) throw new HttpError(409, "The authenticator app method is off on this server.");
    return this.requireTwoFactorService().startSetup(userId, user.username);
  }

  confirmTotp(userId: string, code: string) {
    return this.requireTwoFactorService().confirmSetup(userId, code);
  }

  async disableTotp(userId: string, password: string, code: string) {
    await this.requirePassword(userId, password);
    if (this.twoFactorSettings().policy === "required") {
      throw new HttpError(409, "Two-factor is required on this server. Set up a new authenticator instead of turning it off.");
    }
    const service = this.requireTwoFactorService();
    if (!service.isEnabled(userId)) throw new HttpError(400, "No authenticator is set up.");
    if (!service.verifyCode(userId, code) && !service.useRecoveryCode(userId, code)) throw new HttpError(401, "That code is not right.");
    service.remove(userId);
  }

  async regenerateRecoveryCodes(userId: string, password: string) {
    await this.requirePassword(userId, password);
    return this.requireTwoFactorService().regenerateRecoveryCodes(userId);
  }

  /** A lost phone (an administrator, or the recovery command): no authenticator, no recovery codes, no trusted devices. */
  resetTwoFactor(userId: string) {
    if (!this.users.findById(userId)) throw new HttpError(404, "user not found");
    this.requireTwoFactorService().remove(userId);
    this.saveTrustedDevices(userId, []);
    for (const [token, pending] of this.pendingMfaChallenges) if (pending.userId === userId) this.pendingMfaChallenges.delete(token);
  }

  private async requirePassword(userId: string, password: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(404, "user not found");
    if (!(await comparePassword(password, user.passwordHash))) throw new HttpError(401, "That password is not right.");
    return user;
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

  private async sendEmailChangeCode(email: string, code: string) {
    try {
      return await this.authEmail.sendEmailChangeCode(email, code);
    } catch (error) {
      throw new HttpError(500, error instanceof Error ? "Failed to send verification email. Try again." : "Email change failed");
    }
  }
}
