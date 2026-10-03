import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Adversarial World state (migration 0078).
 *
 * The common thread: prose can ASK a model to follow through on a threat, honour
 * a death, or let a scheme advance offscreen, and a positivity-biased model will
 * reliably decline all three. State the model cannot rewrite is the only version
 * that holds. All of it is gated on worldStance in code, so it stays inert at the
 * shipped default.
 */

/** A stated threat with a deadline. The prose rule alone is a request; the fuse
 *  makes follow-through checkable. */
export const activeThreats = sqliteTable("active_threats", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  sessionId: text("session_id"),
  sourceCharacter: text("source_character").notNull(),
  target: text("target").notNull(),
  statedAct: text("stated_act").notNull(),
  // Decremented on the SOURCE character's opportunities, not every turn — a
  // threat from someone off-stage should not burn its fuse while they are absent.
  opportunitiesRemaining: integer("opportunities_remaining").notNull().default(2),
  status: text("status").notNull().default("armed"),
  resolution: text("resolution"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => ({
  campaignStatusIdx: index("active_threats_campaign_status_idx").on(table.campaignId, table.status),
  statusCheck: check("active_threats_status_check", sql`${table.status} IN ('armed', 'attempted', 'defused', 'expired')`),
}));

/** Authoritative, un-regeneratable consequences. Regenerate/variants are plot
 *  armour precisely because community RP does not own this state; we do. */
export const campaignConsequences = sqliteTable("campaign_consequences", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  sessionId: text("session_id"),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(),
  detail: text("detail").notNull(),
  // Provenance only — deliberately NOT a foreign key, because deleting the
  // message must not erase the fact.
  messageId: text("message_id"),
  aftermath: text("aftermath"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  campaignIdx: index("campaign_consequences_campaign_idx").on(table.campaignId, table.createdAt),
  kindCheck: check("campaign_consequences_kind_check", sql`${table.kind} IN ('death', 'maiming', 'loss', 'ruin')`),
  aftermathCheck: check("campaign_consequences_aftermath_check", sql`${table.aftermath} IN ('consequence_survival', 'character_transfer')`),
}));

/** Clocks advance whether or not <user> engages. A threat that only progresses
 *  when looked at is not a threat. */
export const threatClocks = sqliteTable("threat_clocks", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  name: text("name").notNull(),
  impulse: text("impulse").notNull(),
  filled: integer("filled").notNull().default(0),
  total: integer("total").notNull().default(6),
  ownerCharacter: text("owner_character"),
  schemeStepKey: text("scheme_step_key"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  campaignStatusIdx: index("threat_clocks_campaign_status_idx").on(table.campaignId, table.status),
  statusCheck: check("threat_clocks_status_check", sql`${table.status} IN ('active', 'filled', 'resolved', 'abandoned')`),
}));
