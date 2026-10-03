import type { ContextAdminOnlyDial, CurrentUser, WorkspaceSearchResponse, WorkspaceStateResponse } from "@tracyhill-rp/contracts";
import { CONTEXT_ADMIN_ONLY_DIALS, CONTEXT_MODEL_ID_DIALS, CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS } from "@tracyhill-rp/contracts";
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
import { DEFAULT_EMBEDDING_MODEL, getDefaultChatModelId } from "@tracyhill-rp/model-catalog";
import { createLogger } from "@tracyhill-rp/logging";

import { MessageRepository } from "../chat/messageRepository";
import { MessageAttachmentRepository } from "../chat/messageAttachmentRepository";
import { PendingAssistantMessageRepository } from "../chat/pendingAssistantMessageRepository";
import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { sliceUnits, tailUnits } from "../../lib/textUnits";
import { CampaignRepository } from "../campaigns/campaignRepository";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { UserRepository } from "../users/userRepository";
import { WIZARD_SESSION_NAME, WIZARD_SESSION_OPENING_ASSISTANT, WIZARD_SESSION_OPENING_USER } from "../wizard/wizardSession";
import { CustomEndpointRepository } from "../providerKeys/customEndpointRepository";
import type { StartingModels } from "../providerKeys/defaultModels";
import { resolveChatModelConfig } from "../providerKeys/chatModelConfig";
import type { EmbeddingService } from "../context/embeddingService";
import type { LorebookRepository } from "../context/lorebookRepository";
import { recordSystemEvent } from "../system/systemEvents";
import { FolderRepository } from "./folderRepository";
import { SessionRepository } from "./sessionRepository";
import { UserPreferencesRepository } from "./userPreferencesRepository";

const RECYCLE_BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FOLDER_DEPTH = 4;
// FTS candidates fetched before the session-liveness filter. `searchFts` LIMITs
// on rank BEFORE this service can drop recycle-bin/wizard sessions, so a common
// term whose best-ranked hits live in deleted sessions used to hide live matches.
// Over-fetch, filter, then apply the user-facing cap.
const SEARCH_RESULT_LIMIT = 25;
const SEARCH_FTS_CANDIDATE_LIMIT = 200;
const workspaceLogger = createLogger("workspace-service");

// How the Engine dialog names the admin-only dials, for the 403 message.
const ADMIN_ONLY_DIAL_LABELS: Record<ContextAdminOnlyDial, string> = {
  worldStance: "World stance",
  depictionTier: "Depiction tier",
  antagonistModel: "Antagonist model",
  storytellerPacing: "Threat pacing",
  worldStateExtractionEnabled: "Record world state",
  worldStateModel: "World-state model",
  contestedOutcomesEnabled: "Contested outcomes",
};

/**
 * The session's effective value of an admin-only dial, with the engine's
 * `resolveSettings` semantics for these seven: the stored override when there is
 * one (a blank model id reads as absent), else the contract default. The
 * deployment default model never applies to them (they are outside
 * CONTEXT_DEFAULT_MODEL_DIALS), so no DEFAULT_MODEL_ID layer is needed here.
 */
function effectiveAdminOnlyDial(stored: Record<string, unknown>, dial: ContextAdminOnlyDial): unknown {
  const raw = Object.prototype.hasOwnProperty.call(stored, dial) ? stored[dial] : undefined;
  const blankModelId = (CONTEXT_MODEL_ID_DIALS as readonly string[]).includes(dial) && typeof raw === "string" && raw.trim() === "";
  return raw === undefined || blankModelId ? CONTEXT_SETTINGS_EFFECTIVE_DEFAULTS[dial] : raw;
}

/** Equality for a submitted dial against its effective value: null,
 *  undefined and "" are one value, strings compare trimmed, and a number
 *  compares numerically (a numeric string included). */
