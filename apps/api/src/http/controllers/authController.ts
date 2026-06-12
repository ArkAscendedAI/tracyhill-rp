import type { RequestHandler } from "express";

import { checkLoginRateLimit, recordLoginFailure, clearLoginFailures, checkEndpointRateLimit, recordEndpointAttempt } from "../middleware/loginRateLimiter";

import {
  changePasswordRequestSchema,
  confirmAccountDeletionRequestSchema,
  executeAccountDeletionRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  resendAccountDeletionRequestSchema,
  registerRequestSchema,
  resendMfaCodeRequestSchema,
  resendRegistrationRequestSchema,
  resendPasswordResetRequestSchema,
  resetPasswordRequestSchema,
  verifyMfaCodeRequestSchema,
  verifyPasswordResetRequestSchema,
  verifyRegistrationRequestSchema,
} from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { AuthService } from "../../domain/auth/authService";
import type { SqliteSessionStore } from "../../services/sqliteSessionStore";
import { getAuditContext } from "../auditContext";

const TRUST_COOKIE = "trp.trust";

function parseTrustToken(cookieHeader?: string) {
  const match = cookieHeader?.match(/(?:^|;\s*)trp\.trust=([a-f0-9]{64})/);
  return match?.[1] ?? null;
}

function setTrustCookie(res: Parameters<RequestHandler>[1], req: Parameters<RequestHandler>[0], token: string) {
  res.cookie(TRUST_COOKIE, token, {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    sameSite: "lax",
    path: "/",
  });
}

export function createAuthController(authService: AuthService, audit?: AuditService, sessionStore?: SqliteSessionStore) {
  const register: RequestHandler = async (req, res, next) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const rateLimitError = checkEndpointRateLimit(ip);
      if (rateLimitError) { res.status(429).json({ error: rateLimitError }); return; }
      recordEndpointAttempt(ip);
      const parsed = registerRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid registration request" });
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
      const parsed = verifyRegistrationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid registration verification request" });
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
      const parsed = resendRegistrationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid registration resend request" });
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
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const rateLimitError = checkEndpointRateLimit(ip);
      if (rateLimitError) { res.status(429).json({ error: rateLimitError }); return; }
      recordEndpointAttempt(ip);
      const parsed = forgotPasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid forgot-password request" });
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
      const parsed = resendPasswordResetRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid password-reset resend request" });
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
      const parsed = verifyPasswordResetRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid password-reset verification request" });
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
      const parsed = resetPasswordRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid password-reset request" });
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

  const login: RequestHandler = async (req, res, next) => {
    try {
      const parsed = loginRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid login request" });
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
      if ("mfaRequired" in user) {
        res.json(user);
        return;
      }
      // session fixation protection: regenerate session after successful auth.
      // Explicit save so the new session ID is persisted before we send the
      // response -- res.json could otherwise close the connection before
      // express-session's implicit on-finish save runs, leaving the user
      // having to log in again.
      const userId = req.session.userId;
      const role = req.session.role;
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => { if (err) reject(err); else resolve(); });
      });
      req.session.userId = userId;
      req.session.role = role;
      await new Promise<void>((resolve, reject) => {
        req.session.save((err) => { if (err) reject(err); else resolve(); });
      });
      res.json({ ok: true, user });
    } catch (error) {
      next(error);
    }
  };

  const resendMfaCode: RequestHandler = async (req, res, next) => {
    try {
      const parsed = resendMfaCodeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid mfa resend request" });
        return;
      }
      const resend = await authService.resendMfaCode(parsed.data);
      res.json({ ok: true, ...resend });
    } catch (error) {
      next(error);
    }
  };

  // Session-fixation protection shared by every path that elevates a session
  // to authenticated. login already regenerated; the MFA and registration
  // verify paths did NOT — and MFA-enabled accounts always authenticate via
  // the MFA path, so the protection was absent exactly where it mattered.
  const regenerateAuthedSession = async (req: Parameters<RequestHandler>[0]) => {
    const userId = req.session.userId;
    const role = req.session.role;
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => { if (err) reject(err); else resolve(); });
    });
    req.session.userId = userId;
    req.session.role = role;
    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => { if (err) reject(err); else resolve(); });
    });
  };

  const verifyMfaCode: RequestHandler = async (req, res, next) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const rateLimitError = checkEndpointRateLimit(ip);
      if (rateLimitError) { res.status(429).json({ error: rateLimitError }); return; }
      recordEndpointAttempt(ip);
      const parsed = verifyMfaCodeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid mfa verification request" });
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
        res.status(400).json({ error: "invalid password change request" });
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
        res.status(400).json({ error: "invalid account deletion resend request" });
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
        res.status(400).json({ error: "invalid account deletion confirmation request" });
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
        res.status(400).json({ error: "invalid account deletion execute request" });
        return;
      }
      const userId = req.session.userId!;
      await authService.executeAccountDeletion(userId, parsed.data);
      sessionStore?.destroyByUserId(userId);
      audit?.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: userId }),
        action: "account.deleted",
      });
      req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie("trp.sid");
        res.clearCookie(TRUST_COOKIE, { path: "/" });
        res.json({ ok: true });
      });
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
        res.status(400).json({ error: "invalid trusted device id" });
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
    getMfaStatus,
    getTrustedDevices,
    revokeTrustedDevice,
    revokeAllTrustedDevices,
  };
}
