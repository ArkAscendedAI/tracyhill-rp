import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const wizardTemplates = sqliteTable("wizard_templates", {
  userId: text("user_id").primaryKey(),
  exampleSystemPrompt: text("example_system_prompt").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});
