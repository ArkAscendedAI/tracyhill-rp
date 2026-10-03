import { DEFAULT_EMBEDDING_MODEL } from "@tracyhill-rp/model-catalog";
import type { lorebookEntries, lorebookEntryRevisions } from "@tracyhill-rp/db";
import { LOREBOOK_COMMENT_MAX_CHARS, LOREBOOK_MAX_KEYS, type CreateLorebookEntryRequest, type UpdateLorebookEntryRequest, type LorebookEntry, type LorebookEntrySummary, type LorebookListResponse, type LorebookSummaryListResponse, type LorebookBulkAction, type LorebookBulkResult, type LorebookImportResult, type LorebookExport, type LorebookExportFormat, type LorebookRevision, type LorebookRevertResponse, type LorebookDeletedListResponse, type CharacterCardImportResult, type MatchOptions, type SelectiveLogic, type LorebookPosition } from "@tracyhill-rp/contracts";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { createLogger } from "@tracyhill-rp/logging";
import { recordSystemEvent } from "../system/systemEvents";

const lorebookLogger = createLogger("lorebook-service");
import { estimateTokens } from "./lorebookTokenEstimator";
import { importSillyTavernLorebook } from "./lorebookImporter";
import { CharacterCardError, importCharacterCard } from "./characterCardImporter";
import { buildLorebookExport } from "./lorebookExporter";
import type { LorebookListOptions, LorebookRepository } from "./lorebookRepository";
import type { LorebookRevisionRepository } from "./lorebookRevisionRepository";
import type { LorebookEmbeddingRepository } from "./lorebookEmbeddingRepository";
import type { EmbeddingService } from "./embeddingService";
import type { UserRepository } from "../users/userRepository";
import type { CampaignRepository } from "../campaigns/campaignRepository";
import { resolveCampaignEmbedModel, type EmbedModelSessionSource } from "./embedModelResolver";
import { normalizeKnownBy } from "./lorebookKnownBy";
import { normalizeKeyList } from "./lorebookKeys";
import { normalizeEntryTag } from "./lorebookTags";

const DEFAULT_EMBED_MODEL = DEFAULT_EMBEDDING_MODEL;

export class LorebookService {
  constructor(
    private readonly users: UserRepository,
    private readonly lorebook: LorebookRepository,
    private readonly embeddingService?: EmbeddingService | null,
    private readonly embeddingRepo?: LorebookEmbeddingRepository | null,
    private readonly campaigns?: CampaignRepository | null,
    private readonly revisions?: LorebookRevisionRepository | null,
    // Session source for the per-SESSION embedding-model dial. Without
    // it every manual write embeds under DEFAULT_EMBED_MODEL only — createApp
    // must pass the SessionRepository.
    private readonly sessions?: EmbedModelSessionSource | null,
  ) {}

  /** The campaign's embedding model = its newest live session's dial (the
   *  post-0077 authority); see embedModelResolver.ts for the fossil history. */
  private resolveCampaignEmbedModel(userId: string, campaignId: string | null | undefined): string {
    if (!campaignId) return DEFAULT_EMBED_MODEL;
    return resolveCampaignEmbedModel(this.sessions, userId, campaignId);
  }

  /**
   * Models to embed an entry under. Campaign entries embed under their
   * campaign's (session-resolved) model; GLOBAL entries (campaignId null) embed
   * under every distinct model the user's campaigns use (plus the default) —
   * they used to embed only under the openai default, making them invisible to
   * semantic retrieval on any campaign configured for a different model.
   */
  private resolveEmbedModels(userId: string, campaignId: string | null | undefined): string[] {
    if (campaignId) return [this.resolveCampaignEmbedModel(userId, campaignId)];
    const models = new Set<string>([DEFAULT_EMBED_MODEL]);
    if (this.campaigns && this.sessions) {
      try {
        for (const campaign of this.campaigns.listForUser(userId)) {
          models.add(resolveCampaignEmbedModel(this.sessions, userId, campaign.id));
        }
      } catch { /* default-only fallback */ }
    }
    return [...models];
  }

