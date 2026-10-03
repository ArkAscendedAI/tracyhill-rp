import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessions } from "./sessions";
import { users } from "./users";

// One receipt per logical assistant turn. Keep it after individual variants or
// replies are deleted: already-settled canon is corrected through explicit edits
// and audits, never replayed as a new slight/loss when a historical reply changes.
export const settledAssistantIngestions = sqliteTable("settled_assistant_ingestions", {
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceUserMessageId: text("source_user_message_id").notNull(),
  // NULL legacy hashes are guarded by the 0086 content-change trigger; it sets
  // an empty invalidation marker on edits without deleting the receipt key.
  sourceUserContentHash: text("source_user_content_hash"),
  assistantMessageId: text("assistant_message_id").notNull(),
  contentHash: text("content_hash"),
  settledByMessageId: text("settled_by_message_id"),
  ingestedAt: text("ingested_at").notNull(),
}, table => ({ pk: primaryKey({ columns: [table.sessionId, table.sourceUserMessageId] }) }));
