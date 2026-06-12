import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  mergedIntoId: text("merged_into_id"),
  compressedRefIds: text("compressed_ref_ids"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
