import { eq } from "drizzle-orm";

import { serviceHeartbeats } from "./schema/serviceHeartbeats";

import type { DatabaseClient } from "./client";

type Db = DatabaseClient["db"];

// Shared read/write helpers for service_heartbeats (0074).
// The dedicated worker beats; the API health endpoint, the API liveness
// monitor, the deploy verification, and the external loop watcher read.
export const WORKER_SERVICE = "worker";

export function beatHeartbeat(db: Db, service: string, details?: unknown): void {
  const now = new Date().toISOString();
  const detailsJson = details === undefined ? null : JSON.stringify(details);
  db.insert(serviceHeartbeats)
    .values({ service, beatAt: now, detailsJson })
    .onConflictDoUpdate({ target: serviceHeartbeats.service, set: { beatAt: now, detailsJson } })
    .run();
}

export function readHeartbeat(db: Db, service: string): { beatAt: string; detailsJson: string | null } | null {
  const row = db
    .select({ beatAt: serviceHeartbeats.beatAt, detailsJson: serviceHeartbeats.detailsJson })
    .from(serviceHeartbeats)
    .where(eq(serviceHeartbeats.service, service))
    .get();
  return row ?? null;
}
