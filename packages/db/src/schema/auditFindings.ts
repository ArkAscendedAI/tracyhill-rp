import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Campaign-audit findings review queue (migration 0076). Rows are the
// AMBIGUOUS residue the audit couldn't settle from the transcript — flagged
// for an owner ruling, never guessed. `fingerprint` dedupes re-derived
// findings across (stateless) audit runs; the executor writes rulings back
// into the lorebook so durable state lives in canon, not here.
export const auditFindings = sqliteTable("audit_findings", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  campaignId: text("campaign_id").notNull(),
  runId: text("run_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  detail: text("detail"),
  reason: text("reason"),
  entryIds: text("entry_ids").notNull().default("[]"),
  status: text("status").notNull().default("open"),
  ruling: text("ruling"),
  executorQuestion: text("executor_question"),
  outcome: text("outcome"),
  rulingRunId: text("ruling_run_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ruledAt: text("ruled_at"),
}, (table) => ({
  // One ACTIVE finding per (campaign, fingerprint); ruled rows fall out of the
  // partial index so a later run can re-raise the same fingerprint.
  campaignFingerprintActiveUq: uniqueIndex("audit_findings_campaign_fingerprint_active_uq")
    .on(table.campaignId, table.fingerprint)
    .where(sql`${table.status} IN ('open', 'processing')`),
  campaignStatusIdx: index("audit_findings_campaign_status_idx").on(table.campaignId, table.status, table.updatedAt),
  statusCheck: check("audit_findings_status_check", sql`${table.status} IN ('open', 'processing', 'ruled')`),
}));
