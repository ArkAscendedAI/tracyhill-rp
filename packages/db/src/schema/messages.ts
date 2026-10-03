import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { sessions } from "./sessions";
import { users } from "./users";

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  // Exact user turn that generated this assistant, independent of interleaved sends.
  sourceUserMessageId: text("source_user_message_id"),
  ingestionEligible: integer("ingestion_eligible", { mode: "boolean" }).notNull().default(false),
  content: text("content").notNull(),
  thinking: text("thinking"),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  // Stop reason + (refusal-only) stop_details json from the provider's message_delta.
  // stopReason is set on every assistant message; stopDetailsJson is non-null only on
  // Anthropic 4.7+ refusals. fastMode reflects what the API actually ran (usage.speed === "fast").
  stopReason: text("stop_reason"),
  stopDetailsJson: text("stop_details_json"),
  fastMode: integer("fast_mode", { mode: "boolean" }).notNull().default(false),
  // Model that actually produced the response per the upstream's own report
  // (Fable 5 safeguard fallbacks can serve a turn from another model). NULL when
  // the provider doesn't report it.
  servedModel: text("served_model"),
  // Living World spotlight marker. 'gm_spotlight' on the GM-directive marker
  // message that precedes an NPC-driven beat; NULL on every ordinary message.
  // The UI routes it to a divider instead of a user bubble.
  directiveKind: text("directive_kind"),
  // Owner roll override (composer 🎲 toggle). Set on the USER message so every
  // variant of the turn honours it — this turn's contested outcomes resolve in
  // <user>'s favour, stamped into the printed basis trail for auditability.
  rollOverride: integer("roll_override", { mode: "boolean" }).notNull().default(false),
  sceneData: text("scene_data"),
  sceneValidatorJson: text("scene_validator_json"),
  sceneResolutionChoice: text("scene_resolution_choice"),
  overheadJson: text("overhead_json"),
  // Message branching / swipes (0065). A NULL group is a singleton (active by
  // definition). A regenerate mints a group_id, stamps it on the original + each
  // new sibling, and all siblings SHARE the original's sort_order. Exactly one
  // sibling per group has variant_active=1; the transcript + cost/stats/search/
  // scene-rollback all filter on variant_active=1 so inactive siblings are hidden.
  variantGroupId: text("variant_group_id"),
  variantActive: integer("variant_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  // 0067: one VISIBLE message per (session, slot); inactive siblings coexist
  // underneath. Replaced the old UNIQUE(session_id, sort_order).
  sessionSortActiveUq: uniqueIndex("messages_session_sort_active_uq")
    .on(table.sessionId, table.sortOrder)
    .where(sql`${table.variantActive} = 1`),
  sessionSortIdx: index("messages_session_sort_idx").on(table.sessionId, table.sortOrder),
  userSessionIdx: index("messages_user_session_idx").on(table.userId, table.sessionId),
  variantGroupIdx: index("idx_messages_variant_group").on(table.sessionId, table.userId, table.variantGroupId),
}));
