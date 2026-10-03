import { Router, type RequestHandler } from "express";

import { sendTestEmailRequestSchema, updateServerSettingsRequestSchema, type SendTestEmailResponse } from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { SettingsService } from "../../domain/settings/settingsService";
import type { UserRepository } from "../../domain/users/userRepository";
import { HttpError } from "../../lib/httpError";
import { validateEmail } from "../../lib/password";
import { sendTestEmail } from "../../services/authEmail";
import { getAuditContext } from "../auditContext";
import { describeIssues } from "../describeIssues";
import { createRequireAuth } from "../middleware/requireAuth";

// Admin: Server settings. Read, change, and prove email with a test send. Every change is audited by the
// names of the fields it touched, never their values.
export function createServerSettingsRoutes(settings: SettingsService, audit: AuditService, requireAdmin: RequestHandler, users: UserRepository) {
  const router = Router();
  router.use(createRequireAuth(users), requireAdmin);

  router.get("/", (_req, res) => {
    res.json(settings.view());
  });

  router.patch("/", (req, res, next) => {
    try {
      const parsed = updateServerSettingsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid settings request: ${describeIssues(parsed.error)}` });
        return;
      }
      const changed = settings.update(parsed.data, req.session.userId!);
      if (changed.length) {
        audit.record({ ...getAuditContext(req, res, { targetType: "server-settings", targetId: "server" }), action: "settings.changed", metadata: { fields: changed } });
      }
      res.json(settings.view());
    } catch (error) {
      next(error);
    }
  });

  router.post("/email/test", async (req, res, next) => {
    try {
      const parsed = sendTestEmailRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: `invalid test email request: ${describeIssues(parsed.error)}` });
        return;
      }
      const to = parsed.data.to.toLowerCase();
      if (validateEmail(to)) throw new HttpError(400, "Enter a valid email address to send the test to");
      const problem = settings.emailTransportProblem();
      const transport = settings.emailTransport();
      if (problem || !transport) throw new HttpError(400, problem ?? "Email settings are incomplete");
      let error: string | null = null;
      try {
        await sendTestEmail(transport, to);
      } catch (err) {
        error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      }
      settings.recordEmailTest({ ok: error === null, to, error }, req.session.userId!);
      audit.record({ ...getAuditContext(req, res, { targetType: "server-settings", targetId: "server" }), action: "settings.email_tested", metadata: { ok: error === null } });
      const body: SendTestEmailResponse = { ok: error === null, error, settings: settings.view() };
      res.json(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
