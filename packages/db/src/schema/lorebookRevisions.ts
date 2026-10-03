import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Pre-write snapshots of lorebook entries — one row per destructive rewrite.
// See migration 0064 for the rationale (auditable + revertible history; reverts
// are themselves captured; isConstant entries are excluded; capped to ~20/entry).
export const lorebookEntryRevisions = sqliteTable("lorebook_entry_revisions", {
  id: text("id").primaryKey(),
  entryId: text("entry_id").notNull(),
  userId: text("user_id").notNull(),
  campaignId: text("campaign_id"),
  revisionNo: integer("revision_no").notNull(),
  name: text("name").notNull(),
  tag: text("tag"),
  content: text("content").notNull(),
  comment: text("comment"),
  keys: text("keys").notNull().default("[]"),
  keysSecondary: text("keys_secondary").notNull().default("[]"),
  knownBy: text("known_by"),
  isEnabled: integer("is_enabled").notNull().default(1),
  isConstant: integer("is_constant").notNull().default(0),
  sticky: integer("sticky").notNull().default(0),
  compressedRefIds: text("compressed_ref_ids"),
  sealed: integer("sealed").notNull().default(0),
  // 0084 (2026-09-02): the full dial set, so revert is a full restore. NULL on
  // revisions captured before 0084 — revert leaves the current value for those.
  selectiveLogic: text("selective_logic"),
  scanDepth: integer("scan_depth"),
  position: text("position"),
  insertionOrder: integer("insertion_order"),
  probability: integer("probability"),
  cooldown: integer("cooldown"),
  delay: integer("delay"),
  excludeRecursion: integer("exclude_recursion"),
  preventRecursion: integer("prevent_recursion"),
  delayUntilRecursion: integer("delay_until_recursion"),
  matchOptionsJson: text("match_options_json"),
  source: text("source").notNull(),
  pipelineRunId: text("pipeline_run_id"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  // Migration 0064. revision_no / created_at are DESC in the SQL.
  entryRevIdx: index("idx_ler_entry_rev").on(table.entryId, table.revisionNo),
  userCreatedIdx: index("idx_ler_user_created").on(table.userId, table.createdAt),
  runIdx: index("idx_ler_run").on(table.pipelineRunId),
  sealedCheck: check("lorebook_entry_revisions_sealed_check", sql`${table.sealed} IN (0, 1)`),
}));
