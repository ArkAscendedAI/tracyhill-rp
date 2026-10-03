import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// The server-wide Claude and ChatGPT sign-ins (migration 0094): state and identity, never a token.
export const serverSubscriptionConnections = sqliteTable("server_subscription_connections", {
  provider: text("provider").primaryKey(),
  status: text("status").notNull(),
  accountEmail: text("account_email"),
  accountOrg: text("account_org"),
  plan: text("plan"),
  connectedAt: text("connected_at"),
  verifiedAt: text("verified_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
