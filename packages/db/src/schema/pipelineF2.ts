import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// F2 quick-win D4: per-stage raw LLM I/O capture. 90-day retention (separate job).
export const pipelineRunArtifacts = sqliteTable("pipeline_run_artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  stage: text("stage").notNull(),
  kind: text("kind").notNull(), // "prompt" | "response" | "stream_events" | "edits" | "rendered"
  content: text("content").notNull(),
  bytes: integer("bytes").notNull(),
  createdAt: text("created_at").notNull(),
});

