import { and, eq } from "drizzle-orm";

import { providerKeys, type DatabaseClient } from "@tracyhill-rp/db";
import type { ProviderId } from "@tracyhill-rp/contracts";
import { createLogger } from "@tracyhill-rp/logging";

import { encryptValue, decryptValue, isEncrypted } from "../../lib/crypto";
import { recordSystemEvent } from "../system/systemEvents";

const logger = createLogger("provider-keys");

// Keys are AES-GCM under a key HKDF-derived from SESSION_SECRET only, so a
// secret rotation (or a corrupt row) makes every stored key undecryptable.
// That used to THROW out of every read — chat sends, embeddings, and the keys
// page itself all 500ed, with row deletion the only recovery. An
// undecryptable row now reads as "no key" (`apiKey: ""`, `unreadable: true`)
// so callers fall back to server defaults / "not configured", and the user is
// told ONCE per process (log + a warn system_event) to re-enter it.
const unreadableReported = new Set<string>();

export type ProviderKeyRow = typeof providerKeys.$inferSelect & { unreadable: boolean };

export class ProviderKeyRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listByUser(userId: string): ProviderKeyRow[] {
    const rows = this.db.select().from(providerKeys).where(eq(providerKeys.userId, userId)).all();
    return rows.map((row) => this.decryptRow(row));
  }

  findByUserAndProvider(userId: string, provider: ProviderId): ProviderKeyRow | undefined {
    const row = this.db.select().from(providerKeys).where(and(eq(providerKeys.userId, userId), eq(providerKeys.provider, provider))).get();
    return row ? this.decryptRow(row) : undefined;
  }

  upsert(input: typeof providerKeys.$inferInsert) {
    const encryptedKey = encryptValue(input.apiKey);
    this.db.insert(providerKeys).values({ ...input, apiKey: encryptedKey }).onConflictDoUpdate({
      target: [providerKeys.userId, providerKeys.provider],
      set: {
        apiKey: encryptedKey,
        updatedAt: input.updatedAt,
      },
    }).run();
    // A re-entered key is readable again — let a later failure re-alert.
    unreadableReported.delete(`${input.userId}|${input.provider}`);
    return this.findByUserAndProvider(input.userId, input.provider as ProviderId)!;
  }

  deleteForUserProvider(userId: string, provider: ProviderId) {
    this.db.delete(providerKeys).where(and(eq(providerKeys.userId, userId), eq(providerKeys.provider, provider))).run();
    unreadableReported.delete(`${userId}|${provider}`);
  }

  /**
   * Re-encrypt a legacy plaintext key in-place (called during transparent migration on read).
   */
  private migrateToEncrypted(row: typeof providerKeys.$inferSelect) {
    if (row.apiKey.trim() && !isEncrypted(row.apiKey)) {
      const encrypted = encryptValue(row.apiKey);
      this.db.update(providerKeys)
        .set({ apiKey: encrypted })
        .where(and(eq(providerKeys.userId, row.userId), eq(providerKeys.provider, row.provider)))
        .run();
    }
  }

  private decryptRow(row: typeof providerKeys.$inferSelect): ProviderKeyRow {
    this.migrateToEncrypted(row);
    try {
      return { ...row, apiKey: decryptValue(row.apiKey), unreadable: false };
    } catch (err) {
      reportUnreadableKey(row.userId, row.provider, err);
      return { ...row, apiKey: "", unreadable: true };
    }
  }
}

/** Log + system_event once per (user, provider) per process; the throttle in
 *  recordSystemEvent is only 5 minutes and every chat send re-reads the keys. */
export function reportUnreadableKey(userId: string, label: string, err: unknown): void {
  const key = `${userId}|${label}`;
  if (unreadableReported.has(key)) return;
  unreadableReported.add(key);
  const reason = err instanceof Error ? err.message : String(err);
  logger.warn({ userId, provider: label, reason }, "stored API key cannot be decrypted — treating as absent until re-entered");
  recordSystemEvent({
    userId, source: "provider_keys", severity: "warn",
    message: `stored ${label} API key can no longer be decrypted (server secret rotated or row corrupt) — re-enter it under Provider Keys; until then requests use the server default or fail as "not configured"`,
    details: { provider: label, reason },
  });
}

/** For tests — the once-per-process report set. */
export function resetUnreadableKeyReportsForTest(): void {
  unreadableReported.clear();
}
