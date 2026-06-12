import type { CurrentUser, WorkspaceSearchResponse, WorkspaceStateResponse } from "@tracyhill-rp/contracts";
import type {
  CreateFolderRequest,
  SessionCacheTtl,
  CreateSessionRequest,
  SessionEffort,
  SessionThinkingMode,
  UpdateFolderRequest,
  UpdateSessionRequest,
  UpdateWorkspacePreferencesRequest,
} from "@tracyhill-rp/contracts";
import { getDefaultChatModelId } from "@tracyhill-rp/model-catalog";

import { MessageRepository } from "../chat/messageRepository";
import { MessageAttachmentRepository } from "../chat/messageAttachmentRepository";
import { PendingAssistantMessageRepository } from "../chat/pendingAssistantMessageRepository";
import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { CampaignRepository } from "../campaigns/campaignRepository";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { UserRepository } from "../users/userRepository";
import { WIZARD_SESSION_NAME, WIZARD_SESSION_OPENING_ASSISTANT, WIZARD_SESSION_OPENING_USER } from "../wizard/wizardSession";
import { CustomEndpointRepository } from "../providerKeys/customEndpointRepository";
import { resolveChatModelConfig } from "../providerKeys/chatModelConfig";
import type { EmbeddingService } from "../context/embeddingService";
import type { LorebookRepository } from "../context/lorebookRepository";
import { FolderRepository } from "./folderRepository";
import { SessionRepository } from "./sessionRepository";
import { UserPreferencesRepository } from "./userPreferencesRepository";

const RECYCLE_BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FOLDER_DEPTH = 4;

export class WorkspaceService {
  constructor(
    private readonly users: UserRepository,
    private readonly preferences: UserPreferencesRepository,
    private readonly folders: FolderRepository,
    private readonly sessions: SessionRepository,
    private readonly campaigns: CampaignRepository,
    private readonly messages: MessageRepository,
    private readonly attachments: MessageAttachmentRepository,
    private readonly pending: PendingAssistantMessageRepository,
    private readonly generatedImages: GeneratedImageRepository,
    private readonly imageStore: ImageStore,
    private readonly customEndpoints: CustomEndpointRepository,
    private readonly embeddingService?: EmbeddingService | null,
    private readonly lorebook?: LorebookRepository | null,
  ) {}

