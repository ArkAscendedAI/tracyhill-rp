import type { RequestHandler } from "express";

import { checkLoginRateLimit, recordLoginFailure, clearLoginFailures, checkEndpointRateLimit, recordEndpointAttempt, type EndpointRateLimitBucket } from "../middleware/loginRateLimiter";

import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  confirmAccountDeletionRequestSchema,
  confirmForcedTwoFactorSetupRequestSchema,
  confirmTotpRequestSchema,
  disableTotpRequestSchema,
  regenerateRecoveryCodesRequestSchema,
  startForcedTwoFactorSetupRequestSchema,
  startTotpRequestSchema,
  executeAccountDeletionRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  requestEmailChangeRequestSchema,
  resendAccountDeletionRequestSchema,
  registerRequestSchema,
  resendMfaCodeRequestSchema,
  resendRegistrationRequestSchema,
  resendPasswordResetRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailChangeRequestSchema,
  verifyMfaCodeRequestSchema,
  verifyPasswordResetRequestSchema,
  verifyRegistrationRequestSchema,
} from "@tracyhill-rp/contracts";

import { createLogger } from "@tracyhill-rp/logging";

import type { AuditService } from "../../domain/audit/auditService";
import type { AuthService } from "../../domain/auth/authService";
import type { InviteService } from "../../domain/auth/inviteService";
import { stampSessionExpiry } from "../../services/sessionCookie";
import type { SqliteSessionStore } from "../../services/sqliteSessionStore";
import { getAuditContext } from "../auditContext";
import { describeIssues } from "../describeIssues";

const TRUST_COOKIE = "trp.trust";
const logger = createLogger("auth-controller");

function parseTrustToken(cookieHeader?: string) {
  const match = cookieHeader?.match(/(?:^|;\s*)trp\.trust=([a-f0-9]{64})/);
  return match?.[1] ?? null;
}

function setTrustCookie(res: Parameters<RequestHandler>[1], req: Parameters<RequestHandler>[0], token: string) {
  res.cookie(TRUST_COOKIE, token, {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    // req.secure reads X-Forwarded-Proto only from the proxies TRUST_PROXY names, never from the client itself.
    secure: req.secure,
    sameSite: "lax",
    path: "/",
  });
}

