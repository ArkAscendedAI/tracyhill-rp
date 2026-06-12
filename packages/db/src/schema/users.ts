import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
});
