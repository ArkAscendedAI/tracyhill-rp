import { Router, type Request, type RequestHandler } from "express";

import { subscriptionLoginCancelRequestSchema, subscriptionLoginCompleteRequestSchema, subscriptionLoginStartRequestSchema, subscriptionProviderSchema, type SubscriptionProvider } from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { SubscriptionService } from "../../domain/subscriptions/subscriptionService";
import type { UserRepository } from "../../domain/users/userRepository";
import { HttpError } from "../../lib/httpError";
import { getAuditContext } from "../auditContext";
import { describeIssues } from "../describeIssues";
import { createRequireAuth } from "../middleware/requireAuth";

/**
 * The server-wide variant (Admin: Server settings → Shared keys): the same sign-in flow for the runner's
 * shared home, behind the admin check, audited against the server rather than the admin's own account.
 */
export type SubscriptionRouteScope = {
  userOf: (req: Request) => string;
  guards: RequestHandler[];
  auditTarget: { targetType: string; targetId: string } | null;
  auditPrefix: string;
};

// /api/providers/subscriptions — per-user Claude and ChatGPT sign-ins through
// the runner. Every write is audited by
// outcome; nothing about a sign-in beyond its outcome is logged.
export function createSubscriptionRoutes(subscriptions: SubscriptionService, audit: AuditService, users: UserRepository, scope?: SubscriptionRouteScope) {
  const router = Router();
  router.use(createRequireAuth(users), ...(scope?.guards ?? []));

  const providerOf = (req: Request): SubscriptionProvider => {
    const parsed = subscriptionProviderSchema.safeParse(req.params.provider);
    if (!parsed.success) throw new HttpError(404, "unknown subscription provider");
    return parsed.data;
  };
  const userOf = scope?.userOf ?? ((req: Request) => req.session.userId!);
  const auditTarget = (userId: string) => scope?.auditTarget ?? { targetType: "user", targetId: userId };
  const action = (name: string) => `${scope?.auditPrefix ?? "subscriptions."}${name}`;

  router.get("/", async (req, res, next) => {
    try {
      const userId = userOf(req);
      res.json(req.query.verify === "1" ? await subscriptions.listVerified(userId) : subscriptions.list(userId));
    } catch (error) { next(error); }
  });

  router.get("/:provider/status", async (req, res, next) => {
    try {
      const userId = userOf(req);
      const provider = providerOf(req);
      res.json(req.query.verify === "1" ? await subscriptions.verify(userId, provider) : subscriptions.status(userId, provider));
    } catch (error) { next(error); }
  });

  router.post("/:provider/login/start", async (req, res, next) => {
    try {
      const userId = userOf(req);
      const provider = providerOf(req);
      // `method` through its contract: any string used to reach the runner, which
      // refused an unknown one after the start had begun, and anything else was dropped silently. No body is none.
      const parsed = subscriptionLoginStartRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: `invalid sign-in start request: ${describeIssues(parsed.error)}` });
        return;
      }
      const started = await subscriptions.startLogin(userId, provider, parsed.data.method);
      audit.record({ ...getAuditContext(req, res, auditTarget(userId)), action: action("login_started"), metadata: { provider, completion: started.completion } });
      res.json(started);
    } catch (error) { next(error); }
  });

  router.post("/:provider/login/complete", async (req, res, next) => {
    try {
      const userId = userOf(req);
      const provider = providerOf(req);
      const parsed = subscriptionLoginCompleteRequestSchema.safeParse(req.body);
      // Both refusals name the field and the reason after the old prefix: a
      // pasted code over 4,096 characters used to read only "invalid sign-in completion request". Zod's messages never
      // quote the value, so no code is echoed.
      if (!parsed.success) { res.status(400).json({ error: `invalid sign-in completion request: ${describeIssues(parsed.error)}` }); return; }
      const status = await subscriptions.completeLogin(userId, provider, parsed.data.loginId, parsed.data.code);
      audit.record({ ...getAuditContext(req, res, auditTarget(userId)), action: action("login_completed"), metadata: { provider, status: status.status, plan: status.plan } });
      res.json(status);
    } catch (error) { next(error); }
  });

  router.post("/:provider/login/cancel", async (req, res, next) => {
    try {
      const userId = userOf(req);
      const provider = providerOf(req);
      const parsed = subscriptionLoginCancelRequestSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: `invalid sign-in cancel request: ${describeIssues(parsed.error)}` }); return; }
      res.json(await subscriptions.cancelLogin(userId, provider, parsed.data.loginId));
    } catch (error) { next(error); }
  });

  router.post("/:provider/logout", async (req, res, next) => {
    try {
      const userId = userOf(req);
      const provider = providerOf(req);
      const status = await subscriptions.logout(userId, provider);
      audit.record({ ...getAuditContext(req, res, auditTarget(userId)), action: action("logged_out"), metadata: { provider } });
      res.json(status);
    } catch (error) { next(error); }
  });

  return router;
}
