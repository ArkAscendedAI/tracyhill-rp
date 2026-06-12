import { and, eq } from "drizzle-orm";

import { providerKeys, type DatabaseClient } from "@tracyhill-rp/db";
import type { ProviderId } from "@tracyhill-rp/contracts";

import { encryptValue, decryptValue, isEncrypted } from "../../lib/crypto";

export class ProviderKeyRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listByUser(userId: string) {
    const rows = this.db.select().from(providerKeys).where(eq(providerKeys.userId, userId)).all();
    return rows.map((row) => this.decryptRow(row));
  }

  findByUserAndProvider(userId: string, provider: ProviderId) {
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
    return this.findByUserAndProvider(input.userId, input.provider as ProviderId)!;
  }

  deleteForUserProvider(userId: string, provider: ProviderId) {
    this.db.delete(providerKeys).where(and(eq(providerKeys.userId, userId), eq(providerKeys.provider, provider))).run();
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

  private decryptRow(row: typeof providerKeys.$inferSelect) {
    this.migrateToEncrypted(row);
    return { ...row, apiKey: decryptValue(row.apiKey) };
  }
}
