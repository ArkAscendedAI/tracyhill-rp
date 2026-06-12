import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const characterAttire = sqliteTable("character_attire", {
  campaignId: text("campaign_id").notNull(),
  characterName: text("character_name").notNull(),
  attireDescription: text("attire_description").notNull(),
  lastUpdatedTurn: integer("last_updated_turn").notNull().default(0),
  lastUpdatedMessageId: text("last_updated_message_id"),
  lastSeenInPresentTurn: integer("last_seen_in_present_turn").notNull().default(0),
  source: text("source").notNull().default("verifier"),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.campaignId, table.characterName] }),
}));

export const characterAttireHistory = sqliteTable("character_attire_history", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  characterName: text("character_name").notNull(),
  previousAttire: text("previous_attire"),
  newAttire: text("new_attire").notNull(),
  changedAtTurn: integer("changed_at_turn").notNull(),
  changedAtMessageId: text("changed_at_message_id"),
  source: text("source").notNull(),
  reason: text("reason"),
  changedAt: text("changed_at").notNull(),
});
