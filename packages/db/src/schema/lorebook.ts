import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const lorebookEntries = sqliteTable("lorebook_entries", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  campaignId: text("campaign_id"),
  name: text("name").notNull(),
  tag: text("tag"),
  content: text("content").notNull(),
  comment: text("comment"),
  keys: text("keys").notNull().default("[]"),
  keysSecondary: text("keys_secondary").notNull().default("[]"),
  selectiveLogic: text("selective_logic").notNull().default("and_any"),
  scanDepth: integer("scan_depth").notNull().default(4),
  position: text("position").notNull().default("before_main"),
  insertionOrder: integer("insertion_order").notNull().default(100),
  probability: integer("probability").notNull().default(100),
  isConstant: integer("is_constant").notNull().default(0),
  isEnabled: integer("is_enabled").notNull().default(1),
  sticky: integer("sticky").notNull().default(0),
  cooldown: integer("cooldown").notNull().default(0),
  delay: integer("delay").notNull().default(0),
  excludeRecursion: integer("exclude_recursion").notNull().default(0),
  preventRecursion: integer("prevent_recursion").notNull().default(0),
  delayUntilRecursion: integer("delay_until_recursion").notNull().default(0),
  tokensEstimate: integer("tokens_estimate").notNull().default(0),
  knownBy: text("known_by"),
  matchOptionsJson: text("match_options_json"),
  legacySource: text("legacy_source"),
  lastReviewedAt: text("last_reviewed_at"),
  // merged_into_id (write-only consolidation provenance) was dropped by 0083
  // (2026-09-02); the merge is recorded in the removed entry's comment.
  compressedRefIds: text("compressed_ref_ids"),
  sealed: integer("sealed").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  // 0040/0049/0063/0075. Names are the migrated ones (mixed idx_ / _idx style).
  userCampaignIdx: index("idx_lorebook_entries_campaign").on(table.userId, table.campaignId),
  campaignIdIdx: index("idx_lorebook_entries_campaign_id").on(table.campaignId),
  constantIdx: index("idx_lorebook_entries_constant").on(table.userId, table.campaignId, table.isConstant),
  enabledIdx: index("idx_lorebook_entries_enabled").on(table.userId, table.campaignId, table.isEnabled),
  campaignSealedIdx: index("lorebook_entries_campaign_sealed_idx").on(table.campaignId, table.sealed, table.isEnabled),
  sealedCheck: check("lorebook_entries_sealed_check", sql`${table.sealed} IN (0, 1)`),
}));

export const lorebookActivationState = sqliteTable("lorebook_activation_state", {
  sessionId: text("session_id").notNull(),
  entryId: text("entry_id").notNull(),
  stickyRemaining: integer("sticky_remaining").notNull().default(0),
  cooldownRemaining: integer("cooldown_remaining").notNull().default(0),
  lastActivatedTurn: integer("last_activated_turn"),
}, (table) => ({
  // PK matches migration 0040: PRIMARY KEY (session_id, entry_id).
  // Declared here so Drizzle's $inferInsert correctly requires both columns.
  pk: primaryKey({ columns: [table.sessionId, table.entryId] }),
}));
