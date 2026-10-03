import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

// One row per (user, subscription provider): the app-side record of a sign-in
// that lives in the runner's per-user credential home. Carries state and
// account identity only — never a token (2026-09-25, migration 0088).
export const providerConnections = sqliteTable("provider_connections", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  accountEmail: text("account_email"),
  accountOrg: text("account_org"),
  plan: text("plan"),
  connectedAt: text("connected_at"),
  verifiedAt: text("verified_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.provider] }),
}));
