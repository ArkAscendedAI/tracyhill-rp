import type { RequestHandler } from "express";

import { updateProviderKeysRequestSchema } from "@tracyhill-rp/contracts";

import type { AuditService } from "../../domain/audit/auditService";
import type { ProviderKeyService } from "../../domain/providerKeys/providerKeyService";
import { getAuditContext } from "../auditContext";

export function createProviderKeyController(keys: ProviderKeyService, audit: AuditService) {
  const list: RequestHandler = (req, res, next) => {
    try {
      res.json(keys.listKeys(req.session.userId!));
    } catch (error) {
      next(error);
    }
  };

  const update: RequestHandler = async (req, res, next) => {
    try {
      const parsed = updateProviderKeysRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid provider key request" });
        return;
      }
      const before = keys.listKeys(req.session.userId!);
      const response = await keys.updateKeys(req.session.userId!, parsed.data);
      audit.record({
        ...getAuditContext(req, res, { targetType: "user", targetId: req.session.userId! }),
        action: "provider_keys.updated",
        metadata: summarizeProviderKeyUpdate(before, response),
      });
      res.json(response);
    } catch (error) {
      next(error);
    }
  };

  return { list, update };
}

function summarizeProviderKeyUpdate(
  before: ReturnType<ProviderKeyService["listKeys"]>,
  after: Awaited<ReturnType<ProviderKeyService["updateKeys"]>>,
) {
  const providers = Object.keys(after.providers) as Array<keyof typeof after.providers>;
  return {
    configuredProviders: providers.filter((provider) => after.providers[provider].configured),
    changedProviders: providers.filter((provider) => {
      const previous = before.providers[provider];
      const next = after.providers[provider];
      return previous.source !== next.source || previous.configured !== next.configured || previous.updatedAt !== next.updatedAt;
    }),
    customEndpointCount: after.customEndpoints.length,
    customEndpointIds: after.customEndpoints.map((endpoint) => endpoint.id),
  };
}
