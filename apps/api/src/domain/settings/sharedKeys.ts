import { eq } from "drizzle-orm";

import type { UserManagedProviderId } from "@tracyhill-rp/contracts";
import { serverSettings, type DatabaseClient } from "@tracyhill-rp/db";

import { decryptValue } from "../../lib/crypto";
import type { ProviderRuntimeDefaults } from "../providerKeys/providerKeyService";

// Server-wide API keys: every account on the server can use them, and the server owner
// pays. They enter key resolution where the environment's server keys always have (resolveProviderRuntimeKeys:
// an account's own key, else the server's), so the API and the worker, the composer, images, workers and embeddings
// all see them. A key set in the environment wins over one set in Admin: Server settings.

export type ProviderKeyField = "anthropicApiKey" | "deepseekApiKey" | "fireworksApiKey" | "gmicloudApiKey" | "googleApiKey" | "moonshotApiKey" | "openaiApiKey" | "xaiApiKey" | "xiaomiApiKey" | "zaiApiKey";

export const SHARED_KEY_FIELDS: Record<Exclude<UserManagedProviderId, never>, ProviderKeyField> = {
  anthropic: "anthropicApiKey",
  deepseek: "deepseekApiKey",
  fireworks: "fireworksApiKey",
  gmicloud: "gmicloudApiKey",
  google: "googleApiKey",
  moonshot: "moonshotApiKey",
  openai: "openaiApiKey",
  xai: "xaiApiKey",
  xiaomi: "xiaomiApiKey",
  zai: "zaiApiKey",
};

export type SharedKeyReader = (provider: string) => string;

/**
 * The defaults object every runtime factory reads, with each provider key resolved at read time: the environment's
 * value, else the shared key. Read on every runtime build, so a change in the page applies at the next turn.
 */
export function withSharedKeys<T extends ProviderRuntimeDefaults>(env: T, shared: SharedKeyReader): T {
  const out = { ...env };
  for (const [provider, field] of Object.entries(SHARED_KEY_FIELDS)) {
    const fromEnvironment = (env[field] ?? "").trim();
    Object.defineProperty(out, field, { enumerable: true, configurable: true, get: () => fromEnvironment || shared(provider).trim() });
  }
  return out;
}

/** The worker's reader: the stored row, read again at most every few seconds, decrypted per call. */
export function createDatabaseSharedKeyReader(db: DatabaseClient["db"], ttlMs = 5_000, now: () => number = Date.now): SharedKeyReader {
  let cached: { at: number; keys: Record<string, string> } | null = null;
  const load = () => {
    if (cached && now() - cached.at < ttlMs) return cached.keys;
    let keys: Record<string, string> = {};
    try {
      const row = db.select().from(serverSettings).where(eq(serverSettings.key, "sharedKeys")).get();
      const parsed = row ? JSON.parse(row.value) as unknown : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) keys = parsed as Record<string, string>;
    } catch {
      keys = {};
    }
    cached = { at: now(), keys };
    return keys;
  };
  return (provider) => {
    const stored = load()[provider];
    if (typeof stored !== "string" || !stored) return "";
    try {
      return decryptValue(stored);
    } catch {
      return "";
    }
  };
}
