import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Living World Phase 2 — beats armed by applied offscreen events (or a timeskip).
// after_epoch NULL = due immediately; else due once the story clock reaches it.
export const scheduledBeats = sqliteTable("scheduled_beats", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  description: text("description").notNull(),
  afterInworld: text("after_inworld"),
  afterEpoch: integer("after_epoch"),
  sourceEventEntryId: text("source_event_entry_id"),
  sourceTickRunId: text("source_tick_run_id"),
  class: text("class").notNull().default("telegraph"),
  severity: integer("severity").notNull().default(1),
  timing: text("timing").notNull().default("when_due"),
  citationType: text("citation_type"),
  citationId: text("citation_id"),
  sealed: integer("sealed").notNull().default(0),
  // The user/directive turn that first claimed this beat. Regeneration replays
  // the same directive from this link instead of claiming a second beat.
  firedMessageId: text("fired_message_id"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  campaignStatusIdx: index("idx_scheduled_beats_campaign_status").on(table.campaignId, table.status),
  campaignStatusClassIdx: index("scheduled_beats_campaign_status_class_idx").on(table.campaignId, table.status, table.class, table.severity),
  // The five 0075 CHECKs. A Drizzle insert with an out-of-set value fails at
  // runtime as SQLITE_CONSTRAINT_CHECK — these declarations make that visible.
  classCheck: check("scheduled_beats_class_check", sql`${table.class} IN ('texture', 'telegraph', 'complication')`),
  severityCheck: check("scheduled_beats_severity_check", sql`${table.severity} BETWEEN 0 AND 3`),
  timingCheck: check("scheduled_beats_timing_check", sql`${table.timing} IN ('when_due', 'fire_during_scene')`),
  citationTypeCheck: check("scheduled_beats_citation_type_check", sql`${table.citationType} IS NULL OR ${table.citationType} IN ('thread', 'beat', 'scheme', 'concealment', 'none')`),
  sealedCheck: check("scheduled_beats_sealed_check", sql`${table.sealed} IN (0, 1)`),
}));
