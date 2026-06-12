import type { AdminAuditEventsResponse } from "@tracyhill-rp/contracts";

import { createId } from "../../lib/ids";
import { AuditRepository } from "./auditRepository";

export type AuditMetadata = Record<string, unknown>;

export type AuditContext = {
  actorUserId?: string | null;
  actorRole?: "admin" | "user" | null;
  requestId?: string | null;
  jobId?: string | null;
  sessionId?: string | null;
  campaignId?: string | null;
  runId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
};

export type AuditRecordInput = AuditContext & {
  action: string;
  metadata?: AuditMetadata;
};

export class AuditService {
  constructor(private readonly auditEvents: AuditRepository) {}

  record(input: AuditRecordInput) {
    this.auditEvents.create({
      id: createId(),
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      requestId: input.requestId ?? null,
      jobId: input.jobId ?? null,
      sessionId: input.sessionId ?? null,
      campaignId: input.campaignId ?? null,
      runId: input.runId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt: new Date().toISOString(),
    });
  }

  listRecent(limit = 100): AdminAuditEventsResponse {
    return {
      events: this.auditEvents.listRecent(limit).map((event) => ({
        id: event.id,
        action: event.action,
        actorUserId: event.actorUserId,
        actorUsername: event.actorUsername ?? null,
        actorRole: event.actorRole as "admin" | "user" | null,
        requestId: event.requestId,
        jobId: event.jobId,
        sessionId: event.sessionId,
        campaignId: event.campaignId,
        runId: event.runId,
        targetType: event.targetType,
        targetId: event.targetId,
        metadata: parseMetadata(event.metadataJson),
        createdAt: event.createdAt,
      })),
    };
  }
}

function parseMetadata(raw: string | null | undefined) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
