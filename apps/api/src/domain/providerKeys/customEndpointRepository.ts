import { eq } from "drizzle-orm";

import {
  customEndpoints,
  type DatabaseClient,
} from "@tracyhill-rp/db";
import { customEndpointModelSchema, type CustomEndpointModel, type CustomEndpointSummary } from "@tracyhill-rp/contracts";

import { encryptValue, decryptValue } from "../../lib/crypto";

export class CustomEndpointRepository {
  constructor(private readonly db: DatabaseClient["db"]) {}

  listByUser(userId: string): CustomEndpointSummary[] {
    return this.db.select().from(customEndpoints).where(eq(customEndpoints.userId, userId)).all().map(deserializeEndpoint);
  }

  findById(userId: string, endpointId: string): CustomEndpointSummary | null {
    const row = this.db.select().from(customEndpoints)
      .where(eq(customEndpoints.id, endpointId))
      .get();
    if (!row || row.userId !== userId) return null;
    return deserializeEndpoint(row);
  }

  replaceForUser(userId: string, next: Array<Omit<CustomEndpointSummary, "hasKey">>) {
    this.db.transaction((tx) => {
      tx.delete(customEndpoints).where(eq(customEndpoints.userId, userId)).run();
      for (const endpoint of next) {
        tx.insert(customEndpoints).values({
          id: endpoint.id,
          userId,
          name: endpoint.name,
          baseUrl: endpoint.baseUrl,
          apiKey: encryptValue(endpoint.apiKey),
          apiFormat: endpoint.apiFormat,
          authHeader: endpoint.authHeader,
          modelsJson: JSON.stringify(endpoint.models),
          createdAt: endpoint.createdAt ?? endpoint.updatedAt ?? new Date().toISOString(),
          updatedAt: endpoint.updatedAt ?? new Date().toISOString(),
        }).run();
      }
    });
  }
}

function deserializeEndpoint(row: typeof customEndpoints.$inferSelect): CustomEndpointSummary {
  const decryptedKey = decryptValue(row.apiKey);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey: decryptedKey,
    apiFormat: row.apiFormat as CustomEndpointSummary["apiFormat"],
    authHeader: row.authHeader as CustomEndpointSummary["authHeader"],
    models: parseModels(row.modelsJson),
    hasKey: Boolean(decryptedKey.trim()),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseModels(value: string): CustomEndpointModel[] {
  try {
    const parsed = JSON.parse(value) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((model) => {
      const result = customEndpointModelSchema.safeParse(model);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}
