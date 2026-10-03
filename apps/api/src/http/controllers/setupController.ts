import type { Request, RequestHandler } from "express";

import { createFirstAdminRequestSchema, verifySetupCodeRequestSchema, type CurrentUser } from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { SetupService } from "../../domain/setup/setupService";
import { HttpError } from "../../lib/httpError";
import { stampSessionExpiry } from "../../services/sessionCookie";
import { getAuditContext } from "../auditContext";
import { describeIssues } from "../describeIssues";
import { checkEndpointRateLimit, recordEndpointAttempt } from "../middleware/loginRateLimiter";

// First-run setup (domain/setup/setupService.ts). Wrong codes spend a per-IP budget; a right code with a password the
// rules refuse does not, so the person running the server can fix the form without being locked out.
export function createSetupController(setup: SetupService, audit?: AuditService) {
  const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown";

  // Counts the attempt when the code was wrong, then hands the error on.
  const countWrongCode = (req: Request, error: unknown) => {
    if (error instanceof HttpError && error.statusCode === 401) recordEndpointAttempt(clientIp(req), "setup");
  };

  const verify: RequestHandler = (req, res, next) => {
    const limited = checkEndpointRateLimit(clientIp(req), "setup");
    if (limited) { res.status(429).json({ error: limited }); return; }
    const parsed = verifySetupCodeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid setup code request: ${describeIssues(parsed.error)}` });
      return;
    }
    try {
      setup.checkCode(parsed.data.setupCode);
      res.json({ ok: true });
    } catch (error) {
      countWrongCode(req, error);
      next(error);
    }
  };

  const createAdmin: RequestHandler = async (req, res, next) => {
    const limited = checkEndpointRateLimit(clientIp(req), "setup");
    if (limited) { res.status(429).json({ error: limited }); return; }
    const parsed = createFirstAdminRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid setup request: ${describeIssues(parsed.error)}` });
      return;
    }
    try {
      const user = await setup.createFirstAdmin(parsed.data);
      await signIn(req, user);
      audit?.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: user.id }),
        action: "setup.first_admin.created",
      });
      res.status(201).json({ ok: true, user });
    } catch (error) {
      countWrongCode(req, error);
      next(error);
    }
  };

  return { verify, createAdmin };
}

// The new administrator is signed in at once. A fresh session id (fixation protection) carrying the 3 AM expiry,
// saved before the response is sent: the same steps as regenerateAuthedSession in authController.ts.
async function signIn(req: Request, user: CurrentUser) {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => { if (err) reject(err); else resolve(); });
  });
  req.session.userId = user.id;
  req.session.role = user.role;
  stampSessionExpiry(req.session);
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => { if (err) reject(err); else resolve(); });
  });
}
