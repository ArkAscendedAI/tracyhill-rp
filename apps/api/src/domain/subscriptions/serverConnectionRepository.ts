import { eq } from "drizzle-orm";

import type { SubscriptionProvider } from "@tracyhill-rp/contracts";
import { serverSubscriptionConnections, type DatabaseClient } from "@tracyhill-rp/db";

import type { ProviderConnectionPatch, ProviderConnectionRow } from "./providerConnectionRepository";

// The server-wide Claude and ChatGPT sign-ins (offered behind a warning that sharing a
// subscription may get it banned). The runner keeps the credential in its own home, picked by this id, which no real
// account can have (account ids are UUIDs). Accounts without their own sign-in run on it.
export const SERVER_SUBSCRIPTION_HOME = "server-shared";

/**
 * The same operations SubscriptionService uses on provider_connections, over the server-wide table: one row per
 * provider, whatever user id is passed (it is always SERVER_SUBSCRIPTION_HOME).
 */
export class ServerConnectionRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  private toRow(row: typeof serverSubscriptionConnections.$inferSelect | undefined): ProviderConnectionRow | undefined {
    return row ? { ...row, userId: SERVER_SUBSCRIPTION_HOME } : undefined;
  }

  listByUser(_userId: string): ProviderConnectionRow[] {
    return this.db.select().from(serverSubscriptionConnections).all().map((row) => this.toRow(row)!);
  }

  find(_userId: string, provider: SubscriptionProvider): ProviderConnectionRow | undefined {
    return this.toRow(this.db.select().from(serverSubscriptionConnections).where(eq(serverSubscriptionConnections.provider, provider)).get());
  }

  isConnected(_userId: string, provider: SubscriptionProvider): boolean {
    return this.find(SERVER_SUBSCRIPTION_HOME, provider)?.status === "connected";
  }

  upsert(_userId: string, provider: SubscriptionProvider, patch: ProviderConnectionPatch, now = new Date().toISOString()): ProviderConnectionRow {
    const existing = this.find(SERVER_SUBSCRIPTION_HOME, provider);
    const next = {
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
    const { createdAt: _createdAt, provider: _provider, ...updates } = next;
    this.db.insert(serverSubscriptionConnections).values(next).onConflictDoUpdate({
      target: serverSubscriptionConnections.provider,
      set: updates,
    }).run();
    return this.find(SERVER_SUBSCRIPTION_HOME, provider)!;
  }

  delete(_userId: string, provider: SubscriptionProvider) {
    this.db.delete(serverSubscriptionConnections).where(eq(serverSubscriptionConnections.provider, provider)).run();
  }
}
