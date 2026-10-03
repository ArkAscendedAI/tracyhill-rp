import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

// Authenticator-app two-factor (migration 0093). Secrets encrypted by the API; recovery codes hashed.
export const userTwoFactor = sqliteTable("user_two_factor", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  totpSecret: text("totp_secret"),
  totpEnabledAt: text("totp_enabled_at"),
  totpLastStep: integer("totp_last_step"),
  pendingSecret: text("pending_secret"),
  pendingCreatedAt: text("pending_created_at"),
  recoveryCodesJson: text("recovery_codes_json").notNull().default("[]"),
  updatedAt: text("updated_at").notNull(),
});
