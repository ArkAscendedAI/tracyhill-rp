import type { CreateLorebookEntryRequest, UpdateLorebookEntryRequest, LorebookEntry, LorebookListResponse, LorebookBulkAction, LorebookImportResult } from "@tracyhill-rp/contracts";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { createLogger } from "@tracyhill-rp/logging";

const lorebookLogger = createLogger("lorebook-service");
import { estimateTokens } from "./lorebookTokenEstimator";
import { importSillyTavernLorebook } from "./lorebookImporter";
import type { LorebookRepository } from "./lorebookRepository";
import type { LorebookEmbeddingRepository } from "./lorebookEmbeddingRepository";
import type { EmbeddingService } from "./embeddingService";
import type { UserRepository } from "../users/userRepository";
import type { CampaignRepository } from "../campaigns/campaignRepository";

const DEFAULT_EMBED_MODEL = "openai:text-embedding-3-large";

export class LorebookService {
  constructor(
    private readonly users: UserRepository,
    private readonly lorebook: LorebookRepository,
    private readonly embeddingService?: EmbeddingService | null,
    private readonly embeddingRepo?: LorebookEmbeddingRepository | null,
    private readonly campaigns?: CampaignRepository | null,
  ) {}

  private resolveCampaignEmbedModel(userId: string, campaignId: string | null | undefined): string {
    if (!this.campaigns || !campaignId) return DEFAULT_EMBED_MODEL;
    try {
      const campaign = this.campaigns.findById(userId, campaignId);
      const json = (campaign as any)?.contextDefaultsJson;
      if (!json) return DEFAULT_EMBED_MODEL;
      const defaults = JSON.parse(json);
      return typeof defaults?.embeddingModel === "string" && defaults.embeddingModel ? defaults.embeddingModel : DEFAULT_EMBED_MODEL;
    } catch { return DEFAULT_EMBED_MODEL; }
  }

  /**
   * Models to embed an entry under. Campaign entries embed under their
   * campaign's model; GLOBAL entries (campaignId null) embed under every
   * distinct model the user's campaigns use (plus the default) — they used to
   * embed only under the openai default, making them invisible to semantic
   * retrieval on any campaign configured for a different model.
   */
  private resolveEmbedModels(userId: string, campaignId: string | null | undefined): string[] {
    if (campaignId) return [this.resolveCampaignEmbedModel(userId, campaignId)];
    const models = new Set<string>([DEFAULT_EMBED_MODEL]);
    if (this.campaigns) {
      try {
        for (const campaign of this.campaigns.listForUser(userId)) {
          const json = (campaign as any)?.contextDefaultsJson;
          if (!json) continue;
          try {
            const defaults = JSON.parse(json);
            if (typeof defaults?.embeddingModel === "string" && defaults.embeddingModel) models.add(defaults.embeddingModel);
          } catch { /* skip malformed */ }
        }
      } catch { /* default-only fallback */ }
    }
    return [...models];
  }

  list(userId: string, campaignId: string, opts?: { isEnabled?: boolean; isConstant?: boolean; sort?: string; order?: string; limit?: number; offset?: number; search?: string; tag?: string }): LorebookListResponse {
    this.requireUser(userId);
    const entries = this.lorebook.listForCampaign(userId, campaignId, opts);
    const total = this.lorebook.countForCampaign(userId, campaignId);
    return { entries: entries.map(toContract), total };
  }

  get(userId: string, entryId: string): LorebookEntry {
    this.requireUser(userId);
    const entry = this.lorebook.findById(userId, entryId);
    if (!entry) throw new HttpError(404, "lorebook entry not found");
    return toContract(entry);
  }

