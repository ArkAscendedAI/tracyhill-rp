import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Liveness heartbeats for background service processes (0074). The dedicated
// worker upserts its row on a poll cadence; the API health endpoint and the
// liveness watchdogs read it so a dead loop is loudly visible instead of
// indistinguishable from an idle one.
export const serviceHeartbeats = sqliteTable("service_heartbeats", {
  service: text("service").primaryKey(),
  beatAt: text("beat_at").notNull(),
  detailsJson: text("details_json"),
});
