import { DEFAULT_EMBEDDING_MODEL } from "@tracyhill-rp/model-catalog";

/**
 * The ONE campaign-scoped embedding-model resolver.
 *
 * The embedding model is a per-SESSION Engine dial (migration 0077 retired
 * campaign-scoped settings; `831e273`). Four surfaces kept reading it from the
 * campaign's `context_defaults_json` FOSSIL — a column nothing has written since
 * 0077, NULL for every campaign created after it — so every manual lorebook
 * create/update/revert/import, the coverage monitor and the reembed tool
 * resolved `google:gemini-embedding-2` for campaigns whose sessions ran
 * `openai:text-embedding-3-large`. Hand-authored entries got a gemini vector
 * only and were invisible to the session's semantic pool (one campaign: 124
 * openai vs 113 google rows on 2026-09-02).
 *
 * Authority now = the campaign's NEWEST non-deleted session's
 * `contextOverrides.embeddingModel` — the same "most recently touched session"
 * rule workspaceService uses to clone dials onto a new session — falling back
 * to DEFAULT_EMBEDDING_MODEL (which is also what contextEngine.resolveSettings
 * yields for a session with no override). `campaigns.context_defaults_json` is
 * no longer read anywhere; the column stays in place.
 */
export interface EmbedModelSessionSource {
  findNewestForCampaign(userId: string, campaignId: string): { contextOverridesJson: string | null; updatedAt?: string | null } | undefined;
}

export function resolveCampaignEmbedModel(
  sessions: EmbedModelSessionSource | null | undefined,
  userId: string,
  campaignId: string,
): string {
  if (!sessions) return DEFAULT_EMBEDDING_MODEL;
  try {
    const session = sessions.findNewestForCampaign(userId, campaignId);
    return embedModelFromOverrides(session?.contextOverridesJson);
  } catch {
    return DEFAULT_EMBEDDING_MODEL;
  }
}

export function embedModelFromOverrides(contextOverridesJson: string | null | undefined): string {
  if (!contextOverridesJson) return DEFAULT_EMBEDDING_MODEL;
  try {
    const overrides = JSON.parse(contextOverridesJson) as { embeddingModel?: unknown } | null;
    const model = overrides?.embeddingModel;
    return typeof model === "string" && model ? model : DEFAULT_EMBEDDING_MODEL;
  } catch {
    return DEFAULT_EMBEDDING_MODEL;
  }
}