  list(userId: string, campaignId: string, opts?: Omit<LorebookListOptions, "sealed">): LorebookListResponse {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    const entries = this.lorebook.listForCampaign(userId, campaignId, opts);
    // Same filters as the list — Android shows `total` and pages on it.
    const total = this.lorebook.countForCampaign(userId, campaignId, opts);
    return { entries: entries.map(toContract), total };
  }

  /** The same list without entry text (`view=summary`); `total` is the same filtered count. */
  listSummary(userId: string, campaignId: string, opts?: Omit<LorebookListOptions, "sealed">): LorebookSummaryListResponse {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    const entries = this.lorebook.listSummaryForCampaign(userId, campaignId, opts);
    const total = this.lorebook.countForCampaign(userId, campaignId, opts);
    return { entries: entries.map(toSummaryContract), total };
  }

  get(userId: string, entryId: string): LorebookEntry {
    this.requireUser(userId);
    const entry = this.lorebook.findById(userId, entryId);
    if (!entry) throw new HttpError(404, "lorebook entry not found");
    return toContract(entry);
  }

  create(userId: string, campaignId: string, input: CreateLorebookEntryRequest): LorebookEntry {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    const now = new Date().toISOString();
    const id = createId();
    this.lorebook.create({
      id,
      userId,
      campaignId,
      name: input.name,
      // An empty tag is stored as none: "" used to be stored and listed by the tag picker.
      tag: normalizeEntryTag(input.tag),
      content: input.content,
      comment: input.comment ?? null,
      // The one key rule: trimmed, no blank key, no case-insensitive repeat.
      keys: JSON.stringify(normalizeKeyList(input.keys).keys),
      keysSecondary: JSON.stringify(normalizeKeyList(input.keysSecondary).keys),
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
      knownBy: storedKnownBy(input.knownBy),
      matchOptionsJson: input.matchOptions ? JSON.stringify(input.matchOptions) : null,
      legacySource: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const model of this.resolveEmbedModels(userId, campaignId)) this.embedEntry(userId, id, input.content, model, undefined, campaignId);
    return this.get(userId, id);
  }

  update(userId: string, entryId: string, input: UpdateLorebookEntryRequest): LorebookEntry {
    this.requireUser(userId);
    const existing = this.lorebook.findById(userId, entryId);
    if (!existing) throw new HttpError(404, "lorebook entry not found");
    const now = new Date().toISOString();
    const updates: Partial<typeof lorebookEntries.$inferInsert> = { updatedAt: now };
    if (input.name !== undefined) updates.name = input.name;
    if (input.tag !== undefined) updates.tag = normalizeEntryTag(input.tag);
    if (input.content !== undefined) {
      updates.content = input.content;
      updates.tokensEstimate = estimateTokens(input.content);
    }
    if (input.comment !== undefined && !sameStoredComment(input.comment, existing.comment)) {
      // Both clients send the whole entry back on save,
      // comment included, and the Thread Index's comment is the tracker's JSON
      // ledger (far over the editor's 10,000). The update contract therefore
      // admits a long comment; carried back UNCHANGED it passes (and is not
      // rewritten), while a changed comment past the editor's bound is refused
      // here with the reason. A stale client whose copy of the ledger no longer
      // matches the stored one is refused too, so it cannot overwrite the
      // tracker's newer ledger.
      if (input.comment !== null && input.comment.length > LOREBOOK_COMMENT_MAX_CHARS) {
        throw new HttpError(400, `comment is limited to ${LOREBOOK_COMMENT_MAX_CHARS.toLocaleString("en-US")} characters (this one has ${input.comment.length.toLocaleString("en-US")}). A longer stored comment, such as the thread tracker's ledger on the Thread Index, can be saved back unchanged but not edited here.`);
      }
      updates.comment = input.comment;
    }
    if (input.keys !== undefined) updates.keys = JSON.stringify(normalizeKeyList(input.keys).keys);
    if (input.keysSecondary !== undefined) updates.keysSecondary = JSON.stringify(normalizeKeyList(input.keysSecondary).keys);
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
    if (input.knownBy !== undefined) updates.knownBy = storedKnownBy(input.knownBy);
    if (input.matchOptions !== undefined) updates.matchOptionsJson = input.matchOptions ? JSON.stringify(input.matchOptions) : null;
    this.lorebook.update(userId, entryId, updates);
    if (input.content !== undefined) {
      for (const model of this.resolveEmbedModels(userId, existing.campaignId)) this.embedEntry(userId, entryId, input.content, model, undefined, existing.campaignId);
    } else if (input.isEnabled === true && existing.isEnabled === 0) {
      // Enabling a cold/disabled entry: disabled imports are
      // deliberately not indexed, and a content-less enable never embedded, so
      // the entry stayed invisible to semantic retrieval until a rebuild or a
      // model switch. staleOnly — an entry that already carries a current
      // vector costs nothing.
      for (const model of this.resolveEmbedModels(userId, existing.campaignId)) this.embedEntry(userId, entryId, existing.content, model, { staleOnly: true }, existing.campaignId);
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

  /**
   * Every bulk verb is scoped to the ROUTE's campaign as well as the user. The
   * web panel's selection once survived a campaign switch and the
   * server applied the verb to whatever the user owned, so entries of campaign
   * A were disabled/deleted/re-keyed while the screen showed campaign B. Ids
   * outside `campaignId` are ignored, never acted on.
   */
  bulkAction(userId: string, campaignId: string, action: LorebookBulkAction): LorebookBulkResult {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    const warnings: string[] = [];
    switch (action.action) {
      case "enable": {
        // Rows that transition disabled → enabled get their vector,
        // stale-only, under the campaign's model — same reason as update().
        const waking = this.lorebook.findByIds(userId, action.entryIds, campaignId).filter((e) => e.isEnabled === 0);
        this.lorebook.bulkSetEnabled(userId, action.entryIds, true, campaignId);
        if (this.embeddingService && waking.length > 0) {
          const model = this.resolveCampaignEmbedModel(userId, campaignId);
          this.embeddingService.indexEntries(waking.map((e) => ({ id: e.id, userId: e.userId, content: e.content })), model, { staleOnly: true })
            .catch((err) => this.reportIndexFailure(err, { userId, campaignId, entryIds: waking.map((e) => e.id), model, what: "bulk enable" }));
        }
        break;
      }
      case "disable": this.lorebook.bulkSetEnabled(userId, action.entryIds, false, campaignId); break;
      case "delete": {
        // Cleanup methods are entryId-only — restrict to ids the user owns IN THIS campaign.
        const owned = this.lorebook.findByIds(userId, action.entryIds, campaignId).map(e => e.id);
        this.lorebook.transact(() => {
          for (const entryId of owned) {
            this.embeddingRepo?.deleteForEntry(entryId);
            this.lorebook.clearActivationStateForEntry(entryId);
          }
          this.lorebook.removeMany(userId, owned, campaignId);
        });
        break;
      }
      // No/blank tag CLEARS the tag (null) — "" used to be stored and then
      // appeared in the tag picker.
      case "retag": this.lorebook.bulkSetTag(userId, action.entryIds, action.tag?.trim() || null, campaignId); break;
      case "append_keys": {
        const keys = (action.keys ?? []).map((k) => k.trim()).filter(Boolean);
        if (keys.length === 0) throw new HttpError(400, "append_keys requires a non-empty keys array");
        const { truncated } = this.lorebook.bulkAppendKeys(userId, action.entryIds, keys, campaignId);
        if (truncated.length > 0) {
          // Not silent: the reply names every key left off, and the
          // events feed carries one row so the sweep's residue is visible even
          // to a client that reads only `ok`.
          const list = (dropped: string[]) => dropped.length > 10 ? `${dropped.slice(0, 10).join(", ")} +${dropped.length - 10} more` : dropped.join(", ");
          for (const t of truncated) warnings.push(`"${t.name}": ${t.dropped.length} key${t.dropped.length === 1 ? "" : "s"} not added — an entry holds at most ${LOREBOOK_MAX_KEYS} keys (left off: ${list(t.dropped)})`);
          const droppedTotal = truncated.reduce((n, t) => n + t.dropped.length, 0);
          recordSystemEvent({
            userId, source: "lorebook_size", severity: "warn", campaignId,
            message: `append_keys left ${droppedTotal} key${droppedTotal === 1 ? "" : "s"} off ${truncated.length} entr${truncated.length === 1 ? "y" : "ies"} already at the ${LOREBOOK_MAX_KEYS}-key cap — trim or split those key lists`,
            details: { truncated },
          });
        }
        break;
      }
      case "set_sticky": {
        if (action.sticky === undefined) throw new HttpError(400, "set_sticky requires a sticky value");
        this.lorebook.bulkSetSticky(userId, action.entryIds, action.sticky, campaignId);
        break;
      }
    }
    return { ok: true, warnings };
  }

  import(userId: string, campaignId: string, json: unknown, format: string): LorebookImportResult {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    if (format !== "sillytavern") throw new HttpError(400, "unsupported import format");
    const { createdIds, ...result } = importSillyTavernLorebook(this.lorebook, userId, campaignId, json);
    // Index ONLY the rows this import created — re-indexing every enabled entry
    // was a paid full re-embed of the campaign per import. Disabled
    // imports are cold storage; the cold-inclusive reembed covers them.
    if (this.embeddingService && createdIds.length > 0) {
      const created = this.lorebook.findByIds(userId, createdIds).filter((e) => e.isEnabled === 1);
      if (created.length > 0) {
        const model = this.resolveCampaignEmbedModel(userId, campaignId);
        this.embeddingService.indexEntries(created.map(e => ({ id: e.id, userId: e.userId, content: e.content })), model)
          .catch((err) => this.reportIndexFailure(err, { userId, campaignId, entryIds: created.map((e) => e.id), model, what: "lorebook import" }));
      }
    }
    return result;
  }

  /**
   * Import a SillyTavern character card (V1 flat, V2/V3 JSON, or the JSON the
   * controller extracted from a PNG). Additive + collision-safe: a same-name
   * character entry is kept (never overwritten), embedded character_book
   * entries are deduped. Re-embeds only the newly created rows.
   */
  importCharacterCard(userId: string, campaignId: string, cardOrPng: unknown): CharacterCardImportResult {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    const beforeIds = new Set(this.lorebook.listAllForCampaign(userId, campaignId).map(e => e.id));
    let result: CharacterCardImportResult;
    try {
      result = importCharacterCard(this.lorebook, userId, campaignId, cardOrPng);
    } catch (err) {
      // An unreadable card is the client's data problem: 400 with the reason,
      // never the 500 a TypeError on a non-text field used to produce.
      if (err instanceof CharacterCardError) throw new HttpError(400, `character card rejected: ${err.message}`);
      throw err;
    }
    if (this.embeddingService && (result.createdCharacter || result.createdBookEntries > 0)) {
      const fresh = this.lorebook.listEnabledForCampaign(userId, campaignId).filter(e => !beforeIds.has(e.id));
      if (fresh.length > 0) {
        const model = this.resolveCampaignEmbedModel(userId, campaignId);
        this.embeddingService.indexEntries(fresh.map(e => ({ id: e.id, userId: e.userId, content: e.content })), model)
          .catch((err) => this.reportIndexFailure(err, { userId, campaignId, entryIds: fresh.map((e) => e.id), model, what: "character-card import" }));
      }
    }
    return result;
  }

  /** Export ALL entries (enabled AND disabled/cold) for a campaign. */
  export(userId: string, campaignId: string, format: LorebookExportFormat): LorebookExport {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    const rows = this.lorebook.listAllForCampaign(userId, campaignId);
    return buildLorebookExport(rows.map(toContract), format);
  }

  getTags(userId: string, campaignId: string): string[] {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    return this.lorebook.getTags(userId, campaignId);
  }

  // ── Version history + undo ────────────────────────────────────────────────

  /** Revisions of a live entry — or of a DELETED one: the pre-delete snapshot
   *  survives the row (0064 has no cascade) and is what revert() recreates
   *  from, so it must stay reachable. */
  getRevisions(userId: string, entryId: string): LorebookRevision[] {
    this.requireUser(userId);
    if (!this.revisions) {
      if (!this.lorebook.findById(userId, entryId)) throw new HttpError(404, "lorebook entry not found");
      return [];
    }
    const rows = this.revisions.listForEntry(userId, entryId).filter((r) => r.sealed !== 1);
    if (rows.length === 0 && !this.lorebook.findById(userId, entryId)) throw new HttpError(404, "lorebook entry not found");
    return rows.map(revisionToContract);
  }

  /** The campaign's deleted entries that revert can recreate, newest deletion
   *  first, each with the revision to restore. Empty without revision history. */
  listDeleted(userId: string, campaignId: string, limit = 50): LorebookDeletedListResponse {
    this.requireUser(userId);
    this.requireCampaign(userId, campaignId);
    if (!this.revisions) return { entries: [] };
    return {
      entries: this.revisions.listDeletedForCampaign(userId, campaignId, limit).map((row) => ({
        entryId: row.entryId,
        revisionId: row.id,
        revisionNo: row.revisionNo,
        name: row.name,
        tag: row.tag ?? null,
        contentPreview: row.content.slice(0, 200),
        contentChars: row.content.length,
        wasEnabled: row.isEnabled === 1,
        deletedAt: row.createdAt,
        source: row.source,
        pipelineRunId: row.pipelineRunId ?? null,
      })),
    };
  }

  /**
   * Restore an entry to the snapshot held in a revision. The revert is itself
   * captured (undo is undoable) by snapshotting the CURRENT row under the manual
   * context, then writing the snapshot back through restoreSnapshot() (which
   * does NOT auto-capture) and re-embedding under every resolved model
   * (non-fatal on failure, mirroring create/update).
   *
   * Since 0084 (2026-09-02) a revision carries every entry dial, so a revert is
   * a FULL restore; a revision captured before 0084 holds NULL for the widened
   * dials (scanDepth is the sentinel) and leaves the entry's CURRENT values for
   * them. Boundaries that remain: a snapshot's `sealed` flag is NEVER written
   * back (a revert must not hide an entry into the Dramatist tier);
   * consolidation siblings are not un-merged. When the snapshot is of an
   * archival (compressed_ref_ids set), those are restored too.
   *
   * A DELETED entry can be reverted as well: the pre-delete snapshot is the
   * only copy left, so the row is RECREATED from it with column defaults for
   * the un-snapshotted dials.
   */
  revert(userId: string, entryId: string, revisionId: string): LorebookRevertResponse {
    this.requireUser(userId);
    if (!this.revisions) throw new HttpError(503, "revision history unavailable");
    const revision = this.revisions.findById(userId, revisionId);
    if (!revision || revision.entryId !== entryId || revision.sealed === 1) throw new HttpError(404, "revision not found");
    const existing = this.lorebook.findById(userId, entryId);
    const now = new Date().toISOString();
    const snapshot = {
      name: revision.name,
      tag: revision.tag,
      content: revision.content,
      comment: revision.comment,
      keys: revision.keys,
      keysSecondary: revision.keysSecondary,
      knownBy: revision.knownBy,
      isEnabled: revision.isEnabled,
      isConstant: revision.isConstant,
      sticky: revision.sticky,
      compressedRefIds: revision.compressedRefIds,
      updatedAt: now,
      tokensEstimate: estimateTokens(revision.content),
      // 0084 widened snapshot (scanDepth doubles as the "captured after 0084"
      // sentinel — it is NOT NULL on the entry, so a NULL here means pre-0084).
      ...(revision.scanDepth != null ? {
        selectiveLogic: revision.selectiveLogic ?? "and_any",
        scanDepth: revision.scanDepth,
        position: revision.position ?? "before_main",
        insertionOrder: revision.insertionOrder ?? 100,
        probability: revision.probability ?? 100,
        cooldown: revision.cooldown ?? 0,
        delay: revision.delay ?? 0,
        excludeRecursion: revision.excludeRecursion ?? 0,
        preventRecursion: revision.preventRecursion ?? 0,
        delayUntilRecursion: revision.delayUntilRecursion ?? 0,
        matchOptionsJson: revision.matchOptionsJson ?? null,
      } : {}),
    };

    if (!existing) {
      // Undelete: the campaign is the snapshot's; a deleted-then-recreated row
      // keeps its id so the surviving revision chain stays attached to it.
      if (this.lorebook.findIncludingSealed(userId, entryId)) throw new HttpError(404, "lorebook entry not found");
      this.lorebook.create({ ...snapshot, id: entryId, userId, campaignId: revision.campaignId, createdAt: now });
      for (const model of this.resolveEmbedModels(userId, revision.campaignId)) this.embedEntry(userId, entryId, revision.content, model, undefined, revision.campaignId);
      return { ok: true, capturedRevisionId: null };
    }

    // Capture the pre-revert state as a "manual" revision so the revert shows in
    // history and is itself undoable.
    let capturedRevisionId: string | null = null;
    this.lorebook.transact(() => {
      capturedRevisionId = this.revisions!.captureCurrent(userId, entryId, { source: "manual", pipelineRunId: null });
      this.lorebook.restoreSnapshot(userId, entryId, snapshot);
    });

    // Re-embed the restored content (non-fatal — mirror the existing .catch path).
    for (const model of this.resolveEmbedModels(userId, existing.campaignId)) {
      this.embedEntry(userId, entryId, revision.content, model, undefined, existing.campaignId);
    }
    return { ok: true, capturedRevisionId };
  }

  private embedEntry(userId: string, entryId: string, content: string, embedModel: string = DEFAULT_EMBED_MODEL, opts?: { staleOnly?: boolean }, campaignId?: string | null) {
    this.embeddingService?.indexEntries([{ id: entryId, userId, content }], embedModel, opts)
      .catch((err) => this.reportIndexFailure(err, { userId, campaignId, entryIds: [entryId], model: embedModel, what: "lorebook write" }));
  }

  /**
   * A manual write completed but its vector did not land: the log line alone
   * was invisible to the user, and the coverage monitor stays quiet below 10
   * entries AND 15 % of the campaign. Record an `embed_index` event
   * unless indexEntries already recorded this very failure (provider outages
   * are recorded inside it and rethrown tagged — one row, not two).
   */
  private reportIndexFailure(err: unknown, ctx: { userId: string; campaignId?: string | null; entryIds: string[]; model: string; what: string }) {
    lorebookLogger.warn({ err, userId: ctx.userId, campaignId: ctx.campaignId ?? null, entries: ctx.entryIds.length, model: ctx.model }, `${ctx.what}: indexEntries failed (non-fatal)`);
    if (err instanceof Error && (err as Error & { systemEventRecorded?: boolean }).systemEventRecorded) return;
    const n = ctx.entryIds.length;
    recordSystemEvent({
      userId: ctx.userId,
      source: "embed_index",
      severity: "error",
      campaignId: ctx.campaignId ?? null,
      message: `${ctx.what}: ${n} entr${n === 1 ? "y" : "ies"} left unindexed under ${ctx.model} — ${err instanceof Error ? err.message : String(err)}`,
      details: { what: ctx.what, model: ctx.model, entryIds: ctx.entryIds.slice(0, 50) },
    });
  }

  private requireUser(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    return user;
  }

  /**
   * Campaign-scoped handlers used to accept ANY :campaignId — `lorebook_entries
   * .campaign_id` has no FK, so a foreign or garbage id created orphan rows
   * that outlived the victim's campaign deletion. 404 like the
   * attire/drives controllers. Skipped when no campaign repository is injected
   * (repository-level tests).
   */
  private requireCampaign(userId: string, campaignId: string) {
    if (!this.campaigns) return;
    if (!this.campaigns.findById(userId, campaignId)) throw new HttpError(404, "campaign not found");
  }
}

function toContract(row: typeof lorebookEntries.$inferSelect): LorebookEntry {
  return {
    id: row.id,
    userId: row.userId,
    campaignId: row.campaignId,
    name: row.name,
    tag: row.tag,
    content: row.content,
    comment: row.comment,
    keys: safeParseJson<string[]>(row.keys, []),
    keysSecondary: safeParseJson<string[]>(row.keysSecondary, []),
    // The DB stores these enums as free text; the writers (contract-validated
    // create/update, the importer maps) only ever store members of the enum.
    selectiveLogic: row.selectiveLogic as SelectiveLogic,
    scanDepth: row.scanDepth,
    position: row.position as LorebookPosition,
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
    knownBy: row.knownBy ? safeParseJson<string[] | null>(row.knownBy, null) : null,
    matchOptions: row.matchOptionsJson ? safeParseJson<MatchOptions>(row.matchOptionsJson, null) : null,
    legacySource: row.legacySource,
    compressedRefIds: row.compressedRefIds ? safeParseJson<string[] | null>(row.compressedRefIds, null) : null,
    sealed: row.sealed === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSummaryContract(row: Omit<typeof lorebookEntries.$inferSelect, "content" | "comment"> & { contentChars: number; commentChars: number; comment: string | null }): LorebookEntrySummary {
  // toContract's mapping on a row without its content; the placeholder content
  // never leaves this function.
  const { content: _content, comment: _comment, ...rest } = toContract({ ...row, content: "", comment: row.comment });
  return { ...rest, comment: row.comment, contentChars: Number(row.contentChars) || 0, commentChars: Number(row.commentChars) || 0 };
}

function revisionToContract(row: typeof lorebookEntryRevisions.$inferSelect): LorebookRevision {
  return {
    id: row.id,
    entryId: row.entryId,
    userId: row.userId,
    campaignId: row.campaignId ?? null,
    revisionNo: row.revisionNo,
    name: row.name,
    tag: row.tag ?? null,
    content: row.content,
    comment: row.comment ?? null,
    keys: safeParseJson<string[]>(row.keys, []),
    keysSecondary: safeParseJson<string[]>(row.keysSecondary, []),
    knownBy: row.knownBy ? safeParseJson<string[] | null>(row.knownBy, null) : null,
    isEnabled: row.isEnabled === 1,
    isConstant: row.isConstant === 1,
    sticky: row.sticky,
    compressedRefIds: row.compressedRefIds ? safeParseJson<string[] | null>(row.compressedRefIds, null) : null,
    sealed: row.sealed === 1,
    // 0084 dials (null on pre-0084 revisions).
    selectiveLogic: row.selectiveLogic ?? null,
    scanDepth: row.scanDepth ?? null,
    position: row.position ?? null,
    insertionOrder: row.insertionOrder ?? null,
    probability: row.probability ?? null,
    cooldown: row.cooldown ?? null,
    delay: row.delay ?? null,
    excludeRecursion: row.excludeRecursion == null ? null : row.excludeRecursion === 1,
    preventRecursion: row.preventRecursion == null ? null : row.preventRecursion === 1,
    delayUntilRecursion: row.delayUntilRecursion == null ? null : row.delayUntilRecursion === 1,
    matchOptions: row.matchOptionsJson ? safeParseJson<{ caseSensitive?: boolean | null; matchWholeWords?: boolean | null } | null>(row.matchOptionsJson, null) : null,
    source: row.source,
    pipelineRunId: row.pipelineRunId ?? null,
    createdAt: row.createdAt,
  };
}

/** The stored `knownBy` column: normalized names as JSON, null for none. */
function storedKnownBy(knownBy: string[] | null | undefined): string | null {
  const normalized = normalizeKnownBy(knownBy ?? null).knownBy;
  return normalized ? JSON.stringify(normalized) : null;
}

/** The update contract trims `comment`; a stored comment compares equal to the
 *  incoming one as stored or trimmed. */
function sameStoredComment(incoming: string | null, stored: string | null): boolean {
  if (incoming === null) return stored === null;
  return stored !== null && (incoming === stored || incoming === stored.trim());
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
