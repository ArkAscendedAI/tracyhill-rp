import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient, providerKeys } from "@tracyhill-rp/db";
import { minimalUser } from "@tracyhill-rp/test-fixtures";

import { initEncryptionKey } from "../../lib/crypto";
import { createSeededTestDb } from "../../test/testDb";
import { ProviderKeyRepository } from "./providerKeyRepository";
import { resolveProviderRuntimeKeys } from "./providerKeyRuntime";

beforeAll(() => { initEncryptionKey("test-secret-for-encryption"); });

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("provider key runtime resolution", () => {
  it("prefers stored per-user keys and falls back to server defaults for missing providers", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const now = new Date().toISOString();
    db.insert(providerKeys).values({
      userId: minimalUser.id,
      provider: "openai",
      apiKey: "user-openai-key",
      createdAt: now,
      updatedAt: now,
    }).run();
    const repository = new ProviderKeyRepository(db);

    const resolved = resolveProviderRuntimeKeys(repository, minimalUser.id, {
      anthropicApiKey: "",
      claudeCodeBridgeUrl: "",
      claudeCodeBridgeSecret: "",
      deepseekApiKey: "server-deepseek-key",
      googleApiKey: "server-google-key",
      openaiApiKey: "server-openai-key",
      xaiApiKey: "",
      xiaomiApiKey: "",
      zaiApiKey: "",
    });

    expect(resolved.openaiApiKey).toBe("user-openai-key");
    expect(resolved.deepseekApiKey).toBe("server-deepseek-key");
    expect(resolved.googleApiKey).toBe("server-google-key");
    expect(resolved.anthropicApiKey).toBe("");
    sqlite.close();
  });
});
