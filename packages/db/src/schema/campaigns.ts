import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  folderId: text("folder_id"),
  systemPrompt: text("system_prompt").notNull(),
  characterRoster: text("character_roster").default("[]"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // creative_model_id (dead) and context_defaults_json (the 0077 fossil, re-folded
  // by 0081) were dropped by 0083 (2026-09-02). Settings are per-session only —
  // never add a campaign-level settings scope back (it is what let one dial hold
  // two conflicting values on one campaign).
  // Anti-repetition rules are campaign-scoped STATE (the repetition worker writes
  // them back every run), not a user setting. Split out of the settings blob by
  // 0077 — living there is what kept that blob looking load-bearing.
  antiRepetitionJson: text("anti_repetition_json"),
  // Living World Phase 2 — in-world simulation watermark (see 0070).
  worldClockJson: text("world_clock_json"),
  // Dramatist pacing ledger (0075). Null means no rolls have run yet.
  dramatistStateJson: text("dramatist_state_json"),
});

// The dead-column register (V1 state_seed era + kind_registry) and
// campaigns.pipeline_model_id (retired by the 2026-06-28 Engine-panel change)
// were physically dropped by migration 0068_dead_column_sweep.sql.
