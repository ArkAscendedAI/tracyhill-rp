import crypto from "node:crypto";

import { and, desc, eq, gt, isNull } from "drizzle-orm";

import type { CreateInviteRequest, Invite } from "@tracyhill-rp/contracts";
import { invites, users, type DatabaseClient } from "@tracyhill-rp/db";

import { createId } from "../../lib/ids";

// One-time invite links: an administrator makes one, sends the link
// any way they like, and the person creates their own account with their own password. Works with sign-up off and
// without email. The token is shown once and stored as a SHA-256 hash.

type InviteRow = typeof invites.$inferSelect;

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export class InviteService {
  constructor(
    private readonly db: DatabaseClient["db"],
    private readonly now: () => number = Date.now,
  ) {}

  private status(row: InviteRow): Invite["status"] {
    if (row.revokedAt) return "revoked";
    if (row.usedAt) return "used";
    if (Date.parse(row.expiresAt) <= this.now()) return "expired";
    return "open";
  }

  private toInvite(row: InviteRow): Invite {
    return {
      id: row.id,
      role: row.role === "admin" ? "admin" : "user",
      username: row.username,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      revokedAt: row.revokedAt,
      status: this.status(row),
    };
  }

  create(createdBy: string, input: { role: "user" | "admin"; username?: string; days: number }): { invite: Invite; token: string } {
    const token = crypto.randomBytes(24).toString("base64url");
    const now = new Date(this.now());
    const row: InviteRow = {
      id: createId(),
      tokenHash: hashToken(token),
      role: input.role,
      username: input.username?.trim() || null,
      createdBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.days * 86_400_000).toISOString(),
      usedAt: null,
      usedBy: null,
      revokedAt: null,
    };
    this.db.insert(invites).values(row).run();
    return { invite: this.toInvite(row), token };
  }

  /** The newest hundred, open or not. */
  list(): Invite[] {
    return this.db.select().from(invites).orderBy(desc(invites.createdAt)).limit(100).all().map((row) => this.toInvite(row));
  }

  /** Withdraws an invite that is still open. */
  revoke(id: string): boolean {
    const result = this.db.update(invites).set({ revokedAt: new Date(this.now()).toISOString() })
      .where(and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt))).run();
    return result.changes > 0;
  }

  /** What a link points at, or null for a token that was never issued. */
  find(token: string): Invite | null {
    const row = this.db.select().from(invites).where(eq(invites.tokenHash, hashToken(token))).get();
    return row ? this.toInvite(row) : null;
  }

  /**
   * Spends an open invite and creates the account in one transaction: of two forms sent with the same link, one wins.
   * False when the invite is no longer open.
   */
  acceptWith(token: string, account: typeof users.$inferInsert): boolean {
    const nowIso = new Date(this.now()).toISOString();
    return this.db.transaction((tx) => {
      const spent = tx.update(invites).set({ usedAt: nowIso, usedBy: null })
        .where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, nowIso))).run();
      if (spent.changes !== 1) return false;
      tx.insert(users).values(account).run();
      tx.update(invites).set({ usedBy: account.id }).where(eq(invites.tokenHash, hashToken(token))).run();
      return true;
    });
  }
}

export type { CreateInviteRequest };
