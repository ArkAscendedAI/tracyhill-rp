import type { CampaignsListResponse, CampaignVersionsResponse, CreateCampaignRequest, UpdateCampaignRequest } from "@tracyhill-rp/contracts";
import { getDefaultChatModelId } from "@tracyhill-rp/model-catalog";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { CustomEndpointRepository } from "../providerKeys/customEndpointRepository";
import { resolveChatModelConfig } from "../providerKeys/chatModelConfig";
import { UserRepository } from "../users/userRepository";
import { FolderRepository } from "../workspace/folderRepository";
import { LorebookRepository } from "../context/lorebookRepository";
import type { CharacterAttireRepository } from "../chat/characterAttireRepository";
import { CampaignRepository } from "./campaignRepository";
import { CampaignVersionRepository } from "./campaignVersionRepository";
import { SessionRepository } from "../workspace/sessionRepository";

export class CampaignService {
  constructor(
    private readonly users: UserRepository,
    private readonly campaigns: CampaignRepository,
    private readonly versions: CampaignVersionRepository,
    private readonly customEndpoints: CustomEndpointRepository,
    private readonly folders: FolderRepository,
    private readonly lorebook?: LorebookRepository,
    private readonly attireRepo?: CharacterAttireRepository,
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
        pipelineModelId: campaign.pipelineModelId,
        systemPrompt: campaign.systemPrompt,
        version: campaign.version,
        contextDefaults: campaign.contextDefaultsJson ? safeParseJson(campaign.contextDefaultsJson, null) : null,
        lorebookEntryCount: counts?.get(campaign.id) ?? 0,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      })),
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
      pipelineModelId: this.requirePipelineModel(userId, input.pipelineModelId),
      systemPrompt: input.systemPrompt.trim(),
      version: input.version,
      createdAt: now,
      updatedAt: now,
    });
    return this.list(userId);
  }

  update(userId: string, campaignId: string, input: UpdateCampaignRequest) {
    this.requireUser(userId);
    const current = this.campaigns.findById(userId, campaignId);
    if (!current) throw new HttpError(404, "campaign not found");
    const nextPipelineModelId = Object.prototype.hasOwnProperty.call(input, "pipelineModelId")
      ? this.requirePipelineModel(userId, input.pipelineModelId)
      : current.pipelineModelId;
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
    const contextDefaultsUpdate = Object.prototype.hasOwnProperty.call(input, "contextDefaults") && input.contextDefaults
      ? { contextDefaultsJson: JSON.stringify({ ...safeParseJson(current.contextDefaultsJson, {}), ...input.contextDefaults }) }
      : {};
    this.campaigns.updateCampaign(userId, campaignId, {
      updatedAt: now,
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "folderId") ? { folderId: this.resolveFolderId(userId, input.folderId) } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "pipelineModelId") ? { pipelineModelId: nextPipelineModelId } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "systemPrompt") ? { systemPrompt: nextSystemPrompt } : {}),
      ...(nextVersion !== current.version ? { version: nextVersion } : {}),
      ...contextDefaultsUpdate,
    });
    return this.list(userId);
  }

  delete(userId: string, campaignId: string) {
    this.requireUser(userId);
    const current = this.campaigns.findById(userId, campaignId);
    if (!current) throw new HttpError(404, "campaign not found");
    this.versions.deleteForCampaign(userId, campaignId);
    this.attireRepo?.deleteForCampaign(campaignId);
    this.campaigns.deleteCampaign(userId, campaignId);
    this.sessions?.clearCampaignForSessions(userId, campaignId);
    return this.list(userId);
  }

  listVersions(userId: string, campaignId: string): CampaignVersionsResponse {
    this.requireUser(userId);
    const current = this.campaigns.findById(userId, campaignId);
    if (!current) throw new HttpError(404, "campaign not found");
    const archived = this.versions.listForCampaign(userId, campaignId).map((version) => ({
      version: version.version,
      systemPrompt: version.systemPrompt,
      createdAt: version.createdAt,
      isCurrent: false,
      label: version.label ?? null,
    }));
    return {
      campaignId,
      versions: [{
        version: current.version,
        systemPrompt: current.systemPrompt,
        createdAt: current.updatedAt,
        isCurrent: true,
        label: null,
      }, ...archived],
    };
  }

  restoreVersion(userId: string, campaignId: string, version: number) {
    this.requireUser(userId);
    const current = this.campaigns.findById(userId, campaignId);
    if (!current) throw new HttpError(404, "campaign not found");
    if (current.version === version) return this.list(userId);
    const archived = this.versions.findByVersion(userId, campaignId, version);
    if (!archived) throw new HttpError(404, "campaign version not found");
    const now = new Date().toISOString();
    this.versions.createVersion({
      id: createId(),
      campaignId: current.id,
      userId,
      version: current.version,
      systemPrompt: current.systemPrompt,
      createdAt: now,
      label: `Restored-V${version}-${now}`,
    });
    this.campaigns.updateCampaign(userId, campaignId, {
      systemPrompt: archived.systemPrompt,
      // Restore the CONTENT but keep the version counter monotonic: rewinding
      // it produced duplicate unlabeled version numbers on the next edit and
      // permanently shadowed historical archives in findByVersion.
      version: current.version + 1,
      updatedAt: now,
    });
    return this.list(userId);
  }

  private requireUser(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    return user;
  }

  private requirePipelineModel(userId: string, modelId: string | undefined) {
    const resolved = modelId?.trim() || getDefaultChatModelId();
    if (!resolveChatModelConfig(this.customEndpoints, userId, resolved)) throw new HttpError(400, "pipeline model not found");
    return resolved;
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
