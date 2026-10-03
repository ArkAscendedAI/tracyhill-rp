import { CONTEXT_DEFAULT_MODEL_DIALS, contextSettingsSchema } from "@tracyhill-rp/contracts";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL_ID, getChatModel, getConfiguredDefaultModelId, getEmbeddingModel } from "@tracyhill-rp/model-catalog";

// The models a session starts with when it has no earlier session of its campaign to inherit from (2026-10-02): Claude
// Opus 4.6 when the account can use it, otherwise a model it can use. The choice is written into that first session, and
// later sessions of the campaign inherit it. `usable` holds the provider ids the account can reach right now: its own
// key or sign-in, a server-wide one, or the environment's (ProviderKeyService.listKeys, `configured`). DEFAULT_MODEL_ID,
// when set, wins everywhere a default applies, as before.

/** The background dials ship with Claude subscription models; these are the same models through an Anthropic API key. */
export const CLAUDE_DIRECT_EQUIVALENT: Readonly<Record<string, string>> = {
  "claude-opus-4-6-bridge": "claude-opus-4-6",
  "claude-sonnet-4-6-bridge": "claude-sonnet-4-6",
  "claude-haiku-4-5-bridge": "claude-haiku-4-5-20251001",
};

const PREFERRED_CHAT_MODELS = ["claude-opus-4-6", "claude-opus-4-6-bridge"];

/** The order a fallback provider is taken in; each gives its first catalog model. */
export const FALLBACK_PROVIDER_ORDER = [
  "anthropic", "claude-code", "openai", "codex-bridge", "google", "xai", "deepseek", "moonshot", "zai", "xiaomi", "fireworks", "gmicloud",
] as const;

const FALLBACK_EMBEDDING_MODEL = "openai:text-embedding-3-large";
const LOCAL_EMBEDDING_MODEL = "local:nomic-embed-text-v1.5";

export type UsableProviders = ReadonlySet<string>;

function usableCatalogModel(modelId: string, usable: UsableProviders): boolean {
  const model = getChatModel(modelId);
  return Boolean(model && usable.has(model.provider));
}

/** A catalog model the account can use: Claude Opus 4.6 first, then the first model of the first usable provider. */
function fallbackCatalogModel(usable: UsableProviders): string | null {
  for (const id of PREFERRED_CHAT_MODELS) if (usableCatalogModel(id, usable)) return id;
  for (const provider of FALLBACK_PROVIDER_ORDER) {
    if (!usable.has(provider)) continue;
    const model = CHAT_MODELS.find((candidate) => candidate.provider === provider);
    if (model) return model.id;
  }
  return null;
}

/** The chat model a new session starts on when nobody chose one. */
export function defaultChatModelFor(usable: UsableProviders, customModelIds: readonly string[] = []): string {
  return getConfiguredDefaultModelId()
    ?? fallbackCatalogModel(usable)
    ?? customModelIds[0]
    ?? getChatModel(DEFAULT_CHAT_MODEL_ID)?.id
    ?? DEFAULT_CHAT_MODEL_ID;
}

/**
 * The context overrides a session that inherits nothing starts with, for the dials whose shipped default this account
 * cannot run: the background models (Claude through the subscription; the direct model with an Anthropic key, else the
 * session's own model when the account can use it, else a model it can use) and the embedding model (Google; else
 * OpenAI; else the local server when LOCAL_EMBEDDING_URL is set). A dial the account can run keeps its default and is
 * not written. With DEFAULT_MODEL_ID set, the chat dials follow it at read time and only the embedding model is checked.
 */
export function startingModelOverrides(
  usable: UsableProviders,
  composerModelId: string,
  options: { localEmbeddings?: boolean } = {},
): Record<string, string> {
  const shipped = contextSettingsSchema.parse({}) as Record<string, unknown>;
  const overrides: Record<string, string> = {};
  if (!getConfiguredDefaultModelId()) {
    const fallback = usableCatalogModel(composerModelId, usable) ? composerModelId : fallbackCatalogModel(usable);
    for (const dial of CONTEXT_DEFAULT_MODEL_DIALS) {
      const shippedModel = String(shipped[dial] ?? "");
      if (!shippedModel || usableCatalogModel(shippedModel, usable)) continue;
      const direct = CLAUDE_DIRECT_EQUIVALENT[shippedModel];
      if (direct && usableCatalogModel(direct, usable)) overrides[dial] = direct;
      else if (fallback) overrides[dial] = fallback;
    }
  }
  const shippedEmbedding = String(shipped.embeddingModel ?? "");
  const embedding = getEmbeddingModel(shippedEmbedding);
  if (!(embedding && usable.has(embedding.provider))) {
    if (usable.has("openai")) overrides.embeddingModel = FALLBACK_EMBEDDING_MODEL;
    else if (options.localEmbeddings) overrides.embeddingModel = LOCAL_EMBEDDING_MODEL;
  }
  return overrides;
}

/** What a session that inherits nothing starts with: its model and the overrides to write. */
export type StartingModels = (userId: string, requestedModelId?: string) => { modelId: string; overrides: Record<string, string> };
