import type { CampaignsListResponse, CampaignVersionsResponse, CreateCampaignRequest, UpdateCampaignRequest } from "@tracyhill-rp/contracts";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { UserRepository } from "../users/userRepository";
import { FolderRepository } from "../workspace/folderRepository";
import { LorebookRepository } from "../context/lorebookRepository";
import { CampaignRepository } from "./campaignRepository";
import { CampaignVersionRepository } from "./campaignVersionRepository";
import { SessionRepository } from "../workspace/sessionRepository";

export class CampaignService {
  constructor(
    private readonly users: UserRepository,
    private readonly campaigns: CampaignRepository,
    private readonly versions: CampaignVersionRepository,
    private readonly folders: FolderRepository,
    private readonly lorebook?: LorebookRepository,
    private readonly sessions?: SessionRepository,
  ) {}

  list(userId: string): CampaignsListResponse {
    this.requireUser(userId);
    const counts = this.lorebook?.countPerCampaign(userId);
    return {
      campaigns: this.campaigns.listForUser(userId).map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        folderId: campaign.folderId,
        systemPrompt: campaign.systemPrompt,
        version: campaign.version,
        ...this.resolveFromNewestSession(userId, campaign.id),
        ...readAntiRepetitionState(campaign.antiRepetitionJson),
        lorebookEntryCount: counts?.get(campaign.id) ?? 0,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      })),
    };
  }

  // (see readAntiRepetitionState below)

  /** The PC identity for campaign-wide surfaces, resolved from the campaign's most
   *  recent live session. Settings are per-session (0077), so a campaign has no
   *  identity of its own — this mirrors how a new session clones the newest
   *  session's dials. */
  private resolveFromNewestSession(userId: string, campaignId: string): { playerCharacterKeys: string[]; embeddingModel: string | null } {
    const sessions = this.sessions?.listForCampaign(userId, campaignId) ?? [];
    const newest = [...sessions].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
    const dials = safeParseJson<{ playerCharacterKeys?: unknown; embeddingModel?: unknown }>(newest?.contextOverridesJson ?? null, {}) ?? {};
    return {
      playerCharacterKeys: Array.isArray(dials.playerCharacterKeys) ? dials.playerCharacterKeys.map(String).filter(Boolean) : [],
      embeddingModel: typeof dials.embeddingModel === "string" && dials.embeddingModel ? dials.embeddingModel : null,
    };
  }

  create(userId: string, input: CreateCampaignRequest) {
    this.requireUser(userId);
    const now = new Date().toISOString();
    this.campaigns.createCampaign({
      id: createId(),
      userId,
      name: input.name.trim(),
      folderId: this.resolveFolderId(userId, input.folderId),
      systemPrompt: input.systemPrompt.trim(),
      version: input.version,
      createdAt: now,
      updatedAt: now,
    });
    return this.list(userId);
  }

  update(userId: string, campaignId: string, input: UpdateCampaignRequest) {
    this.requireUser(userId);
    this.campaigns.transact(() => {
      const current = this.campaigns.findById(userId, campaignId);
      if (!current) throw new HttpError(404, "campaign not found");
      // Treat empty systemPrompt as "no change" so an accidental wipe doesn't
      // archive the prior prompt and leave the live campaign with no prompt.
      // To actually clear, the caller should send a deletion endpoint (TBD) or
      // use the version-restore path.
      const nextSystemPrompt = Object.prototype.hasOwnProperty.call(input, "systemPrompt")
        ? (input.systemPrompt?.trim() || current.systemPrompt)
        : current.systemPrompt;
      const hasVersionOverride = Object.prototype.hasOwnProperty.call(input, "version");
      const contentChanged = nextSystemPrompt !== current.systemPrompt;
      const nextVersion = hasVersionOverride ? input.version ?? current.version : (contentChanged ? current.version + 1 : current.version);
      const folderPatch = Object.prototype.hasOwnProperty.call(input, "folderId") ? { folderId: this.resolveFolderId(userId, input.folderId) } : {};
      const now = new Date().toISOString();
      if (contentChanged) {
        this.versions.createVersion({
          id: createId(),
          campaignId: current.id,
          userId,
          version: current.version,
          systemPrompt: current.systemPrompt,
          createdAt: now,
          label: null,
        });
      }
      // No contextDefaults write path (0077): campaign-scoped settings are retired.
      // Accepting writes into a tier nothing resolves is how `playerCharacterKeys`
      // appeared settable in the campaign editor while doing precisely nothing.
      this.campaigns.updateCampaign(userId, campaignId, {
        updatedAt: now,
        ...(input.name ? { name: input.name.trim() } : {}),
        ...folderPatch,
        ...(Object.prototype.hasOwnProperty.call(input, "systemPrompt") ? { systemPrompt: nextSystemPrompt } : {}),
        ...(nextVersion !== current.version ? { version: nextVersion } : {}),
      });
    });
    return this.list(userId);
  }

  delete(userId: string, campaignId: string) {
    this.requireUser(userId);
    const current = this.campaigns.findById(userId, campaignId);
    if (!current) throw new HttpError(404, "campaign not found");
    // One transaction for the whole cascade: the repository sweeps
    // every campaign-keyed table; sessions are unlinked inside it so a failure
    // mid-way leaves nothing half-deleted.
    this.campaigns.deleteCampaign(userId, campaignId, () => {
      this.sessions?.clearCampaignForSessions(userId, campaignId);
    });
    return this.list(userId);
  }

  listVersions(userId: string, campaignId: string): CampaignVersionsResponse {
    this.requireUser(userId);
    const current = this.campaigns.findById(userId, campaignId);
    if (!current) throw new HttpError(404, "campaign not found");
    const archived = this.versions.listForCampaign(userId, campaignId).map((version) => ({
      // The row's id is what a restore by history row names; the current row has none.
      id: version.id,
      version: version.version,
      systemPrompt: version.systemPrompt,
      createdAt: version.createdAt,
      isCurrent: false,
      label: version.label ?? null,
    }));
    return {
      campaignId,
      versions: [{
        id: null,
        version: current.version,
        systemPrompt: current.systemPrompt,
        createdAt: current.updatedAt,
        isCurrent: true,
        label: null,
      }, ...archived],
    };
  }

  restoreVersion(userId: string, campaignId: string, version: number, archiveId?: string) {
    this.requireUser(userId);
    // One (IMMEDIATE) transaction around the read AND the archive+update
    // pair, through the same version-guarded bump the sysprompt-audit worker
    // uses. Two autocommit writes with no guard let a worker bump land between
    // the read and the update: the restore then archived a stale snapshot,
    // the worker's applied prompt was never archived, and one version number
    // meant two prompts.
    return this.campaigns.transact(() => {
      const current = this.campaigns.findById(userId, campaignId);
      if (!current) throw new HttpError(404, "campaign not found");
      // `archiveId` names the exact history row the reader chose: a number cannot, since a Version edit
      // can rewind the counter, leaving two unlabeled archives with one number or an archive with the current
      // row's number. Without it (older clients) the number path is unchanged: the current number is a no-op
      // and otherwise the newest unlabeled archive with that number is restored. Labeled rows (pre-restore
      // snapshots) are not restore targets on either path.
      if (archiveId === undefined && current.version === version) return this.list(userId);
      const archived = archiveId !== undefined
        ? this.versions.findById(userId, campaignId, archiveId)
        : this.versions.findByVersion(userId, campaignId, version);
      if (!archived || archived.label != null) throw new HttpError(404, "campaign version not found");
      const now = new Date().toISOString();
      const applied = this.campaigns.bumpVersionWithArchive(userId, campaignId, {
        archive: {
          id: createId(),
          campaignId: current.id,
          userId,
          version: current.version,
          systemPrompt: current.systemPrompt,
          createdAt: now,
          label: `Restored-V${archived.version}-${now}`,
        },
        nextSystemPrompt: archived.systemPrompt,
        // Restore the CONTENT but keep the version counter monotonic: rewinding
        // it produced duplicate unlabeled version numbers on the next edit and
        // permanently shadowed historical archives in findByVersion.
        nextVersion: current.version + 1,
        updatedAt: now,
        expectedVersion: current.version,
        expectedPrompt: current.systemPrompt,
      });
      if (!applied) throw new HttpError(409, "campaign changed while restoring — reload the version history and try again");
      return this.list(userId);
    });
  }

  private requireUser(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    return user;
  }

  private resolveFolderId(userId: string, folderId: string | null | undefined) {
    if (!folderId) return null;
    if (!this.folders.findById(userId, folderId)) throw new HttpError(400, "folder not found");
    return folderId;
  }
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Anti-repetition rules live in their own column since 0077 (they are campaign
 *  STATE the repetition worker rewrites, not a user setting). Surfaced read-only
 *  for the Android rules viewer. */
function readAntiRepetitionState(raw: string | null | undefined): { antiRepetitionRules: unknown[]; archivedAntiRepetitionRules: unknown[] } {
  const parsed = safeParseJson<{ antiRepetitionRules?: unknown; archivedAntiRepetitionRules?: unknown }>(raw ?? null, {}) ?? {};
  return {
    antiRepetitionRules: Array.isArray(parsed.antiRepetitionRules) ? parsed.antiRepetitionRules : [],
    archivedAntiRepetitionRules: Array.isArray(parsed.archivedAntiRepetitionRules) ? parsed.archivedAntiRepetitionRules : [],
  };
}