function sameDialValue(incoming: unknown, effective: unknown): boolean {
  const normalize = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "string" ? value.trim() : value);
  const a = normalize(incoming);
  const b = normalize(effective);
  if (typeof a === "number" || typeof b === "number") {
    const asNumber = (value: unknown) => (typeof value === "number" ? value
      : typeof value === "string" && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
    const x = asNumber(a);
    const y = asNumber(b);
    return x !== null && y !== null && x === y;
  }
  return a === b;
}

function joinLabels(labels: string[]): string {
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

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
    // The server-wide starting values for a session that inherits no campaign settings (Admin: Server settings →
    // New sessions). Absent in unit tests: nothing is written and the built-in defaults apply.
    private readonly newSessionOverrides: () => Record<string, unknown> = () => ({}),
    // The models a session that inherits nothing starts with for this account (defaultModels.ts). Absent in unit tests:
    // the shipped defaults.
    private readonly startingModels: StartingModels | null = null,
  ) {}

  /** The overrides a session that inherits nothing starts with (the server's values and the account's starting models),
   *  or null when there are none. */
  private startingOverridesJson(models?: Record<string, string>): string | null {
    const overrides = { ...this.newSessionOverrides(), ...(models ?? {}) };
    return Object.keys(overrides).length ? JSON.stringify(overrides) : null;
  }

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
    // A session created INTO a campaign inherits that campaign's newest live
    // session's dials exactly like the from-campaign route — it used to land on
    // bridge defaults (retrieval 16k, dramatist off…) while "Start new session"
    // cloned the tuned set. Linking an EXISTING session via PATCH
    // deliberately does not clone (it would silently change a
    // running session's model params).
    const campaignId = sessionType === "wizard" ? null : input.campaignId ?? null;
    const inherited = campaignId ? this.newestLiveCampaignSession(user.id, campaignId) : null;
    // A session with nothing to inherit starts on Claude Opus 4.6 when this account can use it, otherwise on a model it
    // can use, and its background dials follow the same rule (defaultModels.ts).
    const starting = !inherited && this.startingModels ? this.startingModels(user.id, input.modelId) : null;
    const modelId = input.modelId
      ? this.requireModel(user.id, input.modelId)
      : inherited
        ? this.requireInheritedModel(user.id, inherited)
        : this.requireModel(user.id, starting?.modelId);
    const defaults = getSessionRuntimeDefaults(this.customEndpoints, user.id, modelId);
    // Runtime dials carry over only when the model does too — a caller that
    // picked its own model gets that model's defaults, not another model's dials.
    const cloneDials = inherited && inherited.modelId === modelId ? inherited : null;
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
      campaignId,
      folderId: sessionType === "wizard" ? null : input.folderId ?? null,
      name: input.name?.trim() || (sessionType === "wizard" ? WIZARD_SESSION_NAME : "New Session"),
      modelId,
      temperature: cloneDials ? cloneDials.temperature : defaults.temperature,
      thinkingMode: cloneDials ? cloneDials.thinkingMode : defaults.thinkingMode,
      thinkingBudget: cloneDials ? cloneDials.thinkingBudget : defaults.thinkingBudget,
      effort: cloneDials ? cloneDials.effort : defaults.effort,
      cacheTtl: cloneDials ? cloneDials.cacheTtl : defaults.cacheTtl,
      contextOverridesJson: inherited ? inherited.contextOverridesJson : this.startingOverridesJson(starting?.overrides),
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
    // Inheritance: a new session in an existing campaign clones the most-recent
    // session's runtime + ALL Engine-panel dials (context_overrides) so behavior
    // carries forward. There is no campaign-level model dial anymore. A brand-new
    // campaign (no prior session) starts on the account's starting models
    // (defaultModels.ts): Claude Opus 4.6 and the schema's Claude dials when the
    // account can use them, otherwise models it can use.
    // LIVE sessions only: soft-delete stamps updatedAt, so a session
    // just sent to the recycle bin used to be the "newest" — cloning the dials
    // the user had discarded and numbering the Part past what the sidebar shows.
    const priorSessions = this.sessions.listForCampaign(user.id, campaignId);
    const lastSession = priorSessions[0] ?? null;
    const starting = !lastSession && this.startingModels ? this.startingModels(user.id) : null;
    const modelId = lastSession ? this.requireInheritedModel(user.id, lastSession) : this.requireModel(user.id, starting?.modelId ?? getDefaultChatModelId());
    const defaults = getSessionRuntimeDefaults(this.customEndpoints, user.id, modelId);
    const sessionId = createId();
    const partNumber = priorSessions.length + 1;
    const folderId = campaign.folderId && this.folders.findById(user.id, campaign.folderId) ? campaign.folderId : null;
    this.sessions.createSession({
      id: sessionId,
      userId: user.id,
      sessionType: "standard",
      campaignId,
      folderId,
      name: `${campaign.name} Part ${partNumber}`,
      modelId,
      temperature: lastSession ? lastSession.temperature : defaults.temperature,
      thinkingMode: lastSession ? lastSession.thinkingMode : defaults.thinkingMode,
      thinkingBudget: lastSession ? lastSession.thinkingBudget : defaults.thinkingBudget,
      effort: lastSession ? lastSession.effort : defaults.effort,
      cacheTtl: lastSession ? lastSession.cacheTtl : defaults.cacheTtl,
      contextOverridesJson: lastSession ? lastSession.contextOverridesJson : this.startingOverridesJson(starting?.overrides),
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

  /**
   * The adversarial-world dials (CONTEXT_ADMIN_ONLY_DIALS) are ADMIN-ONLY,
   * enforced here at the write chokepoint. The design always said "the owner alone
   * controls how gritty", and a server may have child accounts with their own
   * campaigns, so a non-admin setting `depictionTier: 3` on its own session is a
   * real exposure.
   *
   * The gate used to drop every such field
   * silently and answer 200, so a non-admin's change snapped back with no reason
   * given (the "never silently override a user-facing setting" rule). Now, for a
   * non-admin, a field whose value equals the session's effective value is
   * dropped as before (a client that sends the whole settings snapshot keeps
   * saving the other dials), and a CHANGED value refuses the request with 403
   * naming the dials, before anything in it is written. The web renders these
   * rows read-only for non-admins; Android 1.1.7 strips them from a non-admin's
   * save, so neither client normally reaches the 403.
   */
  private gateAdversarialDials(
    overrides: Record<string, unknown>,
    user: { id: string; role: string },
    storedOverridesJson: string | null,
  ): Record<string, unknown> {
    if (user.role === "admin") return overrides;
    const submitted = CONTEXT_ADMIN_ONLY_DIALS.filter((dial) => Object.prototype.hasOwnProperty.call(overrides, dial));
    if (submitted.length === 0) return overrides;
    const parsed: unknown = safeParseJson<unknown>(storedOverridesJson, {});
    const stored = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const changed = submitted.filter((dial) => !sameDialValue(overrides[dial], effectiveAdminOnlyDial(stored, dial)));
    if (changed.length > 0) {
      workspaceLogger.warn({ userId: user.id, changed }, "non-admin tried to change an admin-only Engine dial; save refused (403)");
      throw new HttpError(403, `Only an admin can change ${joinLabels(changed.map((dial) => ADMIN_ONLY_DIAL_LABELS[dial]))}. Nothing was saved.`);
    }
    const cleaned = { ...overrides };
    for (const dial of submitted) delete cleaned[dial];
    return cleaned;
  }

  updateSession(userId: string, sessionId: string, input: UpdateSessionRequest) {
    const user = this.requireCurrentUser(userId);
    const session = this.sessions.findActiveById(user.id, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (typeof input.folderId === "string") this.requireFolder(user.id, input.folderId);
    if (typeof input.campaignId === "string") this.requireCampaign(user.id, input.campaignId);
    const modelId = Object.prototype.hasOwnProperty.call(input, "modelId") ? this.requireModel(user.id, input.modelId) : null;
    const nextModelId = modelId ?? session.modelId;
    // Runtime defaults apply only on an actual model SWITCH. A PATCH carrying the
    // current modelId (Android's picker re-sends it) is a no-op for the dials —
    // it used to reset thinking/effort/cacheTtl to the catalog defaults, a
    // silent dial reset.
    const switched = modelId !== null && modelId !== session.modelId;
    const runtimeDefaults = getSessionRuntimeDefaults(this.customEndpoints, user.id, nextModelId);
    const nextCacheTtl = normalizeCacheTtl(this.customEndpoints, user.id, nextModelId, Object.prototype.hasOwnProperty.call(input, "cacheTtl")
      ? input.cacheTtl ?? runtimeDefaults.cacheTtl
      : switched
        ? runtimeDefaults.cacheTtl
        : session.cacheTtl as SessionCacheTtl);
    // Gate BEFORE any write: a refused admin-only change (403) saves nothing.
    const contextOverrides = Object.prototype.hasOwnProperty.call(input, "contextOverrides") && input.contextOverrides
      ? this.gateAdversarialDials(input.contextOverrides, user, session.contextOverridesJson)
      : null;
    this.sessions.updateSession(user.id, sessionId, {
      updatedAt: new Date().toISOString(),
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "folderId") ? { folderId: input.folderId ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "campaignId") ? { campaignId: input.campaignId ?? null } : {}),
      ...(switched ? { modelId } : {}),
      temperature: typeof input.temperature === "number" ? input.temperature : session.temperature,
      thinkingMode: switched ? (input.thinkingMode ?? runtimeDefaults.thinkingMode) : (Object.prototype.hasOwnProperty.call(input, "thinkingMode") ? input.thinkingMode ?? session.thinkingMode : session.thinkingMode),
      thinkingBudget: switched
        ? (Object.prototype.hasOwnProperty.call(input, "thinkingBudget") ? input.thinkingBudget : runtimeDefaults.thinkingBudget)
        : (Object.prototype.hasOwnProperty.call(input, "thinkingBudget") ? input.thinkingBudget : session.thinkingBudget),
      effort: switched
        ? (Object.prototype.hasOwnProperty.call(input, "effort") ? input.effort : runtimeDefaults.effort)
        : (Object.prototype.hasOwnProperty.call(input, "effort") ? input.effort : session.effort),
      cacheTtl: nextCacheTtl,
      ...(typeof input.autoScroll === "boolean" ? { autoScroll: input.autoScroll ? 1 : 0 } : {}),
      ...(contextOverrides
        ? { contextOverridesJson: JSON.stringify({
            ...safeParseJson(session.contextOverridesJson, {}),
            ...contextOverrides,
          }) }
        : {}),
    });
    // Embedding model is a per-session dial. When it CHANGES, re-embed the WHOLE
    // campaign (incl. cold/disabled entries) under the new model so semantic
    // retrieval matches — detached from the request so the PATCH returns fast, and
    // NON-silent (start + result/failure recorded as system_events; retrieval
    // degrades to keyword-only meanwhile). Old-model vectors are retained.
    // "Changes" is judged against the EFFECTIVE previous model (an unset dial
    // already retrieves under DEFAULT_EMBEDDING_MODEL), and the re-embed is
    // staleOnly — entries already indexed under the target model from identical
    // content are skipped. Persisting the default for the first time used to
    // fire a full paid re-embed of an 800-entry lorebook.
    const newEmbedModel = input.contextOverrides?.embeddingModel;
    const prevEmbedModel = safeParseJson<{ embeddingModel?: string }>(session.contextOverridesJson, {}).embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    if (newEmbedModel && newEmbedModel !== prevEmbedModel && this.embeddingService && this.lorebook && session.campaignId) {
      const campaignId = session.campaignId;
      const reUserId = user.id;
      const entries = this.lorebook.listAllForCampaign(reUserId, campaignId);
      const targets = entries.map((e) => ({ id: e.id, userId: e.userId, content: e.content }));
      recordSystemEvent({ userId: reUserId, source: "embed_index", severity: "info", campaignId,
        message: `re-embedding ${targets.length} entries under ${newEmbedModel} (embedding model changed from ${prevEmbedModel}) — semantic retrieval is keyword-only until this completes`,
        details: { total: targets.length, model: newEmbedModel, previousModel: prevEmbedModel } });
      this.embeddingService.indexEntries(targets, newEmbedModel, { staleOnly: true })
        .then((indexed) => recordSystemEvent({ userId: reUserId, source: "embed_index", severity: "info", campaignId,
          message: `re-embed complete: ${indexed}/${targets.length} entries indexed under ${newEmbedModel}`,
          details: { indexed, total: targets.length, model: newEmbedModel } }))
        .catch((err) => recordSystemEvent({ userId: reUserId, source: "embed_index", severity: "error", campaignId,
          message: `re-embed under ${newEmbedModel} failed — semantic retrieval may be incomplete`,
          details: { total: targets.length, model: newEmbedModel, error: err instanceof Error ? err.message : String(err) } }));
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
    const messageResults = this.messages.searchFts(user.id, query, SEARCH_FTS_CANDIDATE_LIMIT)
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
      .slice(0, SEARCH_RESULT_LIMIT);
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

  /** The campaign's most recently touched LIVE session — the dial-inheritance
   *  source for a new session in that campaign (from-campaign and create-with-
   *  campaign share it). Recycle-bin sessions never qualify. */
  private newestLiveCampaignSession(userId: string, campaignId: string) {
    return this.sessions.listForCampaign(userId, campaignId)[0] ?? null;
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

  /** The model a new campaign session INHERITS from the newest live session.
   *  When it no longer resolves (a custom endpoint removed in the provider-keys
   *  dialog, a catalog id retired without a remap) the campaign used to have
   *  no way to start a session — a bare "unsupported model" that named neither
   *  the session nor the model. The 400 now names both and the cure;
   *  no silent fallback to another model (house rule). */
  private requireInheritedModel(userId: string, source: { name: string; modelId: string }) {
    if (resolveChatModelConfig(this.customEndpoints, userId, source.modelId)) return source.modelId;
    throw new HttpError(400, `The newest session in this campaign ("${source.name}") uses the model "${source.modelId}", which is no longer available (a removed custom endpoint or a retired model). Open that session and switch its model, or start the new session with an explicit model.`);
  }

  private buildSearchExcerpt(content: string, query: string) {
    const compact = content.replace(/\s+/g, " ").trim();
    if (!compact) return "(empty message)";
    // Locate the match ON the original string with a case-insensitive regex
    // rather than in a lowercased copy: case mapping is not length-preserving
    // (`İ` lowercases to two UTF-16 units), so an index taken in the lowercased
    // text drifted past the true position and could cut the matched word out
    // of the excerpt the UI highlights.
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = escaped ? new RegExp(escaped, "iu").exec(compact) : null;
    // Every cut keeps surrogate pairs whole: at fixed UTF-16 offsets an emoji straddling
    // a cut kept one half, which the sidebar and Android show as a replacement glyph.
    if (!match) return compact.length > 160 ? `${sliceUnits(compact, 157)}...` : compact;
    const index = match.index;
    const start = Math.max(0, index - 48);
    const end = Math.min(compact.length, index + match[0].length + 96);
    const head = sliceUnits(compact, end);
    const window = tailUnits(head, head.length - start);
    return `${start > 0 ? "..." : ""}${window}${end < compact.length ? "..." : ""}`;
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
  if (model?.provider === "codex-bridge") {
    return {
      temperature: 1,
      thinkingMode: "off" as const,
      thinkingBudget: null,
      effort: model.defaultEffort ?? "high",
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
      effort: model.defaultEffort ?? "high",
      cacheTtl: "off" as const,
    };
  }
  if (model?.provider === "zai") {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: null,
      // Most GLMs are toggle-only (effort null). glm-5.2 is the hybrid: it sets a
      // catalog defaultEffort, so switching to it lands on that depth ("max").
      effort: model?.defaultEffort ?? null,
      cacheTtl: "off" as const,
    };
  }
  // DeepSeek V4 thinking is an on/off toggle. Default ON — matches the
  // server-side default (thinking runs when the param is omitted), so existing
  // behavior is preserved exactly; the Off toggle is the new, additive option.
  // Since 2026-10-01 both ids also carry an effort ladder, so switching to one
  // lands on the catalog defaultEffort ("max") like the GLM-5.2 hybrid above.
  if (model?.provider === "deepseek") {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: null,
      effort: model.defaultEffort ?? null,
      cacheTtl: "off" as const,
    };
  }
  // Xiaomi MiMo thinking is a simple on/off toggle (Off ↔ On in the composer).
  // Verified against the live API (2026-06-12): thinking-on works across full
  // multi-turn conversations with no special handling. Default ON since
  // 2026-07-12 (the max-reasoning defaults sweep; was OFF for latency/cost)
  // — users flip it Off per-session from the composer when they want speed.
  if (model?.provider === "xiaomi") {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off" as const,
    };
  }
  // Moonshot Kimi: K2.x thinking is a z.ai-style on/off toggle (default ON —
  // the max-reasoning defaults rule, and the server default anyway); K3 is
  // thinkingAlwaysOn + a reasoning_effort ladder, so it lands on the catalog
  // defaultEffort ("max") instead of the K2.x effort:null. Temperature 1 is
  // legal on both (K3 fixes it there; the dial is hidden for K3 via
  // supportsTemperature:false).
  if (model?.provider === "moonshot") {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: null,
      effort: model.supportsEffort ? (model.defaultEffort ?? "max") : null,
      cacheTtl: "off" as const,
    };
  }
  // GMICloud (Xiaomi MiMo, Western-hosted) — same on/off thinking toggle as the
  // Xiaomi-direct provider; default ON (the max-reasoning defaults rule).
  if (model?.provider === "gmicloud") {
    return {
      temperature: 1,
      thinkingMode: "enabled" as const,
      thinkingBudget: null,
      effort: null,
      cacheTtl: "off" as const,
    };
  }
  // Fireworks (Kimi, Western-hosted) — an effort model (reasoning_effort ladder);
  // honor the catalog defaultEffort ("high") so a model switch lands on max depth
  // instead of the effort:null fallback (the same drift class the xai branch fixes).
  if (model?.provider === "fireworks" && model.supportsEffort) {
    return {
      temperature: 1,
      thinkingMode: "off" as const,
      thinkingBudget: null,
      effort: model.defaultEffort ?? "high",
      cacheTtl: "off" as const,
    };
  }
  // Always-on-thinking models (e.g. gemini-2.5-pro, Fable) must NOT
  // default to thinkingMode:"off" — that's invalid for them. Land on adaptive
  // (or enabled) so the runtime sends a legal thinking config.
  if (model?.thinkingAlwaysOn) {
    return {
      temperature: 1,
      thinkingMode: model.supportsAdaptiveThinking ? "adaptive" as const : "enabled" as const,
      thinkingBudget: model.supportsThinkingBudget ? (model.maxThinkingBudget ?? null) : null,
      effort: model.supportsEffort ? (model.defaultEffort ?? null) : null,
      cacheTtl: model.supportsCacheTtl ? "1h" as const : "off" as const,
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

export { getSessionRuntimeDefaults };

function normalizeCacheTtl(endpoints: CustomEndpointRepository, userId: string, modelId: string, cacheTtl: SessionCacheTtl) {
  const model = resolveChatModelConfig(endpoints, userId, modelId);
  if (!model?.supportsCacheTtl) return "off" as const;
  return cacheTtl;
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