  getState(userId: string) {
    const user = this.requireCurrentUser(userId);
    const now = new Date().toISOString();
    this.purgeExpiredDeletedSessions(user.id, now);
    const preferences = this.preferences.ensureForUser(user.id, now);
    return {
      user,
      preferences: {
        activeSessionId: preferences.activeSessionId,
        sidebarOpen: Boolean(preferences.sidebarOpen),
        updatedAt: preferences.updatedAt,
      },
      folders: this.folders.listForUser(user.id).map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        position: folder.position,
        collapsed: Boolean(folder.collapsed),
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      })),
      sessions: this.sessions.listForUser(user.id).map((session) => ({
        id: session.id,
        name: session.name,
        sessionType: session.sessionType as "standard" | "wizard",
        campaignId: session.campaignId,
        folderId: session.folderId,
        modelId: session.modelId,
        temperature: session.temperature,
        thinkingMode: session.thinkingMode as SessionThinkingMode,
        thinkingBudget: session.thinkingBudget,
        effort: session.effort as SessionEffort | null,
        cacheTtl: session.cacheTtl as SessionCacheTtl,
        autoScroll: Boolean(session.autoScroll),
        pipelineWatermark: session.pipelineWatermark ?? null,
        contextOverrides: session.contextOverridesJson ? safeParseJson(session.contextOverridesJson, null) : null,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastMessageAt: session.lastMessageAt,
        deletedAt: session.deletedAt,
      })),
    } satisfies WorkspaceStateResponse;
  }

  createFolder(userId: string, input: CreateFolderRequest) {
    const user = this.requireCurrentUser(userId);
    const now = new Date().toISOString();
    this.preferences.ensureForUser(user.id, now);
    const parentId = input.parentId ?? null;
    if (parentId) this.requireFolderCreateDepth(user.id, parentId);
    this.folders.createFolder({
      id: createId(),
      userId: user.id,
      name: input.name.trim(),
      parentId,
      position: this.folders.nextPosition(user.id),
      collapsed: 0,
      createdAt: now,
      updatedAt: now,
    });
    return this.getState(user.id);
  }

  updateFolder(userId: string, folderId: string, input: UpdateFolderRequest) {
    const user = this.requireCurrentUser(userId);
    const folder = this.folders.findById(user.id, folderId);
    if (!folder) throw new HttpError(404, "folder not found");
    if (Object.prototype.hasOwnProperty.call(input, "parentId")) {
      this.validateFolderMove(user.id, folderId, input.parentId ?? null);
    }
    const next = {
      updatedAt: new Date().toISOString(),
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "parentId") ? { parentId: input.parentId ?? null } : {}),
      ...(typeof input.collapsed === "boolean" ? { collapsed: input.collapsed ? 1 : 0 } : {}),
    };
    this.folders.updateFolder(user.id, folderId, next);
    return this.getState(user.id);
  }

  deleteFolder(userId: string, folderId: string) {
    const user = this.requireCurrentUser(userId);
    const folder = this.folders.findById(user.id, folderId);
    if (!folder) throw new HttpError(404, "folder not found");
    const now = new Date().toISOString();
    this.folders.transact(() => {
      this.sessions.reassignFolder(user.id, folderId, folder.parentId ?? null, now);
      this.campaigns.reassignFolder(user.id, folderId, folder.parentId ?? null);
      this.folders.reassignParent(user.id, folderId, folder.parentId ?? null, now);
      this.folders.deleteFolder(user.id, folderId);
    });
    return this.getState(user.id);
  }

  createSession(userId: string, input: CreateSessionRequest) {
    const user = this.requireCurrentUser(userId);
    const now = new Date().toISOString();
    const sessionType = input.sessionType ?? "standard";
    if (sessionType === "wizard" && this.sessions.findActiveWizardForUser(user.id)) throw new HttpError(409, "an active wizard session already exists");
    if (sessionType !== "wizard" && input.folderId) this.requireFolder(user.id, input.folderId);
    if (sessionType !== "wizard" && input.campaignId) this.requireCampaign(user.id, input.campaignId);
    const modelId = this.requireModel(user.id, input.modelId);
    const defaults = getSessionRuntimeDefaults(this.customEndpoints, user.id, modelId);
    const sessionId = createId();
    const openingMessages = sessionType === "wizard"
      ? [
          { id: createId(), role: "user" as const, content: WIZARD_SESSION_OPENING_USER, sortOrder: 0 },
          { id: createId(), role: "assistant" as const, content: WIZARD_SESSION_OPENING_ASSISTANT, sortOrder: 1 },
        ]
      : [];
    this.sessions.createSession({
      id: sessionId,
      userId: user.id,
      sessionType,
      campaignId: sessionType === "wizard" ? null : input.campaignId ?? null,
      folderId: sessionType === "wizard" ? null : input.folderId ?? null,
      name: input.name?.trim() || (sessionType === "wizard" ? WIZARD_SESSION_NAME : "New Session"),
      modelId,
      temperature: defaults.temperature,
      thinkingMode: defaults.thinkingMode,
      thinkingBudget: defaults.thinkingBudget,
      effort: defaults.effort,
      cacheTtl: defaults.cacheTtl,
      autoScroll: 0,
      messageCount: openingMessages.length,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: openingMessages.length ? now : null,
    });
    for (const message of openingMessages) {
      this.messages.createMessage({
        id: message.id,
        sessionId,
        userId: user.id,
        role: message.role,
        content: message.content,
        modelId: message.role === "assistant" ? modelId : null,
        sortOrder: message.sortOrder,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.preferences.ensureForUser(user.id, now);
    this.preferences.updateForUser(user.id, { activeSessionId: sessionId, updatedAt: now });
    return this.getState(user.id);
  }

  startSessionFromCampaign(userId: string, campaignId: string) {
    const user = this.requireCurrentUser(userId);
    const campaign = this.requireCampaign(user.id, campaignId);
    const now = new Date().toISOString();
    const modelId = this.requireModel(user.id, campaign.pipelineModelId ?? getDefaultChatModelId());
    const defaults = getSessionRuntimeDefaults(this.customEndpoints, user.id, modelId);
    const sessionId = createId();
    const partNumber = this.sessions.listForUser(user.id).filter((session) => session.campaignId === campaignId).length + 1;
    const folderId = campaign.folderId && this.folders.findById(user.id, campaign.folderId) ? campaign.folderId : null;
    this.sessions.createSession({
      id: sessionId,
      userId: user.id,
      sessionType: "standard",
      campaignId,
      folderId,
      name: `${campaign.name} Part ${partNumber}`,
      modelId,
      temperature: defaults.temperature,
      thinkingMode: defaults.thinkingMode,
      thinkingBudget: defaults.thinkingBudget,
      effort: defaults.effort,
      cacheTtl: defaults.cacheTtl,
      autoScroll: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    });
    this.preferences.ensureForUser(user.id, now);
    this.preferences.updateForUser(user.id, { activeSessionId: sessionId, updatedAt: now });
    return this.getState(user.id);
  }

  updateSession(userId: string, sessionId: string, input: UpdateSessionRequest) {
    const user = this.requireCurrentUser(userId);
    const session = this.sessions.findActiveById(user.id, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (typeof input.folderId === "string") this.requireFolder(user.id, input.folderId);
    if (typeof input.campaignId === "string") this.requireCampaign(user.id, input.campaignId);
    const modelId = Object.prototype.hasOwnProperty.call(input, "modelId") ? this.requireModel(user.id, input.modelId) : null;
    const nextModelId = modelId ?? session.modelId;
    const runtimeDefaults = getSessionRuntimeDefaults(this.customEndpoints, user.id, nextModelId);
    const nextCacheTtl = normalizeCacheTtl(this.customEndpoints, user.id, nextModelId, Object.prototype.hasOwnProperty.call(input, "cacheTtl")
      ? input.cacheTtl ?? runtimeDefaults.cacheTtl
      : modelId
        ? runtimeDefaults.cacheTtl
        : session.cacheTtl as SessionCacheTtl);
    this.sessions.updateSession(user.id, sessionId, {
      updatedAt: new Date().toISOString(),
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "folderId") ? { folderId: input.folderId ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "campaignId") ? { campaignId: input.campaignId ?? null } : {}),
      ...(modelId ? { modelId } : {}),
      temperature: typeof input.temperature === "number" ? input.temperature : session.temperature,
      thinkingMode: modelId ? (input.thinkingMode ?? runtimeDefaults.thinkingMode) : (Object.prototype.hasOwnProperty.call(input, "thinkingMode") ? input.thinkingMode ?? session.thinkingMode : session.thinkingMode),
      thinkingBudget: modelId
        ? (Object.prototype.hasOwnProperty.call(input, "thinkingBudget") ? input.thinkingBudget : runtimeDefaults.thinkingBudget)
        : (Object.prototype.hasOwnProperty.call(input, "thinkingBudget") ? input.thinkingBudget : session.thinkingBudget),
      effort: modelId
        ? (Object.prototype.hasOwnProperty.call(input, "effort") ? input.effort : runtimeDefaults.effort)
        : (Object.prototype.hasOwnProperty.call(input, "effort") ? input.effort : session.effort),
      cacheTtl: nextCacheTtl,
      ...(typeof input.autoScroll === "boolean" ? { autoScroll: input.autoScroll ? 1 : 0 } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "contextOverrides") && input.contextOverrides
        ? { contextOverridesJson: JSON.stringify({ ...safeParseJson(session.contextOverridesJson, {}), ...input.contextOverrides }) }
        : {}),
    });
    if (input.contextOverrides?.embeddingModel && this.embeddingService && this.lorebook && session.campaignId) {
      const newModel = input.contextOverrides.embeddingModel;
      const entries = this.lorebook.listEnabledForCampaign(user.id, session.campaignId);
      this.embeddingService.indexEntries(entries.map(e => ({ id: e.id, userId: e.userId, content: e.content })), newModel).catch(() => { /* best-effort re-embed on model switch */ });
    }
    return this.getState(user.id);
  }

  deleteSession(userId: string, sessionId: string) {
    const user = this.requireCurrentUser(userId);
    const session = this.sessions.findById(user.id, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.sessionType === "wizard") {
      const now = new Date().toISOString();
      const preferences = this.preferences.ensureForUser(user.id, now);
      const nextActive = preferences.activeSessionId === sessionId
        ? this.sessions.listActiveForUser(user.id).find((candidate) => candidate.id !== sessionId)?.id ?? null
        : preferences.activeSessionId;
      this.destroySessionArtifacts(user.id, sessionId);
      if (preferences.activeSessionId === sessionId) {
        this.preferences.updateForUser(user.id, { activeSessionId: nextActive, updatedAt: now });
      }
      return this.getState(user.id);
    }
    if (session.deletedAt) return this.getState(user.id);
    const now = new Date().toISOString();
    this.sessions.softDeleteSession(user.id, sessionId, now);
    const preferences = this.preferences.ensureForUser(user.id, now);
    if (preferences.activeSessionId === sessionId) {
      const nextActive = this.sessions.listActiveForUser(user.id).find((candidate) => candidate.id !== sessionId)?.id ?? null;
      this.preferences.updateForUser(user.id, { activeSessionId: nextActive, updatedAt: now });
    }
    return this.getState(user.id);
  }

  restoreSession(userId: string, sessionId: string) {
    const user = this.requireCurrentUser(userId);
    const session = this.sessions.findById(user.id, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (!session.deletedAt) return this.getState(user.id);
    const now = new Date().toISOString();
    this.sessions.restoreSession(user.id, sessionId, now);
    return this.getState(user.id);
  }

  permanentlyDeleteSession(userId: string, sessionId: string) {
    const user = this.requireCurrentUser(userId);
    const session = this.sessions.findById(user.id, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (!session.deletedAt) throw new HttpError(400, "session must be in recycle bin before permanent delete");
    this.destroySessionArtifacts(user.id, sessionId);
    return this.getState(user.id);
  }

  emptyRecycleBin(userId: string) {
    const user = this.requireCurrentUser(userId);
    for (const session of this.sessions.listDeletedForUser(user.id)) {
      this.destroySessionArtifacts(user.id, session.id);
    }
    return this.getState(user.id);
  }

  updatePreferences(userId: string, input: UpdateWorkspacePreferencesRequest) {
    const user = this.requireCurrentUser(userId);
    const now = new Date().toISOString();
    const current = this.preferences.ensureForUser(user.id, now);
    if (typeof input.activeSessionId === "string") this.requireActiveSession(user.id, input.activeSessionId);
    this.preferences.updateForUser(user.id, {
      activeSessionId: Object.prototype.hasOwnProperty.call(input, "activeSessionId") ? input.activeSessionId ?? null : current.activeSessionId,
      sidebarOpen: typeof input.sidebarOpen === "boolean" ? (input.sidebarOpen ? 1 : 0) : current.sidebarOpen,
      updatedAt: now,
    });
    return this.getState(user.id);
  }

  search(userId: string, rawQuery: string) {
    const user = this.requireCurrentUser(userId);
    const query = rawQuery.trim();
    if (query.length < 2) return { query, results: [] } satisfies WorkspaceSearchResponse;
    const needle = query.toLocaleLowerCase();
    const sessions = this.sessions.listActiveForUser(user.id).filter((session) => session.sessionType !== "wizard");
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const sessionResults = sessions
      .filter((session) => session.name.toLocaleLowerCase().includes(needle))
      .map((session) => ({
        type: "session" as const,
        sessionId: session.id,
        sessionName: session.name,
        messageId: null,
        role: null,
        excerpt: `Session name match: ${session.name}`,
        updatedAt: session.updatedAt,
      }));
    const messageResults = this.messages.searchFts(user.id, query)
      .map((message) => {
        const session = sessionMap.get(message.sessionId);
        if (!session) return null;
        return {
          type: "message" as const,
          sessionId: session.id,
          sessionName: session.name,
          messageId: message.id,
          role: message.role as "user" | "assistant",
          excerpt: this.buildSearchExcerpt(message.content, query),
          updatedAt: message.updatedAt,
        };
      })
      .filter((result): result is NonNullable<typeof result> => Boolean(result));
    const results = [...sessionResults, ...messageResults]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 25);
    return { query, results } satisfies WorkspaceSearchResponse;
  }

  private requireCurrentUser(userId: string): CurrentUser {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    return { id: user.id, username: user.username, role: user.role as CurrentUser["role"] };
  }

  private requireFolder(userId: string, folderId: string) {
    const folder = this.folders.findById(userId, folderId);
    if (!folder) throw new HttpError(404, "folder not found");
    return folder;
  }

  private requireFolderCreateDepth(userId: string, parentId: string) {
    this.requireFolder(userId, parentId);
    if (this.getFolderDepth(userId, parentId) >= MAX_FOLDER_DEPTH) throw new HttpError(400, "folder depth exceeded");
  }

  private validateFolderMove(userId: string, folderId: string, parentId: string | null) {
    if (!parentId) return;
    if (parentId === folderId) throw new HttpError(400, "folder cannot be its own parent");
    this.requireFolder(userId, parentId);
    const descendants = new Set(this.getDescendantFolderIds(userId, folderId));
    if (descendants.has(parentId)) throw new HttpError(400, "folder cannot move inside its own subtree");
    const targetDepth = this.getFolderDepth(userId, parentId);
    const subtreeHeight = this.getFolderSubtreeHeight(userId, folderId);
    if (targetDepth + subtreeHeight > MAX_FOLDER_DEPTH) throw new HttpError(400, "folder depth exceeded");
  }

  private getFolderDepth(userId: string, folderId: string) {
    const folders = this.folders.listForUser(userId);
    let depth = 0;
    let currentId: string | null = folderId;
    while (currentId) {
      const current = folders.find((folder) => folder.id === currentId);
      if (!current) break;
      currentId = current.parentId;
      depth += 1;
      if (depth > 32) break;
    }
    return depth;
  }

  private getDescendantFolderIds(userId: string, folderId: string) {
    const folders = this.folders.listForUser(userId);
    const ids = [folderId];
    const queue = [folderId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const child of folders.filter((folder) => folder.parentId === current)) {
        ids.push(child.id);
        queue.push(child.id);
      }
    }
    return ids;
  }

  private getFolderSubtreeHeight(userId: string, folderId: string) {
    const folders = this.folders.listForUser(userId);
    const height = (currentId: string): number => {
      const children = folders.filter((folder) => folder.parentId === currentId);
      if (!children.length) return 1;
      return 1 + Math.max(...children.map((child) => height(child.id)));
    };
    return height(folderId);
  }

  private requireCampaign(userId: string, campaignId: string) {
    const campaign = this.campaigns.findById(userId, campaignId);
    if (!campaign) throw new HttpError(404, "campaign not found");
    return campaign;
  }

  private requireActiveSession(userId: string, sessionId: string) {
    const session = this.sessions.findActiveById(userId, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    return session;
  }

  private requireModel(userId: string, modelId: string | undefined) {
    const resolved = modelId?.trim() || getDefaultChatModelId();
    if (!resolveChatModelConfig(this.customEndpoints, userId, resolved)) throw new HttpError(400, "unsupported model");
    return resolved;
  }

  private buildSearchExcerpt(content: string, query: string) {
    const compact = content.replace(/\s+/g, " ").trim();
    if (!compact) return "(empty message)";
    const needle = query.toLocaleLowerCase();
    const index = compact.toLocaleLowerCase().indexOf(needle);
    if (index === -1) return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
    const start = Math.max(0, index - 48);
    const end = Math.min(compact.length, index + query.length + 96);
    return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
  }

  private purgeExpiredDeletedSessions(userId: string, now: string) {
    const cutoff = Date.parse(now) - RECYCLE_BIN_RETENTION_MS;
    const preferences = this.preferences.ensureForUser(userId, now);
    let activeSessionPurged = false;
    for (const session of this.sessions.listDeletedForUser(userId)) {
      const deletedAt = session.deletedAt ? Date.parse(session.deletedAt) : Number.NaN;
      if (!Number.isFinite(deletedAt) || deletedAt > cutoff) continue;
      if (preferences.activeSessionId === session.id) activeSessionPurged = true;
      this.destroySessionArtifacts(userId, session.id);
    }
    if (activeSessionPurged) {
      this.preferences.updateForUser(userId, { activeSessionId: null, updatedAt: now });
    }
  }

  private destroySessionArtifacts(userId: string, sessionId: string) {
    for (const image of this.generatedImages.listForSession(userId, sessionId)) {
      this.imageStore.delete(image.id, image.mimeType);
    }
    this.generatedImages.deleteForSession(userId, sessionId);
    this.attachments.deleteForSession(userId, sessionId);
    this.pending.deleteForSession(userId, sessionId);
    this.messages.deleteForSession(userId, sessionId);
    this.lorebook?.clearActivationState(sessionId);
    this.sessions.deleteSession(userId, sessionId);
  }
}

function getSessionRuntimeDefaults(endpoints: CustomEndpointRepository, userId: string, modelId: string) {
  const model = resolveChatModelConfig(endpoints, userId, modelId);
  if (model?.provider === "anthropic") {
    return {
      temperature: 1,
      thinkingMode: model.supportsAdaptiveThinking ? "adaptive" as const : "enabled" as const,
      thinkingBudget: model.maxThinkingBudget ?? 4095,
      effort: model.defaultEffort ?? null,
      cacheTtl: "1h" as const,
    };
  }
  // Bridge variants (claude-code) would otherwise fall through to the
  // thinkingMode:"off" fallback, resetting thinking to off on every model
  // switch. Default them to adaptive thinking + max effort; haiku-bridge
  // (no adaptive/effort) lands on enabled thinking at its max budget.
  if (model?.provider === "claude-code") {
    return {
      temperature: 1,
      thinkingMode: model.supportsAdaptiveThinking ? "adaptive" as const : "enabled" as const,
      thinkingBudget: model.maxThinkingBudget ?? 4095,
      effort: model.supportsEffort ? "max" as const : null,
      cacheTtl: "off" as const,
    };
  }
  if (model?.provider === "google" && model.supportsThinkingBudget) {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: model.maxThinkingBudget ?? 24576,
      effort: null,
      cacheTtl: "off" as const,
    };
  }
  if (model?.provider === "google" && model.supportsEffort) {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: null,
      effort: model.defaultEffort ?? "high",
      cacheTtl: "off" as const,
    };
  }
  if (model?.provider === "openai" && model.supportsEffort) {
    return {
      temperature: 1,
      thinkingMode: "off" as const,
      thinkingBudget: null,
      effort: model.defaultEffort ?? "high",
      cacheTtl: "off" as const,
    };
  }
  // xai (and any other effort-capable provider without a dedicated branch):
  // honor the catalog defaultEffort — grok-4.3 used to fall through to the
  // effort:null fallback on every model switch, the exact drift class the
  // 2026-06-01 claude-code fix addressed.
  if (model?.provider === "xai" && model.supportsEffort) {
    return {
      temperature: 1,
      thinkingMode: "off" as const,
      thinkingBudget: null,
      effort: model.defaultEffort ?? "low",
      cacheTtl: "off" as const,
    };
  }
  if (model?.provider === "zai") {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off" as const,
    };
  }
  // DeepSeek V4 thinking is a simple on/off toggle. Default ON — matches the
  // server-side default (thinking runs when the param is omitted), so existing
  // behavior is preserved exactly; the Off toggle is the new, additive option.
  if (model?.provider === "deepseek") {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off" as const,
    };
  }
  // Xiaomi MiMo thinking is a simple on/off toggle (Off ↔ On in the composer).
  // Verified against the live API (2026-06-12): thinking-on works across full
  // multi-turn conversations with no special handling. Default OFF purely to
  // keep RP turns fast/cheap by default — users flip it On for any/every turn
  // from the composer and it works the whole way through.
  if (model?.provider === "xiaomi") {
    return {
      temperature: 1,
      thinkingMode: "off" as const,
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off" as const,
    };
  }
  return {
    temperature: 1,
    thinkingMode: "off" as const,
    thinkingBudget: null,
    effort: null,
    cacheTtl: "off" as const,
  };
}

function normalizeCacheTtl(endpoints: CustomEndpointRepository, userId: string, modelId: string, cacheTtl: SessionCacheTtl) {
  const model = resolveChatModelConfig(endpoints, userId, modelId);
  if (!model?.supportsCacheTtl) return "off" as const;
  return cacheTtl;
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