export function createAuthController(authService: AuthService, audit?: AuditService, sessionStore?: SqliteSessionStore, invites?: InviteService) {
  // Per-IP, per-flow budget on EVERY step of the code flows: the
  // verify/resend/reset steps used to have no limiter at
  // all, so the unauthenticated resend was the enumeration oracle and the
  // 5-attempts-per-code cap was the only thing standing in front of a guess.
  // Returns true when the caller has already been answered with a 429.
  const rateLimited = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], bucket: EndpointRateLimitBucket) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const rateLimitError = checkEndpointRateLimit(ip, bucket);
    if (rateLimitError) { res.status(429).json({ error: rateLimitError }); return true; }
    recordEndpointAttempt(ip, bucket);
    return false;
  };

  const register: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "registration")) return;
      const parsed = registerRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        // Every refusal in this controller names the field and the reason after the old prefix (the auth routes
        // included). These schemas only
        // check presence and type, and Zod's messages never quote a value, so no password, code or token is echoed.
        res.status(400).json({ error: `invalid registration request: ${describeIssues(parsed.error)}` });
        return;
      }
      const registration = await authService.register(parsed.data, req.session);
      res.status(201).json({ ok: true, ...registration });
    } catch (error) {
      next(error);
    }
  };

  const verifyRegistration: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "registration")) return;
      const parsed = verifyRegistrationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid registration verification request: ${describeIssues(parsed.error)}` });
        return;
      }
      const user = await authService.verifyRegistration(parsed.data, req.session);
      await regenerateAuthedSession(req);
      res.json({ ok: true, user });
    } catch (error) {
      next(error);
    }
  };

  const resendRegistration: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "registration")) return;
      const parsed = resendRegistrationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid registration resend request: ${describeIssues(parsed.error)}` });
        return;
      }
      const resend = await authService.resendRegistration(parsed.data);
      res.json({ ok: true, ...resend });
    } catch (error) {
      next(error);
    }
  };

  const forgotPassword: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "password-reset")) return;
      const parsed = forgotPasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid forgot-password request: ${describeIssues(parsed.error)}` });
        return;
      }
      const response = await authService.requestPasswordReset(parsed.data);
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  const resendPasswordReset: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "password-reset")) return;
      const parsed = resendPasswordResetRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid password-reset resend request: ${describeIssues(parsed.error)}` });
        return;
      }
      const resend = await authService.resendPasswordReset(parsed.data);
      res.json({ ok: true, ...resend });
    } catch (error) {
      next(error);
    }
  };

  const verifyPasswordReset: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "password-reset")) return;
      const parsed = verifyPasswordResetRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid password-reset verification request: ${describeIssues(parsed.error)}` });
        return;
      }
      await authService.verifyPasswordReset(parsed.data);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };

  const resetPassword: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "password-reset")) return;
      const parsed = resetPasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid password-reset request: ${describeIssues(parsed.error)}` });
        return;
      }
      const { userId } = await authService.resetPassword(parsed.data);
      // A compromised-account reset must invalidate the attacker's live
      // sessions — they used to survive for up to 7 days.
      try { sessionStore?.destroyByUserId(userId); } catch { /* best effort */ }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };

  // Session-fixation protection shared by every path that elevates a session
  // to authenticated: login, MFA verify and registration verify. The MFA and
  // registration verify paths did NOT regenerate at first — and MFA-enabled
  // accounts always authenticate via the MFA path, so the protection was absent
  // exactly where it mattered. regenerate() builds a fresh cookie from the
  // 24-hour maxAge option, so the 3 AM anchor is re-stamped here before the
  // explicit save; the store row derives expired_at from it.
  // Explicit save so the new session ID is persisted before we send the
  // response -- res.json could otherwise close the connection before
  // express-session's implicit on-finish save runs, leaving the user having
  // to log in again.
  const regenerateAuthedSession = async (req: Parameters<RequestHandler>[0]) => {
    const userId = req.session.userId;
    const role = req.session.role;
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => { if (err) reject(err); else resolve(); });
    });
    req.session.userId = userId;
    req.session.role = role;
    stampSessionExpiry(req.session);
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => { if (err) reject(err); else resolve(); });
    });
  };

  const login: RequestHandler = async (req, res, next) => {
    try {
      const parsed = loginRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid login request: ${describeIssues(parsed.error)}` });
        return;
      }
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const rateLimitError = checkLoginRateLimit(ip, parsed.data.username);
      if (rateLimitError) { res.status(429).json({ error: rateLimitError }); return; }
      const user = await authService.login(parsed.data, req.session, parseTrustToken(req.headers.cookie));
      if (!user) {
        recordLoginFailure(ip, parsed.data.username);
        res.status(401).json({ error: "invalid credentials" });
        return;
      }
      clearLoginFailures(ip, parsed.data.username);
      // A second factor to enter, or (Required) an authenticator to set up first: not signed in yet.
      if ("mfaRequired" in user || "twoFactorSetupRequired" in user) {
        res.json(user);
        return;
      }
      // session fixation protection: regenerate session after successful auth.
      await regenerateAuthedSession(req);
      res.json({ ok: true, user });
    } catch (error) {
      next(error);
    }
  };

  const resendMfaCode: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "mfa")) return;
      const parsed = resendMfaCodeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid mfa resend request: ${describeIssues(parsed.error)}` });
        return;
      }
      const resend = await authService.resendMfaCode(parsed.data);
      res.json({ ok: true, ...resend });
    } catch (error) {
      next(error);
    }
  };

  const verifyMfaCode: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "mfa")) return;
      const parsed = verifyMfaCodeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid mfa verification request: ${describeIssues(parsed.error)}` });
        return;
      }
      const result = await authService.verifyMfaCode(parsed.data, req.session, req.headers["user-agent"]);
      await regenerateAuthedSession(req);
      if (result.trustedDeviceToken) setTrustCookie(res, req, result.trustedDeviceToken);
      res.json({ ok: true, user: result.user });
    } catch (error) {
      next(error);
    }
  };

  // Required two-factor at sign-in: the setup token from the sign-in response stands in for the session.
  const startForcedTwoFactorSetup: RequestHandler = (req, res, next) => {
    try {
      if (rateLimited(req, res, "mfa")) return;
      const parsed = startForcedTwoFactorSetupRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid two-factor setup request: ${describeIssues(parsed.error)}` });
        return;
      }
      res.json(authService.startForcedTwoFactorSetup(parsed.data));
    } catch (error) {
      next(error);
    }
  };

  const confirmForcedTwoFactorSetup: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "mfa")) return;
      const parsed = confirmForcedTwoFactorSetupRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid two-factor setup request: ${describeIssues(parsed.error)}` });
        return;
      }
      const result = authService.confirmForcedTwoFactorSetup(parsed.data, req.session, req.headers["user-agent"]);
      await regenerateAuthedSession(req);
      if (result.trustedDeviceToken) setTrustCookie(res, req, result.trustedDeviceToken);
      audit?.record({ ...getAuditContext(req, res, { targetType: "user", targetId: result.user.id }), action: "account.two_factor.enabled", metadata: { atSignIn: true } });
      res.json({ ok: true, user: result.user, recoveryCodes: result.recoveryCodes });
    } catch (error) {
      next(error);
    }
  };

  const getTwoFactorStatus: RequestHandler = (req, res, next) => {
    try {
      res.json(authService.twoFactorStatus(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const startTotp: RequestHandler = async (req, res, next) => {
    try {
      const parsed = startTotpRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid authenticator setup request: ${describeIssues(parsed.error)}` });
        return;
      }
      res.json(await authService.startTotp(req.session.userId!, parsed.data.password));
    } catch (error) {
      next(error);
    }
  };

  const confirmTotp: RequestHandler = (req, res, next) => {
    try {
      const parsed = confirmTotpRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid authenticator confirmation request: ${describeIssues(parsed.error)}` });
        return;
      }
      const recoveryCodes = authService.confirmTotp(req.session.userId!, parsed.data.code);
      audit?.record({ ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }), action: "account.two_factor.enabled" });
      res.json({ ok: true, recoveryCodes });
    } catch (error) {
      next(error);
    }
  };

  const disableTotp: RequestHandler = async (req, res, next) => {
    try {
      const parsed = disableTotpRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid authenticator removal request: ${describeIssues(parsed.error)}` });
        return;
      }
      await authService.disableTotp(req.session.userId!, parsed.data.password, parsed.data.code);
      audit?.record({ ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }), action: "account.two_factor.disabled" });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };

  const regenerateRecoveryCodes: RequestHandler = async (req, res, next) => {
    try {
      const parsed = regenerateRecoveryCodesRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid recovery codes request: ${describeIssues(parsed.error)}` });
        return;
      }
      const recoveryCodes = await authService.regenerateRecoveryCodes(req.session.userId!, parsed.data.password);
      audit?.record({ ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }), action: "account.two_factor.recovery_codes_replaced" });
      res.json({ ok: true, recoveryCodes });
    } catch (error) {
      next(error);
    }
  };

  // Invite links: public, and on the registration budget like the sign-up they replace.
  const peekInvite: RequestHandler = (req, res, next) => {
    try {
      if (rateLimited(req, res, "registration")) return;
      if (!invites) { res.status(503).json({ error: "Invites are not available on this server" }); return; }
      res.json(authService.peekInvite(String(req.params.token), invites));
    } catch (error) {
      next(error);
    }
  };

  const acceptInvite: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "registration")) return;
      if (!invites) { res.status(503).json({ error: "Invites are not available on this server" }); return; }
      const parsed = acceptInviteRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid invite request: ${describeIssues(parsed.error)}` });
        return;
      }
      const result = await authService.acceptInvite(parsed.data, invites, req.session);
      if ("twoFactorSetupRequired" in result) {
        res.json(result);
        return;
      }
      await regenerateAuthedSession(req);
      audit?.record({ ...getAuditContext(req, res, { targetType: "user", targetId: result.id }), action: "account.invite_accepted", metadata: { role: result.role } });
      res.status(201).json({ ok: true, user: result });
    } catch (error) {
      next(error);
    }
  };

  const logout: RequestHandler = (req, res, next) => {
    authService.logout(req.session);
    req.session.destroy((err) => {
      if (err) return next(err);
      // Deliberately KEEP the trust cookie: device trust outlives the session
      // (clearing it forced full MFA on every sign-out while the server-side
      // record stayed valid as a phantom entry).
      res.json({ ok: true });
    });
  };

  const me: RequestHandler = (req, res) => {
    res.json(authService.currentUser(req.session));
  };

  const changePassword: RequestHandler = async (req, res, next) => {
    try {
      const parsed = changePasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid password change request: ${describeIssues(parsed.error)}` });
        return;
      }
      await authService.changePassword(req.session.userId!, parsed.data);
      // Revoke every OTHER session — a password change should cut off anyone
      // else holding a cookie, while keeping the changer signed in.
      try { sessionStore?.destroyByUserId(req.session.userId!, req.session.id); } catch { /* best effort */ }
      audit?.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }),
        action: "account.password.changed",
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };

  const requestAccountDeletion: RequestHandler = async (req, res, next) => {
    try {
      const deletion = await authService.requestAccountDeletion(req.session.userId!);
      audit?.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }),
        action: "account.delete.requested",
      });
      res.status(201).json({ ok: true, ...deletion });
    } catch (error) {
      next(error);
    }
  };

  const resendAccountDeletion: RequestHandler = async (req, res, next) => {
    try {
      const parsed = resendAccountDeletionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid account deletion resend request: ${describeIssues(parsed.error)}` });
        return;
      }
      const resend = await authService.resendAccountDeletion(parsed.data, req.session.userId!);
      audit?.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }),
        action: "account.delete.code_resent",
      });
      res.json({ ok: true, ...resend });
    } catch (error) {
      next(error);
    }
  };

  const confirmAccountDeletion: RequestHandler = async (req, res, next) => {
    try {
      const parsed = confirmAccountDeletionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid account deletion confirmation request: ${describeIssues(parsed.error)}` });
        return;
      }
      await authService.confirmAccountDeletion(parsed.data, req.session.userId!);
      audit?.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }),
        action: "account.delete.confirmed",
      });
      res.json({ ok: true, verified: true });
    } catch (error) {
      next(error);
    }
  };

  const executeAccountDeletion: RequestHandler = async (req, res, next) => {
    try {
      const parsed = executeAccountDeletionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid account deletion execute request: ${describeIssues(parsed.error)}` });
        return;
      }
      const userId = req.session.userId!;
      await authService.executeAccountDeletion(userId, parsed.data);
      // The account is gone from here on: everything below is best effort and
      // must never turn the answer into a 500. The eviction used to
      // be unguarded (its siblings at logout/reset/admin are wrapped), so a
      // SQLITE_BUSY on the store's second connection answered "internal error"
      // for a deletion that had already happened, skipped the audit row and
      // left the requesting cookie alive.
      try {
        audit?.record({
          ...getAuditContext(req, res, { targetType: "user", targetId: userId }),
          action: "account.deleted",
        });
      } catch (err) { logger.warn({ err, userId }, "account.deleted audit record failed after the account was removed"); }
      try { sessionStore?.destroyByUserId(userId); } catch (err) { logger.warn({ err, userId }, "session eviction failed after account deletion (rows expire on their own)"); }
      req.session.destroy((err) => {
        if (err) logger.warn({ err, userId }, "request session destroy failed after account deletion");
        res.clearCookie("trp.sid");
        res.clearCookie(TRUST_COOKIE, { path: "/" });
        res.json({ ok: true });
      });
    } catch (error) {
      next(error);
    }
  };

  const requestEmailChange: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "email-change")) return;
      const parsed = requestEmailChangeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid email change request: ${describeIssues(parsed.error)}` });
        return;
      }
      const change = await authService.requestEmailChange(req.session.userId!, parsed.data);
      audit?.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }),
        action: "account.email.change_requested",
      });
      res.status(201).json({ ok: true, ...change });
    } catch (error) {
      next(error);
    }
  };

  const verifyEmailChange: RequestHandler = async (req, res, next) => {
    try {
      if (rateLimited(req, res, "email-change")) return;
      const parsed = verifyEmailChangeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid email verification request: ${describeIssues(parsed.error)}` });
        return;
      }
      const result = await authService.verifyEmailChange(parsed.data, req.session.userId!);
      // Audit metadata deliberately carries no address — the log is admin-visible.
      audit?.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }),
        action: "account.email.changed",
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  };

  const getTrustedDevices: RequestHandler = (req, res, next) => {
    try {
      res.json({ trustedDevices: authService.listTrustedDevices(req.session.userId!) });
    } catch (error) {
      next(error);
    }
  };

  const getMfaStatus: RequestHandler = (req, res, next) => {
    try {
      res.json(authService.getMfaStatus(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const revokeTrustedDevice: RequestHandler = (req, res, next) => {
    try {
      const deviceId = Number(req.params.deviceId);
      if (!Number.isInteger(deviceId) || deviceId < 0) {
        // A path parameter, not a body: the rule it breaks is named in describeIssues' form.
        res.status(400).json({ error: `invalid trusted device id: ${describeIssues({ issues: [{ path: ["deviceId"], message: "Expected a whole number of 0 or more" }] })}` });
        return;
      }
      authService.revokeTrustedDevice(req.session.userId!, deviceId);
      audit?.record({
        ...getAuditContext(req, res, { targetType: "trusted-device", targetId: String(deviceId) }),
        action: "account.mfa.trusted_device_revoked",
        metadata: { deviceId },
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  };

  const revokeAllTrustedDevices: RequestHandler = (req, res, next) => {
    try {
      const removed = authService.revokeAllTrustedDevices(req.session.userId!);
      audit?.record({
        ...getAuditContext(req, res, { targetType: "trusted-device", targetId: "all" }),
        action: "account.mfa.trusted_devices_revoked",
        metadata: { removed },
      });
      res.json({ ok: true, removed });
    } catch (error) {
      next(error);
    }
  };

  return {
    register,
    verifyRegistration,
    resendRegistration,
    forgotPassword,
    resendPasswordReset,
    verifyPasswordReset,
    resetPassword,
    resendMfaCode,
    verifyMfaCode,
    login,
    logout,
    me,
    changePassword,
    requestAccountDeletion,
    resendAccountDeletion,
    confirmAccountDeletion,
    executeAccountDeletion,
    requestEmailChange,
    verifyEmailChange,
    getMfaStatus,
    getTrustedDevices,
    revokeTrustedDevice,
    revokeAllTrustedDevices,
    startForcedTwoFactorSetup,
    confirmForcedTwoFactorSetup,
    peekInvite,
    acceptInvite,
    getTwoFactorStatus,
    startTotp,
    confirmTotp,
    disableTotp,
    regenerateRecoveryCodes,
  };
}
