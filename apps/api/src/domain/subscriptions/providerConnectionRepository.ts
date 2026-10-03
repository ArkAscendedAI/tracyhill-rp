import { and, eq } from "drizzle-orm";

import { providerConnections, serverSubscriptionConnections, type DatabaseClient } from "@tracyhill-rp/db";
import type { SubscriptionConnectionStatus, SubscriptionProvider } from "@tracyhill-rp/contracts";

export type ProviderConnectionRow = typeof providerConnections.$inferSelect;

export type ProviderConnectionPatch = {
  status: SubscriptionConnectionStatus;
  accountEmail?: string | null;
  accountOrg?: string | null;
  plan?: string | null;
  connectedAt?: string | null;
  verifiedAt?: string | null;
  lastError?: string | null;
};

// State + identity only, never a token.
export class ProviderConnectionRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listByUser(userId: string): ProviderConnectionRow[] {
    return this.db.select().from(providerConnections).where(eq(providerConnections.userId, userId)).all();
  }

  find(userId: string, provider: SubscriptionProvider): ProviderConnectionRow | undefined {
    return this.db.select().from(providerConnections)
      .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)))
      .get();
  }

  isConnected(userId: string, provider: SubscriptionProvider): boolean {
    return this.find(userId, provider)?.status === "connected";
  }

  /** The server-wide sign-in for this provider is connected: accounts without their own run on it. */
  isServerConnected(provider: SubscriptionProvider): boolean {
    return this.db.select().from(serverSubscriptionConnections).where(eq(serverSubscriptionConnections.provider, provider)).get()?.status === "connected";
  }

  upsert(userId: string, provider: SubscriptionProvider, patch: ProviderConnectionPatch, now = new Date().toISOString()): ProviderConnectionRow {
    const existing = this.find(userId, provider);
    const next = {
      userId,
      provider,
      status: patch.status,
      accountEmail: patch.accountEmail === undefined ? existing?.accountEmail ?? null : patch.accountEmail,
      accountOrg: patch.accountOrg === undefined ? existing?.accountOrg ?? null : patch.accountOrg,
      plan: patch.plan === undefined ? existing?.plan ?? null : patch.plan,
      connectedAt: patch.connectedAt === undefined ? existing?.connectedAt ?? null : patch.connectedAt,
      verifiedAt: patch.verifiedAt === undefined ? existing?.verifiedAt ?? null : patch.verifiedAt,
      lastError: patch.lastError === undefined ? existing?.lastError ?? null : patch.lastError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.insert(providerConnections).values(next).onConflictDoUpdate({
      target: [providerConnections.userId, providerConnections.provider],
      set: {
        status: next.status,
        accountEmail: next.accountEmail,
        accountOrg: next.accountOrg,
        plan: next.plan,
        connectedAt: next.connectedAt,
        verifiedAt: next.verifiedAt,
        lastError: next.lastError,
        updatedAt: next.updatedAt,
      },
    }).run();
    return this.find(userId, provider)!;
  }

  delete(userId: string, provider: SubscriptionProvider) {
    this.db.delete(providerConnections)
      .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, provider)))
      .run();
  }
}