  create(userId: string, campaignId: string, input: CreateLorebookEntryRequest): LorebookEntry {
    this.requireUser(userId);
    const now = new Date().toISOString();
    const id = createId();
    this.lorebook.create({
      id,
      userId,
      campaignId,
      name: input.name,
      tag: input.tag ?? null,
      content: input.content,
      comment: input.comment ?? null,
      keys: JSON.stringify(input.keys),
      keysSecondary: JSON.stringify(input.keysSecondary),
      selectiveLogic: input.selectiveLogic,
      scanDepth: input.scanDepth,
      position: input.position,
      insertionOrder: input.insertionOrder,
      probability: input.probability,
      isConstant: input.isConstant ? 1 : 0,
      isEnabled: input.isEnabled ? 1 : 0,
      sticky: input.sticky,
      cooldown: input.cooldown,
      delay: input.delay,
      excludeRecursion: input.excludeRecursion ? 1 : 0,
      preventRecursion: input.preventRecursion ? 1 : 0,
      delayUntilRecursion: input.delayUntilRecursion ? 1 : 0,
      tokensEstimate: estimateTokens(input.content),
      knownBy: input.knownBy ? JSON.stringify(input.knownBy) : null,
      matchOptionsJson: input.matchOptions ? JSON.stringify(input.matchOptions) : null,
      legacySource: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const model of this.resolveEmbedModels(userId, campaignId)) this.embedEntry(userId, id, input.content, model);
    return this.get(userId, id);
  }

  update(userId: string, entryId: string, input: UpdateLorebookEntryRequest): LorebookEntry {
    this.requireUser(userId);
    const existing = this.lorebook.findById(userId, entryId);
    if (!existing) throw new HttpError(404, "lorebook entry not found");
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };
    if (input.name !== undefined) updates.name = input.name;
    if (input.tag !== undefined) updates.tag = input.tag;
    if (input.content !== undefined) {
      updates.content = input.content;
      updates.tokensEstimate = estimateTokens(input.content);
    }
    if (input.comment !== undefined) updates.comment = input.comment;
    if (input.keys !== undefined) updates.keys = JSON.stringify(input.keys);
    if (input.keysSecondary !== undefined) updates.keysSecondary = JSON.stringify(input.keysSecondary);
    if (input.selectiveLogic !== undefined) updates.selectiveLogic = input.selectiveLogic;
    if (input.scanDepth !== undefined) updates.scanDepth = input.scanDepth;
    if (input.position !== undefined) updates.position = input.position;
    if (input.insertionOrder !== undefined) updates.insertionOrder = input.insertionOrder;
    if (input.probability !== undefined) updates.probability = input.probability;
    if (input.isConstant !== undefined) updates.isConstant = input.isConstant ? 1 : 0;
    if (input.isEnabled !== undefined) updates.isEnabled = input.isEnabled ? 1 : 0;
    if (input.sticky !== undefined) updates.sticky = input.sticky;
    if (input.cooldown !== undefined) updates.cooldown = input.cooldown;
    if (input.delay !== undefined) updates.delay = input.delay;
    if (input.excludeRecursion !== undefined) updates.excludeRecursion = input.excludeRecursion ? 1 : 0;
    if (input.preventRecursion !== undefined) updates.preventRecursion = input.preventRecursion ? 1 : 0;
    if (input.delayUntilRecursion !== undefined) updates.delayUntilRecursion = input.delayUntilRecursion ? 1 : 0;
    if (input.knownBy !== undefined) updates.knownBy = input.knownBy ? JSON.stringify(input.knownBy) : null;
    if (input.matchOptions !== undefined) updates.matchOptionsJson = input.matchOptions ? JSON.stringify(input.matchOptions) : null;
    this.lorebook.update(userId, entryId, updates as any);
    if (input.content !== undefined) {
      for (const model of this.resolveEmbedModels(userId, (existing as any).campaignId)) this.embedEntry(userId, entryId, input.content, model);
    }
    return this.get(userId, entryId);
  }

