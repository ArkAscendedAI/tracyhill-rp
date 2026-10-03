import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email"),
  emailVerified: integer("email_verified").notNull().default(0),
  agreedToTerms: integer("agreed_to_terms").notNull().default(0),
  trustedDevices: text("trusted_devices").notNull().default("[]"),
  role: text("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  // Mirrors migration 0025 (partial: many rows may have a NULL email). The
  // index/FK/CHECK declarations across this schema DOCUMENT the migrated SQL
  // for the type layer — they never generate DDL (migrate.ts runs raw SQL) and
  // a schema test diffs them against the real migrated database.
  emailUniqueIdx: uniqueIndex("users_email_unique_idx").on(table.email).where(sql`${table.email} IS NOT NULL`),
}));
