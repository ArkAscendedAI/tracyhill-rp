import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
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
  sceneData: text("scene_data"),
  sceneValidatorJson: text("scene_validator_json"),
  sceneResolutionChoice: text("scene_resolution_choice"),
  overheadJson: text("overhead_json"),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