  remove(userId: string, entryId: string): void {
    this.requireUser(userId);
    // Ownership check BEFORE cleanup: deleteForEntry/clearActivationStateForEntry
    // are entryId-only — without this, passing another user's entryId deleted
    // their embeddings + activation state while the entry row survived.
    if (!this.lorebook.findById(userId, entryId)) throw new HttpError(404, "lorebook entry not found");
    this.lorebook.transact(() => {
      this.lorebook.remove(userId, entryId);
      this.embeddingRepo?.deleteForEntry(entryId);
      this.lorebook.clearActivationStateForEntry(entryId);
    });
  }

  bulkAction(userId: string, action: LorebookBulkAction): void {
    this.requireUser(userId);
    switch (action.action) {
      case "enable": this.lorebook.bulkSetEnabled(userId, action.entryIds, true); break;
      case "disable": this.lorebook.bulkSetEnabled(userId, action.entryIds, false); break;
      case "delete": {
        // Cleanup methods are entryId-only — restrict to ids the user owns.
        const owned = this.lorebook.findByIds(userId, action.entryIds).map(e => e.id);
        this.lorebook.transact(() => {
          for (const entryId of owned) {
            this.embeddingRepo?.deleteForEntry(entryId);
            this.lorebook.clearActivationStateForEntry(entryId);
          }
          this.lorebook.removeMany(userId, owned);
        });
        break;
      }
      case "retag": this.lorebook.bulkSetTag(userId, action.entryIds, action.tag ?? ""); break;
    }
  }

  import(userId: string, campaignId: string, json: unknown, format: string): LorebookImportResult {
    this.requireUser(userId);
    if (format !== "sillytavern") throw new HttpError(400, "unsupported import format");
    const result = importSillyTavernLorebook(this.lorebook, userId, campaignId, json);
    if (this.embeddingService && result.imported > 0) {
      const entries = this.lorebook.listEnabledForCampaign(userId, campaignId);
      this.embeddingService.indexEntries(entries.map(e => ({ id: e.id, userId: e.userId, content: e.content })), this.resolveCampaignEmbedModel(userId, campaignId)).catch((err) => lorebookLogger.warn({ err, userId, campaignId, entries: entries.length }, "post-import indexEntries failed (non-fatal)"));
    }
    return result;
  }

  getTags(userId: string, campaignId: string): string[] {
    this.requireUser(userId);
    return this.lorebook.getTags(userId, campaignId);
  }

  private embedEntry(userId: string, entryId: string, content: string, embedModel: string = DEFAULT_EMBED_MODEL) {
    this.embeddingService?.indexEntries([{ id: entryId, userId, content }], embedModel).catch((err) => lorebookLogger.warn({ err, entryId, userId }, "per-entry indexEntries failed (non-fatal)"));
  }

  private requireUser(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    return user;
  }
}

function toContract(row: any): LorebookEntry {
  return {
    id: row.id,
    userId: row.userId,
    campaignId: row.campaignId,
    name: row.name,
    tag: row.tag,
    content: row.content,
    comment: row.comment,
    keys: safeParseJson(row.keys, []),
    keysSecondary: safeParseJson(row.keysSecondary, []),
    selectiveLogic: row.selectiveLogic as any,
    scanDepth: row.scanDepth,
    position: row.position as any,
    insertionOrder: row.insertionOrder,
    probability: row.probability,
    isConstant: row.isConstant === 1,
    isEnabled: row.isEnabled === 1,
    sticky: row.sticky,
    cooldown: row.cooldown,
    delay: row.delay,
    excludeRecursion: row.excludeRecursion === 1,
    preventRecursion: row.preventRecursion === 1,
    delayUntilRecursion: row.delayUntilRecursion === 1,
    tokensEstimate: row.tokensEstimate,
    knownBy: row.knownBy ? safeParseJson(row.knownBy, null) : null,
    matchOptions: row.matchOptionsJson ? safeParseJson(row.matchOptionsJson, null) : null,
    legacySource: row.legacySource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
