import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Living World Phase 1 — per-character NPC drive sheets. Injected deterministically
// into every turn the character is present (the attire pattern), NOT retrieval-scored.
export const characterDrives = sqliteTable("character_drives", {
  campaignId: text("campaign_id").notNull(),
  characterName: text("character_name").notNull(),
  wantsJson: text("wants_json").notNull().default("[]"),
  goalsJson: text("goals_json").notNull().default("[]"),
  redLinesJson: text("red_lines_json").notNull().default("[]"),
  leverageJson: text("leverage_json").notNull().default("[]"),
  offpageProject: text("offpage_project"),
  concealmentJson: text("concealment_json").notNull().default("[]"),
  dispositionsJson: text("dispositions_json").notNull().default("{}"),
  sealed: integer("sealed").notNull().default(0),
  schemeJson: text("scheme_json"),
  // Emotional inertia (0078). "A position changes only when a cost is imposed" is
  // a request in prose and arithmetic here — one apology cannot flip a counter,
  // which is the mechanical backstop against redemption drift.
  grudge: integer("grudge").notNull().default(0),
  trust: integer("trust").notNull().default(0),
  // Designated true-evil antagonists opt OUT of moral-complexity norms. Without
  // this, "every cruel character has principles" manufactures the sympathetic
  // villain the adversarial-world work exists to remove.
  // Reserved: no reader and no writer in current code.
  redemptionExempt: integer("redemption_exempt").notNull().default(0),
  // Nemesis record (0078): an antagonist who beats <user> comes back promoted,
  // scarred, and remembering it. familiarity drives who resurfaces, so a
  // recurring villain is earned rather than randomly re-rolled.
  // Write-only today: the repository increments them; nothing renders them yet.
  nemesisRank: integer("nemesis_rank").notNull().default(0),
  scarsJson: text("scars_json"),
  familiarity: integer("familiarity").notNull().default(0),
  lastUpdatedTurn: integer("last_updated_turn"),
  lastUpdatedMessageId: text("last_updated_message_id"),
  source: text("source").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.campaignId, table.characterName] }),
  campaignIdx: index("idx_character_drives_campaign").on(table.campaignId),
  campaignSealedIdx: index("character_drives_campaign_sealed_idx").on(table.campaignId, table.sealed, table.updatedAt),
  sealedCheck: check("character_drives_sealed_check", sql`${table.sealed} IN (0, 1)`),
}));

export const characterDrivesHistory = sqliteTable("character_drives_history", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  characterName: text("character_name").notNull(),
  beforeJson: text("before_json").notNull(),
  afterJson: text("after_json").notNull(),
  changedAtTurn: integer("changed_at_turn"),
  changedAtMessageId: text("changed_at_message_id"),
  source: text("source").notNull(),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  campaignCharIdx: index("idx_character_drives_history_campaign_char").on(table.campaignId, table.characterName, table.createdAt),
}));
