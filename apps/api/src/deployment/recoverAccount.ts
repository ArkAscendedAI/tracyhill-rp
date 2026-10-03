import crypto from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { auditEvents, createDatabaseClient, serverSettings, users, userTwoFactor } from "@tracyhill-rp/db";

import { createId } from "../lib/ids";
import { hashPassword } from "../lib/password";
import { SqliteSessionStore } from "../services/sqliteSessionStore";

// The recovery command: for an administrator who lost their phone
// or password, or a server nobody can sign in to. It works on the database directly, from a shell on the server:
//
//   docker compose exec tracyhill-rp node --import tsx apps/api/src/deployment/recoverAccountMain.ts --user <name> \
//     [--reset-two-factor] [--new-password] [--two-factor-off]
//
// Every run writes an audit row. The new password is printed once; nothing else is.

export type RecoveryOptions = {
  dbFile: string;
  username?: string;
  resetTwoFactor: boolean;
  newPassword: boolean;
  twoFactorOff: boolean;
};

export type RecoveryResult = { lines: string[]; restartNeeded: boolean };

// Letters and digits without look-alikes, with at least one upper-case letter, one lower-case letter and one digit,
// which the password rules ask for.
function temporaryPassword(): string {
  const upper = "ABCDEFGHJKMNPQRSTVWXYZ";
  const lower = "abcdefghjkmnpqrstvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const pick = (set: string) => set[crypto.randomInt(set.length)]!;
  const chars = [pick(upper), pick(lower), pick(digits), ...Array.from({ length: 13 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export async function recoverAccount(options: RecoveryOptions): Promise<RecoveryResult> {
  if (!options.resetTwoFactor && !options.newPassword && !options.twoFactorOff) {
    throw new Error("Nothing to do: choose --reset-two-factor, --new-password or --two-factor-off");
  }
  if ((options.resetTwoFactor || options.newPassword) && !options.username) throw new Error("--user <name> is required for that");
  const { db, sqlite } = createDatabaseClient(options.dbFile);
  const lines: string[] = [];
  let restartNeeded = false;
  try {
    const now = new Date().toISOString();
    const user = options.username
      ? db.select().from(users).where(sql`${users.username} = ${options.username} COLLATE NOCASE`).get()
      : undefined;
    if (options.username && !user) throw new Error(`No account named "${options.username}"`);

    if (options.resetTwoFactor && user) {
      db.delete(userTwoFactor).where(eq(userTwoFactor.userId, user.id)).run();
      db.update(users).set({ trustedDevices: "[]", updatedAt: now }).where(eq(users.id, user.id)).run();
      lines.push(`Two-factor reset for ${user.username}: the authenticator, recovery codes and trusted devices are gone.`);
    }

    if (options.newPassword && user) {
      const password = temporaryPassword();
      db.update(users).set({ passwordHash: await hashPassword(password), updatedAt: now }).where(eq(users.id, user.id)).run();
      const store = new SqliteSessionStore(options.dbFile);
      try { store.destroyByUserId(user.id); } finally { store.close(); }
      lines.push(`New password for ${user.username}: ${password}`, "Every session of that account was signed out. Change the password after signing in (Options → Password).");
    }

    if (options.twoFactorOff) {
      const row = db.select().from(serverSettings).where(eq(serverSettings.key, "twoFactor")).get();
      let current: Record<string, unknown> = { totp: true, email: false };
      try { if (row) current = JSON.parse(row.value) as Record<string, unknown>; } catch { /* a damaged value is replaced */ }
      const value = JSON.stringify({ ...current, policy: "off" });
      db.insert(serverSettings).values({ key: "twoFactor", value, updatedAt: now, updatedBy: "recovery-cli" })
        .onConflictDoUpdate({ target: serverSettings.key, set: { value, updatedAt: now, updatedBy: "recovery-cli" } }).run();
      restartNeeded = true;
      lines.push("Two-factor is Off for the whole server. Turn it back on in Admin: Server settings once you are signed in.");
    }

    db.insert(auditEvents).values({
      id: createId(),
      action: "recovery.command",
      actorUserId: null,
      actorRole: null,
      targetType: user ? "user" : "server",
      targetId: user?.id ?? "server",
      metadataJson: JSON.stringify({ resetTwoFactor: options.resetTwoFactor, newPassword: options.newPassword, twoFactorOff: options.twoFactorOff }),
      createdAt: now,
    }).run();
    if (restartNeeded) lines.push("Restart the app so it reads the change: docker compose restart tracyhill-rp");
    return { lines, restartNeeded };
  } finally {
    sqlite.close();
  }
}
