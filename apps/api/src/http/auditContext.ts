import type { Request, Response } from "express";

import { requestIdHeader } from "@tracyhill-rp/logging";

import type { AuditContext } from "../domain/audit/auditService";

export function getAuditContext(req: Request, res: Response, extra?: Partial<AuditContext>): AuditContext {
  return {
    actorUserId: req.session.userId ?? null,
    actorRole: req.session.role ?? null,
    requestId: headerValue(res.getHeader(requestIdHeader)) ?? headerValue(req.header(requestIdHeader)) ?? null,
    ...(extra ?? {}),
  };
}

function headerValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.find((entry) => typeof entry === "string" && entry.trim())?.trim() ?? null;
  return null;
}
