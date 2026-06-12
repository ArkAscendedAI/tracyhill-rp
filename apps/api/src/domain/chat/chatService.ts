import type { ChatSendRequest, ChatUsage, ChatStreamEvent, SessionDetailResponse, SessionExportResponse, ContextPreviewEntry, ContextAssemblyDebug } from "@tracyhill-rp/contracts";
import type { ChatPromptAttachment, ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { createLogger } from "@tracyhill-rp/logging";

const chatLogger = createLogger("chat-service");

import type { ContextEngine } from "../context/contextEngine";
import type { PipelineQueueService } from "../pipeline/pipelineQueueService";
import type { PipelineRunRepository } from "../pipeline/pipelineRunRepository";

import { HttpError } from "../../lib/httpError";
import { createId } from "../../lib/ids";
import { recordSystemEvent } from "../system/systemEvents";
import { parseSceneBlock, serializeSceneData, serializeSceneForContext, computeNotPresent, updateCharacterRoster, buildSceneTrackingInstruction, buildKnowledgeEnforcementInstruction, checkStreamingBuffer, deserializeSceneData, extractFirmwareCharacterNames, type SceneState } from "./sceneParser";
import { runSceneValidator, type SceneValidatorTurn } from "./sceneValidator";
import { runPresenceNormalizer } from "./presenceNormalizer";
import type { CharacterAttireRepository } from "./characterAttireRepository";
import { CampaignRepository } from "../campaigns/campaignRepository";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { CustomEndpointRepository } from "../providerKeys/customEndpointRepository";
import { resolveChatModelConfig } from "../providerKeys/chatModelConfig";
import { buildWizardSessionPrompt } from "../wizard/wizardSession";
import { WizardTemplateRepository } from "../wizard/wizardTemplateRepository";
import { SessionRepository } from "../workspace/sessionRepository";
import { UserRepository } from "../users/userRepository";
import { MessageAttachmentRepository } from "./messageAttachmentRepository";
import { MessageRepository } from "./messageRepository";
import { PendingAssistantMessageRepository } from "./pendingAssistantMessageRepository";
import { estimateTokens } from "../context/lorebookTokenEstimator";

const MAX_CONCURRENT_STREAMS_PER_USER = 10;

type ActiveChatRequest = {
  userId: string;
  sessionId: string;
  abortController: AbortController;
  markStopped: () => void;
};

export class ChatService {
  private readonly activeRequests = new Map<string, ActiveChatRequest>();

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly campaigns: CampaignRepository,
    private readonly messages: MessageRepository,
    private readonly attachments: MessageAttachmentRepository,
    private readonly pending: PendingAssistantMessageRepository,
    private readonly generatedImages: GeneratedImageRepository,
    private readonly imageStore: ImageStore,
    private readonly wizardTemplates: WizardTemplateRepository,
    private readonly customEndpoints: CustomEndpointRepository,
    private readonly runtimeForUser: (userId: string) => ChatRuntime | null,
    private readonly contextEngine: ContextEngine | null = null,
    private readonly pipelineRuns: PipelineRunRepository | null = null,
    private readonly pipelineKick: (() => void) | null = null,
    private readonly pipelineQueue: PipelineQueueService | null = null,
    private readonly attireRepo: CharacterAttireRepository | null = null,
  ) {}

  getSessionDetail(userId: string, sessionId: string): SessionDetailResponse {
    this.requireUser(userId);
    this.requireSession(userId, sessionId);
    this.mergePendingAssistantMessages(userId, sessionId);
    const session = this.requireSession(userId, sessionId);
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;
    const attachments = this.attachments.listForSession(userId, sessionId);
    const generatedImages = this.generatedImages.listForSession(userId, sessionId);
    return {
      session: {
        id: session.id,
        name: session.name,
        sessionType: session.sessionType as "standard" | "wizard",
        campaignId: session.campaignId,
        folderId: session.folderId,
        modelId: session.modelId,
        temperature: session.temperature,
        thinkingMode: session.thinkingMode as "off" | "enabled" | "adaptive",
        thinkingBudget: session.thinkingBudget,
        effort: session.effort as "minimal" | "low" | "medium" | "high" | "max" | null,
        cacheTtl: session.cacheTtl as "off" | "5m" | "1h",
        autoScroll: Boolean(session.autoScroll),
        pipelineWatermark: session.pipelineWatermark ?? null,
        contextOverrides: session.contextOverridesJson ? safeParseJson(session.contextOverridesJson, null) : null,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastMessageAt: session.lastMessageAt,
        deletedAt: session.deletedAt,
      },
      campaign: campaign ? {
        id: campaign.id,
        name: campaign.name,
        folderId: campaign.folderId,
        pipelineModelId: campaign.pipelineModelId,
        systemPrompt: campaign.systemPrompt,
        version: campaign.version,
        contextDefaults: campaign.contextDefaultsJson ? safeParseJson(campaign.contextDefaultsJson, null) : null,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      } : null,
      messages: this.messages.listForSession(userId, sessionId).map((message) => ({
        id: message.id,
        sessionId: message.sessionId,
        role: message.role as "user" | "assistant" | "cold-start",
        content: message.content,
        thinking: message.thinking,
        modelId: message.modelId,
        usage: message.role === "assistant" ? {
          inputTokens: message.inputTokens,
          outputTokens: message.outputTokens,
          totalTokens: message.totalTokens,
          cacheReadTokens: message.cacheReadTokens,
          cacheWriteTokens: message.cacheWriteTokens,
          reasoningTokens: message.reasoningTokens ?? null,
          speed: (message.fastMode ? "fast" : null) as "fast" | "standard" | null,
        } : null,
        stopReason: message.stopReason ?? null,
        stopDetails: message.stopDetailsJson ? safeParseJson<{ type: string; category: string | null; explanation: string | null } | null>(message.stopDetailsJson, null) : null,
        fastMode: Boolean(message.fastMode),
        servedModel: message.servedModel ?? null,
        sceneData: message.sceneData ?? null,
        sceneValidator: message.sceneValidatorJson ? safeParseJson<{ agreement: "agree" | "disagree"; main: { present: string[]; presentUnaware: string[] }; validator: { present: string[]; presentUnaware: string[] }; rationale: string; modelId: string } | null>(message.sceneValidatorJson, null) : null,
        sceneResolution: (message.sceneResolutionChoice as "main" | "validator" | "user" | null) ?? null,
        overhead: message.overheadJson ? safeParseJson<Array<{ source: string; modelId: string; inputTokens: number; outputTokens: number }>>(message.overheadJson, []) : null,
        sortOrder: message.sortOrder,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        attachments: attachments.filter((attachment) => attachment.messageId === message.id).map((attachment) => ({
          id: attachment.id,
          messageId: attachment.messageId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          contentMode: attachment.contentMode as "text" | "base64",
          content: attachment.content,
          createdAt: attachment.createdAt,
        })),
        generatedImages: generatedImages.filter((image) => image.messageId === message.id).map((image) => ({
          id: image.id,
          messageId: image.messageId,
          prompt: image.prompt,
          mimeType: image.mimeType,
          url: `/api/images/${image.id}`,
          createdAt: image.createdAt,
        })),
      })),
      rollingDiffOverhead: this.pipelineRuns
        ? this.pipelineRuns.listCompletedRollingDiffsForSession(userId, sessionId)
            .map(r => { try { const d = JSON.parse(r.detailsJson ?? "{}"); return d.usage ? { source: "rolling_diff", ...d.usage } : null; } catch { return null; } })
            .filter((u): u is { source: string; modelId: string; inputTokens: number; outputTokens: number } => u != null)
        : [],
    };
  }

  exportSession(userId: string, sessionId: string): SessionExportResponse {
    const detail = this.getSessionDetail(userId, sessionId);
    return {
      sessionId: detail.session.id,
      filename: buildExportFilename(detail.session.name),
      mimeType: "text/markdown",
      content: formatSessionExport(detail),
      exportedAt: new Date().toISOString(),
    };
  }

  updateMessage(userId: string, sessionId: string, messageId: string, content: string) {
    this.requireUser(userId);
    const session = this.requireSession(userId, sessionId);
    const message = this.requireMessage(userId, sessionId, messageId);
    this.requireMutable(session, message);
    const now = new Date().toISOString();
    this.messages.updateMessage(userId, sessionId, messageId, {
      content,
      updatedAt: now,
    });
    this.sessions.updateSession(userId, sessionId, {
      updatedAt: now,
      lastMessageAt: session.lastMessageAt ?? message.createdAt,
    });
    return this.getSessionDetail(userId, sessionId);
  }

  deleteMessage(userId: string, sessionId: string, messageId: string) {
    this.requireUser(userId);
    const session = this.requireSession(userId, sessionId);
    const message = this.requireMessage(userId, sessionId, messageId);
    this.requireMutable(session, message);
    this.deleteMessageArtifacts(userId, sessionId, [messageId]);
    this.messages.deleteMessage(userId, sessionId, messageId);
    this.syncSessionAfterMutation(userId, sessionId);
    return this.getSessionDetail(userId, sessionId);
  }

  truncateAfterMessage(userId: string, sessionId: string, messageId: string) {
    this.requireUser(userId);
    const session = this.requireSession(userId, sessionId);
    const message = this.requireMessage(userId, sessionId, messageId);
    this.requireMutable(session, message);
    const trailing = this.messages.listAfterSortOrder(userId, sessionId, message.sortOrder);
    if (trailing.length) {
      const trailingIds = trailing.map((entry) => entry.id);
      this.deleteMessageArtifacts(userId, sessionId, trailingIds);
      this.messages.deleteAfterSortOrder(userId, sessionId, message.sortOrder);
      // Truncation removes content that previously contributed to pipeline
      // auto-enqueue char counters. Reset so the next assistant turn doesn't
      // trip thresholds on stale chars that no longer exist in the session.
      this.sessions.resetPipelineCounter(sessionId, "rolling_diff");
      this.sessions.resetPipelineCounter(sessionId, "repetition_detection");
      this.sessions.resetPipelineCounter(sessionId, "sysprompt_audit");
    }
    this.syncSessionAfterMutation(userId, sessionId);
    return this.getSessionDetail(userId, sessionId);
  }

  async resolveSceneValidation(
    userId: string,
    sessionId: string,
    messageId: string,
    input: { choice: "main" | "validator" | "user"; userPresent?: string; userPresentUnaware?: string },
  ) {
    this.requireUser(userId);
    const session = this.requireSession(userId, sessionId);
    const message = this.requireMessage(userId, sessionId, messageId);
    if (message.role !== "assistant") throw new HttpError(400, "scene resolution only applies to assistant messages");
    if (!message.sceneData) throw new HttpError(400, "message has no scene data");
    if (!message.sceneValidatorJson) throw new HttpError(400, "message has no validator verdict");
    const validator = safeParseJson<{ agreement: "agree" | "disagree"; main: { present: string[]; presentUnaware: string[] }; validator: { present: string[]; presentUnaware: string[] }; rationale: string; modelId: string } | null>(message.sceneValidatorJson, null);
    if (!validator) throw new HttpError(500, "validator data corrupted");
    const existingScene = deserializeSceneData(message.sceneData);
    if (!existingScene) throw new HttpError(500, "scene data corrupted");
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;
    if (!campaign) throw new HttpError(400, "scene resolution requires a campaign session");

    let finalPresent: string[];
    let finalUnaware: string[];
    let normalizerOverhead: { source: string; modelId: string; inputTokens: number; outputTokens: number } | null = null;
    if (input.choice === "main") {
      finalPresent = validator.main.present;
      finalUnaware = validator.main.presentUnaware;
    } else if (input.choice === "validator") {
      finalPresent = validator.validator.present;
      finalUnaware = validator.validator.presentUnaware;
    } else {
      const roster: string[] = safeParseJson<string[]>(campaign.characterRoster || "[]", []);
      const runtime = this.runtimeForUser(userId);
      const normalizerModel = this.contextEngine
        ? this.contextEngine.resolveSettings({ contextOverridesJson: (session as any).contextOverridesJson }, { contextDefaultsJson: (campaign as any).contextDefaultsJson }).sceneValidatorModel
        : "claude-haiku-4-5-bridge";
      const normalized = await runPresenceNormalizer({
        runtime,
        modelId: normalizerModel,
        roster,
        rawPresent: input.userPresent ?? "",
        rawPresentUnaware: input.userPresentUnaware ?? "",
      });
      finalPresent = normalized.present;
      finalUnaware = normalized.presentUnaware;
      if (normalized.usage) normalizerOverhead = { source: "presence_normalizer", ...normalized.usage };
    }

    const correctedScene: SceneState = {
      location: existingScene.location,
      present: finalPresent,
      presentUnaware: finalUnaware,
      reason: existingScene.reason,
      date: existingScene.date,
      time: existingScene.time,
    };

    // Refresh roster if user/validator added new characters
    const currentRoster: string[] = safeParseJson<string[]>(campaign.characterRoster || "[]", []);
    const updatedRoster = updateCharacterRoster(currentRoster, correctedScene);
    if (updatedRoster) {
      this.campaigns.updateCampaign(userId, campaign.id, { characterRoster: JSON.stringify(updatedRoster), updatedAt: new Date().toISOString() });
    }
    const notPresent = computeNotPresent(updatedRoster ?? currentRoster, correctedScene);
    const sceneDataJson = serializeSceneData(correctedScene, notPresent);

    const now = new Date().toISOString();
    const existingOverhead = message.overheadJson ? safeParseJson<Array<{ source: string; modelId: string; inputTokens: number; outputTokens: number }>>(message.overheadJson, []) : [];
    const updatedOverhead = normalizerOverhead ? [...(existingOverhead ?? []), normalizerOverhead] : existingOverhead;
    this.messages.updateMessage(userId, sessionId, messageId, {
      sceneData: sceneDataJson,
      sceneResolutionChoice: input.choice,
      overheadJson: updatedOverhead && updatedOverhead.length ? JSON.stringify(updatedOverhead) : null,
      updatedAt: now,
    });

    // Only update session-level scene state if this is the latest assistant message
    const allMessages = this.messages.listForSession(userId, sessionId);
    const lastAssistant = [...allMessages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.id === messageId) {
      this.sessions.updateSession(userId, sessionId, {
        sceneLocation: correctedScene.location,
        scenePresent: JSON.stringify(correctedScene.present),
        scenePresentUnaware: JSON.stringify(correctedScene.presentUnaware),
        updatedAt: now,
      });
    }

    return {
      detail: this.getSessionDetail(userId, sessionId),
      correctedScene: { location: correctedScene.location, present: finalPresent, presentUnaware: finalUnaware },
    };
  }

  editSceneMetadata(
    userId: string,
    sessionId: string,
    messageId: string,
    edits: {
      location?: string;
      present?: string[];
      presentUnaware?: string[];
      reason?: string | null;
      date?: string | null;
      time?: string | null;
    },
  ) {
    this.requireUser(userId);
    const session = this.requireSession(userId, sessionId);
    const message = this.requireMessage(userId, sessionId, messageId);
    if (message.role !== "assistant") throw new HttpError(400, "scene metadata only applies to assistant messages");
    if (!message.sceneData) throw new HttpError(400, "message has no scene data");
    const existing = deserializeSceneData(message.sceneData);
    if (!existing) throw new HttpError(500, "scene data corrupted");
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;

    const updatedScene: SceneState = {
      location: edits.location !== undefined ? edits.location.trim() || existing.location : existing.location,
      present: edits.present !== undefined ? edits.present.map((s) => s.trim()).filter(Boolean) : existing.present,
      presentUnaware: edits.presentUnaware !== undefined ? edits.presentUnaware.map((s) => s.trim()).filter(Boolean) : existing.presentUnaware,
      reason: edits.reason !== undefined ? (edits.reason?.trim() || null) : existing.reason,
      date: edits.date !== undefined ? (edits.date?.trim() || null) : existing.date,
      time: edits.time !== undefined ? (edits.time?.trim() || null) : existing.time,
    };

    let notPresent = existing.notPresent;
    if (campaign && (edits.present !== undefined || edits.presentUnaware !== undefined)) {
      const currentRoster: string[] = safeParseJson<string[]>(campaign.characterRoster || "[]", []);
      const updatedRoster = updateCharacterRoster(currentRoster, updatedScene);
      if (updatedRoster) {
        this.campaigns.updateCampaign(userId, campaign.id, { characterRoster: JSON.stringify(updatedRoster), updatedAt: new Date().toISOString() });
      }
      notPresent = computeNotPresent(updatedRoster ?? currentRoster, updatedScene);
    }

    const sceneDataJson = serializeSceneData(updatedScene, notPresent);
    const now = new Date().toISOString();
    this.messages.updateMessage(userId, sessionId, messageId, {
      sceneData: sceneDataJson,
      updatedAt: now,
    });

    const allMessages = this.messages.listForSession(userId, sessionId);
    const lastAssistant = [...allMessages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.id === messageId && (edits.location !== undefined || edits.present !== undefined || edits.presentUnaware !== undefined)) {
      this.sessions.updateSession(userId, sessionId, {
        sceneLocation: updatedScene.location,
        scenePresent: JSON.stringify(updatedScene.present),
        scenePresentUnaware: JSON.stringify(updatedScene.presentUnaware),
        updatedAt: now,
      });
    }

    return this.getSessionDetail(userId, sessionId);
  }

  async streamResponse(
    userId: string,
    sessionId: string,
    input: ChatSendRequest,
    requestId: string,
    emit: (event: ChatStreamEvent) => void,
    options?: { isClientConnected?: () => boolean },
  ) {
    this.requireUser(userId);
    const userStreams = Array.from(this.activeRequests.values()).filter((r) => r.userId === userId).length;
    if (userStreams >= MAX_CONCURRENT_STREAMS_PER_USER) throw new HttpError(429, "too many concurrent requests");
    const runtime = this.runtimeForUser(userId);
    if (!runtime) throw new HttpError(503, "chat provider runtime is not configured");
    const session = this.requireSession(userId, sessionId);
    let stopRequested = false;
    const abortController = new AbortController();
    this.activeRequests.set(`${userId}:${requestId}`, {
      userId,
      sessionId,
      abortController,
      markStopped: () => { stopRequested = true; },
    });
    try {
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;
    const wizardTemplates = session.sessionType === "wizard"
      ? this.wizardTemplates.ensureForUser(userId, new Date().toISOString())
      : null;
    const model = resolveChatModelConfig(this.customEndpoints, userId, input.modelId || session.modelId);
    if (!model) throw new HttpError(400, "unsupported model");

    const prompt = input.prompt.trim() || "See attached files.";
    const now = new Date().toISOString();
    const existing = this.messages.listForSession(userId, sessionId);
    const userMessageId = createId();
    // sortOrder allocated atomically at insert time — a pre-await snapshot let
    // concurrent sends/image-gen/pending-merges collide on the same sortOrder.
    const userSortOrder = this.messages.createMessageAtTail({
      id: userMessageId,
      sessionId,
      userId,
      role: "user",
      content: prompt,
      modelId: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const attachment of input.attachments) {
      this.attachments.createAttachment({
        id: createId(),
        messageId: userMessageId,
        sessionId,
        userId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        contentMode: attachment.contentMode,
        content: attachment.content,
        createdAt: now,
      });
    }
    this.sessions.updateSession(userId, sessionId, {
      messageCount: this.messages.countForSession(userId, sessionId),
      updatedAt: now,
      lastMessageAt: now,
    });

    const conversation = [...existing, {
      id: userMessageId,
      sessionId,
      userId,
      role: "user",
      content: prompt,
      modelId: null,
      sortOrder: userSortOrder,
      createdAt: now,
      updatedAt: now,
    }];
    const attachmentMap = this.getAttachmentMap(userId, sessionId);
    const isCampaignSession = session.sessionType === "standard" && Boolean(session.campaignId);
    // Reset character roster at session start: rebuild from system prompt firmware
    // so dead/removed characters don't persist as NOT PRESENT clutter.
    // During the session, new characters from [SCENE] blocks are appended as normal.
    const currentRoster: string[] = campaign ? safeParseJson<string[]>(campaign.characterRoster || "[]", []) : [];
    if (isCampaignSession && campaign) {
      // Reset fires on the first turn of each session: when the user's message exists
      // but no assistant response has been generated yet. The user message is already
      // in the DB by the time streamResponse runs, so checking for zero non-cold-start
      // messages never triggers. Checking for zero assistant messages is correct.
      const hasAssistantMessages = conversation.some((m) => m.role === "assistant");
      if (!hasAssistantMessages) {
        const firmwareNames = extractFirmwareCharacterNames(campaign.systemPrompt || "");
        if (firmwareNames.length > 0) {
          currentRoster.length = 0;
          currentRoster.push(...firmwareNames);
          this.campaigns.updateCampaign(userId, campaign.id, { characterRoster: JSON.stringify(firmwareNames), updatedAt: new Date().toISOString() });
        }
      }
    }
    // Track last known scene state for carry-forward (ensures consistent context pattern)
    let lastKnownSceneTag: string | null = null;
    // V3 Context Engine: assemble retrieved context for campaign sessions
    let retrievedContext: string | null = null;
    let overheadEntries: Array<{ source: string; modelId: string; inputTokens: number; outputTokens: number }> = [];
    let contextPreview: ContextPreviewEntry[] = [];
    let contextDebug: ContextAssemblyDebug = { keywordHits: 0, semanticHits: 0, researcherHits: 0, coldInflations: 0, droppedForBudget: 0, totalTokens: 0 };
    let contextBudgetTokens = 0;
    let contextNotes: string[] = [];
    if (isCampaignSession && campaign && this.contextEngine?.isEnabled(session, campaign)) {
      // Assembly and activation-commit are guarded SEPARATELY: a commit failure
      // must not discard assembled context, and an assembly failure must be
      // loudly visible (system event + preview note), never silent. The old
      // single catch mislabeled every retrieval outage as
      // "commitActivationState failed (non-fatal)" — 2026-06-10 incident.
      let contextAssembly: Awaited<ReturnType<ContextEngine["assembleForTurn"]>> | null = null;
      try {
        const presentChars: string[] = (() => { try { return JSON.parse((session as any).scenePresent || "[]"); } catch { return []; } })();
        contextAssembly = await this.contextEngine.assembleForTurn({
          userId,
          session: { id: session.id, contextOverridesJson: (session as any).contextOverridesJson },
          campaign: { id: campaign.id, contextDefaultsJson: (campaign as any).contextDefaultsJson },
          history: conversation.filter(m => m.role !== "cold-start").map(m => ({ role: m.role, content: m.content })),
          userTurnText: prompt,
          dryRun: false,
          presentCharacters: presentChars,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        chatLogger.error({ err, sessionId: session.id }, "context assembly failed — turn proceeds WITHOUT retrieved context");
        contextNotes.push(`Context assembly failed (${reason}) — this turn ran without retrieved lorebook context`);
        recordSystemEvent({
          userId,
          source: "context_assembly",
          severity: "error",
          message: `context assembly failed — turn ran without retrieved context: ${reason}`,
          campaignId: campaign.id,
          sessionId: session.id,
        });
      }
      if (contextAssembly) {
        retrievedContext = contextAssembly.retrievedSection;
        contextPreview = contextAssembly.preview;
        contextDebug = contextAssembly.debug;
        contextNotes = [...contextNotes, ...contextAssembly.notes];
        contextBudgetTokens = this.contextEngine.resolveSettings(
          { contextOverridesJson: (session as any).contextOverridesJson },
          { contextDefaultsJson: (campaign as any).contextDefaultsJson },
        ).retrievalBudgetTokens;
        if (contextAssembly.researcherUsage) {
          overheadEntries.push({ source: "researcher", ...contextAssembly.researcherUsage });
        }
        try {
          await this.contextEngine.commitActivationState(session.id, contextAssembly.activationDelta);
        } catch (err) {
          chatLogger.warn({ err, sessionId: session.id }, "commitActivationState failed (non-fatal)");
        }
      }
    }
    // Always emit when there is ANYTHING to show — including failure notes with
    // an empty preview, so a degraded turn is visible in the preview dropdown.
    if (contextPreview.length > 0 || contextNotes.length > 0) {
      emit({ type: "response.context", preview: contextPreview, debug: contextDebug, budgetTokens: contextBudgetTokens, notes: contextNotes });
    }

    // Budget-based context windowing for campaign sessions
    const contextSettings = isCampaignSession && campaign && this.contextEngine
      ? this.contextEngine.resolveSettings(
          { contextOverridesJson: (session as any).contextOverridesJson },
          { contextDefaultsJson: (campaign as any).contextDefaultsJson },
        )
      : null;
    const systemPromptEstimate = isCampaignSession
      ? estimateTokens(buildSessionSystemPrompt({
          systemPrompt: campaign?.systemPrompt ?? null,
          retrievedContext: null,
          isCampaignSession,
          contextDefaultsJson: (campaign as any)?.contextDefaultsJson ?? null,
        }) ?? "")
      : estimateTokens(campaign?.systemPrompt ?? "");
    const windowedConversation = contextSettings
      ? windowConversation(conversation, {
          modelCtx: model.ctx,
          modelMaxOut: model.maxOut,
          contextBudgetTokens: contextSettings.contextBudgetTokens,
          guaranteedMessageCount: contextSettings.guaranteedMessageCount,
          systemPromptTokens: systemPromptEstimate,
          retrievedContextTokens: contextSettings.retrievalBudgetTokens,
        })
      : conversation;

    let prevSceneLocation: string | null = null;
    const runtimeMessages = normalizeRuntimeMessages(windowedConversation
      .filter((message): message is typeof message & { role: "user" | "assistant" } => message.role !== "cold-start")
      .map((message) => {
        let content = message.content;
        if (message.role === "assistant" && isCampaignSession) {
          const sceneDataRaw = "sceneData" in message ? (message as { sceneData?: string | null }).sceneData : null;
          if (sceneDataRaw) {
            const scene = deserializeSceneData(sceneDataRaw);
            if (scene) {
              let prefix = "";
              if (prevSceneLocation && scene.location && scene.location !== prevSceneLocation) {
                prefix = `[SCENE BREAK — Location: ${scene.location}]\n`;
              }
              prevSceneLocation = scene.location ?? prevSceneLocation;
              lastKnownSceneTag = serializeSceneForContext(scene, scene.notPresent);
              content = `${prefix}${lastKnownSceneTag}\n${content}`;
            }
          } else if (lastKnownSceneTag) {
            content = `${lastKnownSceneTag}\n${content}`;
          }
        }
        return {
          role: message.role,
          content,
          attachments: attachmentMap.get(message.id) ?? [],
        };
      }));

    let attireContextBlock: string | null = null;
    if (isCampaignSession && campaign && this.attireRepo && contextSettings?.attireTrackingEnabled) {
      const presentNow: string[] = safeParseJson<string[]>((session as any).scenePresent || "[]", []);
      const unawareNow: string[] = safeParseJson<string[]>((session as any).scenePresentUnaware || "[]", []);
      const allNow = [...new Set([...presentNow, ...unawareNow])].filter((n) => n.trim().length > 0);
      if (allNow.length > 0) {
        const rows = this.attireRepo.findManyByCharacter(campaign.id, allNow);
        const byName = new Map(rows.map((r) => [r.characterName, r]));
        const currentTurnEstimate = Math.max(0, ...conversation.map((m: any) => Number(m.sortOrder ?? 0))) + 1;
        const lines: string[] = [];
        for (const name of allNow) {
          const row = byName.get(name);
          if (!row) {
            lines.push(`${name}: (no attire recorded yet — establish plausible attire as you write)`);
            continue;
          }
          const turnsAgo = Math.max(0, currentTurnEstimate - row.lastUpdatedTurn);
          const stale = turnsAgo >= contextSettings.attireStaleTurnThreshold;
          const freshness = stale
            ? `last updated ${turnsAgo} turns ago [stale — consider plausible changes since this character was last seen]`
            : `last updated ${turnsAgo} turn${turnsAgo === 1 ? "" : "s"} ago`;
          lines.push(`${name} (${freshness}): ${row.attireDescription}`);
        }
        if (lines.length > 0) {
          attireContextBlock = lines.join("\n");
        }
      }
    }

    if (retrievedContext?.trim() || attireContextBlock) {
      const lastMsg = runtimeMessages[runtimeMessages.length - 1];
      if (lastMsg?.role === "user") {
        const parts: string[] = [];
        if (retrievedContext?.trim()) {
          parts.push(`<retrieved_context>\n${retrievedContext.trim()}\n</retrieved_context>`);
        }
        if (attireContextBlock) {
          parts.push(`<character_attire>\n${attireContextBlock}\n</character_attire>`);
        }
        lastMsg.content = `${parts.join("\n\n")}\n\n${lastMsg.content}`;
      }
    }

    let assistantText = "";
    let assistantThinking = "";
    let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
    let outputTruncated = false;
    let stopReason: string | null = null;
    let stopDetails: import("@tracyhill-rp/contracts").StopDetails = null;
    let servedModel: string | null = null;
    // Fast mode gating: caller-toggled, only meaningful for direct Anthropic models with
    // the catalog flag. Bridge variants (provider:claude-code) are silently excluded
    // because the Claude Code SDK doesn't accept the speed parameter.
    const fastModeOn = Boolean(contextSettings?.fastModeEnabled
      && model.supportsFastMode
      && model.provider !== "claude-code");
    let sceneBufferFlushed = !isCampaignSession; // non-campaign sessions flush immediately
    // One-shot scene constraint: only used for this single streaming call.
    // Never persisted to DB, never carried to subsequent turns.
    const oneShotSceneConstraint = input.sceneConstraintOverride && isCampaignSession
      ? buildSceneConstraintBlock(input.sceneConstraintOverride)
      : null;
    try {
      await runtime.streamChat({
        modelId: model.id,
        systemPrompt: session.sessionType === "wizard"
          ? buildWizardSessionPrompt({
              exampleSystemPrompt: wizardTemplates?.exampleSystemPrompt ?? "",
            })
          : appendOneShotConstraint(
              buildSessionSystemPrompt({
                systemPrompt: campaign?.systemPrompt ?? session.systemPrompt ?? null,
                retrievedContext: null,
                isCampaignSession,
                contextDefaultsJson: (campaign as any)?.contextDefaultsJson ?? null,
              }),
              oneShotSceneConstraint,
            ),
        requestId,
        temperature: session.temperature,
        thinkingMode: session.thinkingMode as "off" | "enabled" | "adaptive",
        thinkingBudget: session.thinkingBudget,
        effort: session.effort as "minimal" | "low" | "medium" | "high" | "max" | null,
        cacheTtl: session.cacheTtl as "off" | "5m" | "1h",
        speed: fastModeOn ? "fast" : undefined,
        messages: runtimeMessages,
        signal: abortController.signal,
      }, {
        onStart: () => {
          if (options?.isClientConnected?.() === false) return;
          emit({ type: "response.started", modelId: model.id });
        },
        onDelta: (delta) => {
          assistantText += delta;
          if (options?.isClientConnected?.() === false) return;
          // Buffer scene block: withhold deltas until we know if a [SCENE] block is present
          if (!sceneBufferFlushed) {
            const check = checkStreamingBuffer(assistantText);
            if (check.status === "noBlock") {
              sceneBufferFlushed = true;
              emit({ type: "response.delta", delta: assistantText });
            } else if (check.status === "complete") {
              sceneBufferFlushed = true;
              const afterBlock = assistantText.slice(check.endIndex);
              if (afterBlock) emit({ type: "response.delta", delta: afterBlock });
            }
            // "buffering" — withhold, wait for more deltas
            return;
          }
          emit({ type: "response.delta", delta });
        },
        onThinkingDelta: (delta) => {
          assistantThinking += delta;
          if (options?.isClientConnected?.() === false) return;
          emit({ type: "response.thinking.delta", delta });
        },
        onComplete: (result) => {
          usage = result.usage;
          outputTruncated = result.outputTruncated;
          stopReason = result.stopReason;
          stopDetails = result.stopDetails;
          servedModel = result.servedModel ?? null;
          // Flush any remaining buffered content
          if (!sceneBufferFlushed && options?.isClientConnected?.() !== false) {
            sceneBufferFlushed = true;
            const check = checkStreamingBuffer(assistantText);
            const cleanStart = check.status === "complete" ? check.endIndex : 0;
            const remaining = assistantText.slice(cleanStart);
            if (remaining) emit({ type: "response.delta", delta: remaining });
          }
        },
      });
    } catch (error) {
      if (stopRequested && isAbortError(error)) {
        const stoppedStripped = extractInlineThinking(assistantText);
        if (stoppedStripped.thinking) assistantThinking = assistantThinking ? assistantThinking + "\n" + stoppedStripped.thinking : stoppedStripped.thinking;
        const stoppedParsed = isCampaignSession ? parseSceneBlock(stoppedStripped.content) : { cleanContent: stoppedStripped.content, sceneState: null };
        const stoppedMessage = this.buildAssistantMessage({
          assistantText: stoppedParsed.cleanContent,
          assistantThinking,
          modelId: model.id,
          sessionId,
          sortOrder: userSortOrder + 1,
          usage,
          stopped: true,
          fastMode: usage.speed === "fast",
          servedModel,
        });
        this.persistAssistantMessage(userId, sessionId, stoppedMessage, usage, existing.length + 2);
        if (options?.isClientConnected?.() !== false) emit({ type: "response.completed", message: stoppedMessage, usage });
        return;
      }
      if (options?.isClientConnected?.() !== false) {
        emit({ type: "response.error", error: error instanceof Error ? error.message : "provider request failed" });
      }
      return;
    }

    // Strip inline thinking tags (DeepSeek V3 Pro, z.ai, etc. embed <thinking>/<think> in content)
    const { thinking: inlineThinking, content: strippedText } = extractInlineThinking(assistantText);
    if (inlineThinking) assistantThinking = assistantThinking ? assistantThinking + "\n" + inlineThinking : inlineThinking;

    // Parse scene block from assistant response (campaign sessions only)
    const { cleanContent, sceneState } = isCampaignSession ? parseSceneBlock(strippedText) : { cleanContent: strippedText, sceneState: null };
    let sceneDataJson: string | null = null;
    if (sceneState && campaign) {
      // Re-fetch roster from DB (not the stale campaign object) to pick up any
      // session-start reset that happened earlier in this request
      const freshCampaign = this.campaigns.findById(userId, campaign.id);
      const currentRoster: string[] = safeParseJson<string[]>(freshCampaign?.characterRoster || campaign.characterRoster || "[]", []);
      const updatedRoster = updateCharacterRoster(currentRoster, sceneState);
      if (updatedRoster) {
        this.campaigns.updateCampaign(userId, campaign.id, { characterRoster: JSON.stringify(updatedRoster), updatedAt: new Date().toISOString() });
      }
      const notPresent = computeNotPresent(updatedRoster ?? currentRoster, sceneState);
      sceneDataJson = serializeSceneData(sceneState, notPresent);
      this.sessions.updateSession(userId, sessionId, {
        sceneLocation: sceneState.location,
        scenePresent: JSON.stringify(sceneState.present),
        scenePresentUnaware: JSON.stringify(sceneState.presentUnaware),
        updatedAt: new Date().toISOString(),
      });
    }

    const assistantMessage = this.buildAssistantMessage({
      assistantText: cleanContent,
      assistantThinking,
      modelId: model.id,
      sessionId,
      sortOrder: userSortOrder + 1,
      usage,
      outputTruncated,
      maxOutputTokens: model.maxOut,
      sceneData: sceneDataJson,
      overhead: overheadEntries.length ? overheadEntries : null,
      stopReason,
      stopDetails,
      fastMode: usage.speed === "fast",
      servedModel,
    });
    const runPostPersistFollowups = async () => {
      if (isCampaignSession && campaign && this.pipelineQueue && this.contextEngine) {
        try {
          const settings = this.contextEngine.resolveSettings(
            { contextOverridesJson: (session as any).contextOverridesJson },
            { contextDefaultsJson: (campaign as any).contextDefaultsJson },
          );
          this.pipelineQueue.evaluateAndEnqueue(userId, campaign.id, sessionId, cleanContent.length, {
            pipelineAutoEnabled: settings.pipelineAutoEnabled,
            rollingDiffCharThreshold: settings.rollingDiffCharThreshold,
            repetitionCharThreshold: settings.repetitionCharThreshold,
            syspromptAuditCharThreshold: settings.syspromptAuditCharThreshold,
            rollingModel: settings.rollingModel,
            embeddingModel: settings.embeddingModel,
          });
        } catch (err) { chatLogger.warn({ err, campaignId: campaign.id, sessionId }, "pipelineQueue.evaluateAndEnqueue failed (non-fatal)"); }
      }

      if (isCampaignSession && campaign && sceneState && this.contextEngine) {
        try {
          const settings = this.contextEngine.resolveSettings(
            { contextOverridesJson: (session as any).contextOverridesJson },
            { contextDefaultsJson: (campaign as any).contextDefaultsJson },
          );
          if (settings.sceneValidatorEnabled) {
            await this.runSceneValidatorTurn({
              userId,
              sessionId,
              campaignId: campaign.id,
              messageId: assistantMessage.id,
              runtime,
              modelId: settings.sceneValidatorModel,
              sceneState,
              attireAdvisory: sceneState.attire ?? null,
              trackAttire: settings.attireTrackingEnabled,
              emit,
              isClientConnected: options?.isClientConnected,
            });
          }
        } catch (err) {
          // Validator failure is non-fatal (main response already persisted) but
          // must never be silent: this catch also covers the post-LLM persistence
          // steps (verdict write, attire upsert, touchLastSeen).
          chatLogger.warn({ err, sessionId }, "scene validator turn failed (non-fatal)");
          recordSystemEvent({
            userId,
            source: "scene_validator",
            message: `scene validator turn failed: ${err instanceof Error ? err.message : String(err)}`,
            sessionId,
          });
        }
      }
    };

    if (options?.isClientConnected?.() === false) {
      this.pending.createPendingMessage({
        id: assistantMessage.id,
        sessionId,
        userId,
        sourceUserMessageId: userMessageId,
        modelId: model.id,
        content: assistantMessage.content,
        thinking: assistantMessage.thinking,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        stopReason: assistantMessage.stopReason ?? null,
        stopDetailsJson: assistantMessage.stopDetails ? JSON.stringify(assistantMessage.stopDetails) : null,
        fastMode: assistantMessage.fastMode ?? false,
        servedModel: assistantMessage.servedModel ?? null,
        sceneData: assistantMessage.sceneData ?? null,
        overheadJson: assistantMessage.overhead ? JSON.stringify(assistantMessage.overhead) : null,
        createdAt: assistantMessage.createdAt,
        updatedAt: assistantMessage.updatedAt,
      });
      // The disconnect must not skip the passive follow-ups: pipeline char
      // accounting and the scene validator don't need a live client. (Both
      // used to be skipped by this early return — auto-pipeline silently
      // under-triggered and disconnected turns got no presence/attire audit.)
      await runPostPersistFollowups();
      return;
    }

    this.persistAssistantMessage(userId, sessionId, assistantMessage, usage, existing.length + 2);
    emit({ type: "response.completed", message: assistantMessage, usage });
    await runPostPersistFollowups();
    } finally {
      this.activeRequests.delete(`${userId}:${requestId}`);
    }
  }

  stopResponse(userId: string, sessionId: string, requestId: string) {
    this.requireUser(userId);
    this.requireSession(userId, sessionId);
    const active = this.activeRequests.get(`${userId}:${requestId}`);
    if (active && active.userId === userId && active.sessionId === sessionId) {
      active.markStopped();
      active.abortController.abort();
      return true;
    }
    for (const [, req] of this.activeRequests) {
      if (req.userId === userId && req.sessionId === sessionId) {
        req.markStopped();
        req.abortController.abort();
        return true;
      }
    }
    return false;
  }

  private requireUser(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    return user;
  }

  private requireSession(userId: string, sessionId: string) {
    const session = this.sessions.findActiveById(userId, sessionId);
    if (!session) throw new HttpError(404, "session not found");
    return session;
  }

  private requireMessage(userId: string, sessionId: string, messageId: string) {
    const message = this.messages.findById(userId, sessionId, messageId);
    if (!message) throw new HttpError(404, "message not found");
    return message;
  }

  private requireMutable(session: { pipelineWatermark?: number | null }, message: { sortOrder: number }) {
    if (session.pipelineWatermark != null && message.sortOrder <= session.pipelineWatermark) {
      throw new HttpError(403, "message is locked by the pipeline watermark and cannot be modified");
    }
  }

  private deleteMessageArtifacts(userId: string, sessionId: string, messageIds: string[]) {
    if (!messageIds.length) return;
    const images = this.generatedImages.listForMessageIds(userId, sessionId, messageIds);
    for (const image of images) this.imageStore.delete(image.id, image.mimeType);
    this.generatedImages.deleteForMessageIds(userId, sessionId, messageIds);
    this.attachments.deleteForMessageIds(userId, sessionId, messageIds);
  }

  private mergePendingAssistantMessages(userId: string, sessionId: string) {
    const pending = this.pending.listForSession(userId, sessionId);
    if (!pending.length) return;
    this.pending.transact(() => {
      const existingIds = new Set(this.messages.listForSession(userId, sessionId).map((m) => m.id));
      for (const message of pending) {
        // Source user message gone (truncated/deleted since the disconnect)?
        // Discard instead of resurrecting the reply after newer turns.
        if (!existingIds.has(message.sourceUserMessageId)) {
          this.pending.deletePendingMessage(userId, sessionId, message.id);
          continue;
        }
        if (!existingIds.has(message.id)) {
          this.messages.createMessageAtTail({
            id: message.id,
            sessionId,
            userId,
            role: "assistant",
            content: message.content,
            thinking: message.thinking,
            modelId: message.modelId,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens,
            totalTokens: message.totalTokens,
            cacheReadTokens: message.cacheReadTokens,
            cacheWriteTokens: message.cacheWriteTokens,
            reasoningTokens: message.reasoningTokens ?? null,
            // 0058 parity: recovered turns keep their refusal categorization,
            // fast-mode flag, served-model stamp, scene block, and overhead.
            stopReason: (message as any).stopReason ?? null,
            stopDetailsJson: (message as any).stopDetailsJson ?? null,
            fastMode: Boolean((message as any).fastMode),
            servedModel: (message as any).servedModel ?? null,
            sceneData: (message as any).sceneData ?? null,
            overheadJson: (message as any).overheadJson ?? null,
          });
        }
        this.pending.deletePendingMessage(userId, sessionId, message.id);
        // Keep updatedAt monotonic — the disconnect-time stamp used to move
        // the session's recency BACKWARDS in the sidebar.
        this.sessions.updateSession(userId, sessionId, {
          messageCount: this.messages.countForSession(userId, sessionId),
          updatedAt: new Date().toISOString(),
          lastMessageAt: message.createdAt,
        });
      }
    });
  }

  private persistAssistantMessage(
    userId: string,
    sessionId: string,
    assistantMessage: ReturnType<ChatService["buildAssistantMessage"]>,
    usage: ChatUsage,
    messageCount: number,
  ) {
    this.messages.createMessageAtTail({
      id: assistantMessage.id,
      sessionId: assistantMessage.sessionId,
      userId,
      role: assistantMessage.role,
      content: assistantMessage.content,
      thinking: assistantMessage.thinking,
      modelId: assistantMessage.modelId,
      sceneData: assistantMessage.sceneData,
      sceneValidatorJson: assistantMessage.sceneValidator ? JSON.stringify(assistantMessage.sceneValidator) : null,
      sceneResolutionChoice: assistantMessage.sceneResolution ?? null,
      overheadJson: assistantMessage.overhead ? JSON.stringify(assistantMessage.overhead) : null,
      stopReason: assistantMessage.stopReason ?? null,
      stopDetailsJson: assistantMessage.stopDetails ? JSON.stringify(assistantMessage.stopDetails) : null,
      fastMode: assistantMessage.fastMode ?? false,
      servedModel: assistantMessage.servedModel ?? null,
      createdAt: assistantMessage.createdAt,
      updatedAt: assistantMessage.updatedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
    });
    this.sessions.updateSession(userId, sessionId, {
      messageCount: this.messages.countForSession(userId, sessionId),
      updatedAt: assistantMessage.updatedAt,
      lastMessageAt: assistantMessage.createdAt,
    });
  }

  private async runSceneValidatorTurn(input: {
    userId: string;
    sessionId: string;
    campaignId: string;
    messageId: string;
    runtime: ChatRuntime;
    modelId: string;
    sceneState: SceneState;
    attireAdvisory: Record<string, string> | null;
    trackAttire: boolean;
    emit: (event: ChatStreamEvent) => void;
    isClientConnected?: () => boolean;
  }) {
    const { userId, sessionId, campaignId, messageId, runtime, modelId, sceneState, attireAdvisory, trackAttire, emit, isClientConnected } = input;
    const allMessages = this.messages.listForSession(userId, sessionId);
    // The audited assistant turn MUST be included (as the latest entry): the
    // validator prompt says "read the latest assistant turn carefully" — the old
    // filter excluded it, so presence/attire reconciliation ran blind against
    // the very narrative it was auditing.
    const recent = allMessages.slice(-10);
    const history: SceneValidatorTurn[] = recent
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const scene = m.role === "assistant" && m.sceneData ? deserializeSceneData(m.sceneData) : null;
        return {
          role: m.role as "user" | "assistant",
          content: m.content || "",
          scene: scene ? { location: scene.location, present: scene.present, presentUnaware: scene.presentUnaware } : null,
        };
      });
    if (!history.length) return;

    const trackedNames = trackAttire
      ? [...new Set([...sceneState.present, ...sceneState.presentUnaware])].filter((n) => n.trim().length > 0)
      : [];
    let attireBefore: Record<string, string> | undefined;
    if (trackAttire && this.attireRepo && trackedNames.length > 0) {
      const rows = this.attireRepo.findManyByCharacter(campaignId, trackedNames);
      attireBefore = {};
      for (const r of rows) attireBefore[r.characterName] = r.attireDescription;
    }

    const result = await runSceneValidator({
      runtime,
      modelId,
      history,
      declared: sceneState,
      attireBefore,
      attireAdvisory: trackAttire && attireAdvisory ? attireAdvisory : undefined,
      trackAttire,
      requestId: `scene-validator-${messageId}`,
      userId,
      sessionId,
    });
    if (!result.verdict) {
      // Unparseable validator output is exactly as invisible as a dead validator
      // — record it (the usage was still spent).
      if (result.rawResponse.trim()) {
        recordSystemEvent({
          userId,
          source: "scene_validator",
          message: `scene validator returned unparseable output (${modelId}) — turn not audited`,
          sessionId,
          details: { messageId, rawPreview: result.rawResponse.slice(0, 300) },
        });
      }
      return;
    }
    const verdict = result.verdict;
    const validatorPayload = {
      agreement: verdict.agreement,
      main: { present: sceneState.present, presentUnaware: sceneState.presentUnaware },
      validator: { present: verdict.present, presentUnaware: verdict.presentUnaware },
      rationale: verdict.rationale,
      modelId,
      attire: verdict.attire,
    };
    this.messages.updateMessage(userId, sessionId, messageId, {
      sceneValidatorJson: JSON.stringify(validatorPayload),
      updatedAt: new Date().toISOString(),
    });
    const message = this.messages.findById(userId, sessionId, messageId);
    if (message && result.usage) {
      const existingOverhead = message.overheadJson ? safeParseJson<Array<{ source: string; modelId: string; inputTokens: number; outputTokens: number }>>(message.overheadJson, []) : [];
      const updated = [...(existingOverhead ?? []), { source: "scene_validator", modelId, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }];
      this.messages.updateMessage(userId, sessionId, messageId, {
        overheadJson: JSON.stringify(updated),
        updatedAt: new Date().toISOString(),
      });
    }

    if (trackAttire && this.attireRepo && verdict.attire) {
      const turn = (message?.sortOrder ?? 0);
      // Expand the canonicalization set to include validator-corrected names so
      // characters the main LLM omitted (but the validator caught) still get
      // attire upserts. Declared-only was the original gap.
      const effectiveNames = [...new Set([
        ...trackedNames,
        ...verdict.present,
        ...verdict.presentUnaware,
      ])].filter((n) => n.trim().length > 0);
      const validNames = new Set(effectiveNames);
      const validNamesLower = new Map(effectiveNames.map((n) => [n.toLowerCase(), n]));
      this.attireRepo.touchLastSeen(campaignId, effectiveNames, turn);
      for (const [rawName, entry] of Object.entries(verdict.attire)) {
        const canonical = validNames.has(rawName) ? rawName : validNamesLower.get(rawName.toLowerCase());
        if (!canonical) continue;
        this.attireRepo.upsert({
          campaignId,
          characterName: canonical,
          attireDescription: entry.description,
          turn,
          messageId,
          source: "verifier",
          previousAttire: attireBefore?.[canonical] ?? null,
          reason: entry.reason ?? null,
          recordHistory: entry.changed,
        });
      }
    }

    if (isClientConnected?.() !== false) {
      emit({
        type: "response.scene_validation",
        messageId,
        agreement: verdict.agreement,
        main: validatorPayload.main,
        validator: validatorPayload.validator,
        rationale: verdict.rationale,
        modelId,
      });
    }
  }

  private syncSessionAfterMutation(userId: string, sessionId: string) {
    const remaining = this.messages.listForSession(userId, sessionId);
    const lastMessage = remaining[remaining.length - 1] ?? null;
    const updatedAt = new Date().toISOString();

    // Roll session-level scene state back to the last SURVIVING scene-bearing
    // message. Truncate/delete used to leave the deleted future's
    // location/present lists in place, so the next turn's retrieval, attire
    // block, and validator baseline ran against a scene that no longer exists.
    let sceneLocation: string | null = null;
    let scenePresent = "[]";
    let scenePresentUnaware = "[]";
    for (let i = remaining.length - 1; i >= 0; i--) {
      const sceneDataRaw = remaining[i]!.sceneData;
      if (!sceneDataRaw) continue;
      const scene = deserializeSceneData(sceneDataRaw);
      if (scene) {
        sceneLocation = scene.location ?? null;
        scenePresent = JSON.stringify(scene.present ?? []);
        scenePresentUnaware = JSON.stringify(scene.presentUnaware ?? []);
      }
      break;
    }

    this.sessions.updateSession(userId, sessionId, {
      messageCount: remaining.length,
      updatedAt,
      lastMessageAt: lastMessage?.createdAt ?? null,
      sceneLocation,
      scenePresent,
      scenePresentUnaware,
    });

    // Pending recovery rows whose source user message no longer exists would
    // resurrect deleted content on the next GET — drop them.
    const survivingIds = new Set(remaining.map((m) => m.id));
    for (const row of this.pending.listForSession(userId, sessionId)) {
      if (!survivingIds.has(row.sourceUserMessageId)) {
        this.pending.deletePendingMessage(userId, sessionId, row.id);
      }
    }
  }

  private getAttachmentMap(userId: string, sessionId: string) {
    const map = new Map<string, ChatPromptAttachment[]>();
    for (const attachment of this.attachments.listForSession(userId, sessionId)) {
      const next = map.get(attachment.messageId) ?? [];
      next.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        contentMode: attachment.contentMode as "text" | "base64",
        content: attachment.content,
      });
      map.set(attachment.messageId, next);
    }
    return map;
  }

  private buildAssistantMessage(input: {
    assistantText: string;
    assistantThinking: string;
    modelId: string;
    sessionId: string;
    sortOrder: number;
    usage: ChatUsage;
    stopped?: boolean;
    outputTruncated?: boolean;
    maxOutputTokens?: number | null;
    sceneData?: string | null;
    sceneValidator?: { agreement: "agree" | "disagree"; main: { present: string[]; presentUnaware: string[] }; validator: { present: string[]; presentUnaware: string[] }; rationale: string; modelId: string } | null;
    sceneResolution?: "main" | "validator" | "user" | null;
    overhead?: Array<{ source: string; modelId: string; inputTokens: number; outputTokens: number }> | null;
    stopReason?: string | null;
    stopDetails?: import("@tracyhill-rp/contracts").StopDetails;
    fastMode?: boolean;
    servedModel?: string | null;
  }) {
    const assistantNow = new Date().toISOString();
    const stoppedContent = input.assistantText
      ? `${input.assistantText}\n\n*[Stopped]*`
      : "*[Stopped before response began]*";
    const content = input.stopped
      ? stoppedContent
      : appendTruncationWarning(
          input.assistantText || (input.assistantThinking ? "*[Response contained only thinking]*" : ""),
          input.outputTruncated ?? false,
          input.maxOutputTokens,
        );
    return {
      id: createId(),
      sessionId: input.sessionId,
      role: "assistant" as const,
      content,
      thinking: input.assistantThinking || null,
      modelId: input.modelId,
      usage: input.usage,
      stopReason: input.stopReason ?? null,
      stopDetails: input.stopDetails ?? null,
      fastMode: input.fastMode ?? false,
      servedModel: input.servedModel ?? null,
      sceneData: input.sceneData ?? null,
      sceneValidator: input.sceneValidator ?? null,
      sceneResolution: input.sceneResolution ?? null,
      overhead: input.overhead ?? null,
      sortOrder: input.sortOrder,
      createdAt: assistantNow,
      updatedAt: assistantNow,
      attachments: [],
      generatedImages: [],
    };
  }
}

const CACHE_BOUNDARY_SENTINEL = "<<<TR_CACHE_BOUNDARY>>>\n";
const SECTION_DELIMITER = "\n\n<<<TR_SEC>>>\n\n";

function buildSessionSystemPrompt(input: {
  systemPrompt: string | null;
  retrievedContext: string | null;
  isCampaignSession: boolean;
  contextDefaultsJson: string | null;
}) {
  const sections: string[] = [];
  if (input.isCampaignSession) sections.push(buildSceneTrackingInstruction());
  if (input.isCampaignSession) sections.push(buildKnowledgeEnforcementInstruction());
  const promptAndRules = input.systemPrompt?.trim() ?? "";
  const rulesSection = input.isCampaignSession ? renderAntiRepetitionRules(input.contextDefaultsJson) : null;
  const cachedBlock = [promptAndRules, rulesSection].filter(Boolean).join("\n\n---\n\n");
  if (cachedBlock) {
    sections.push(CACHE_BOUNDARY_SENTINEL + cachedBlock);
  } else if (sections.length > 0) {
    sections[sections.length - 1] = CACHE_BOUNDARY_SENTINEL + sections[sections.length - 1];
  }
  if (input.retrievedContext?.trim()) sections.push(input.retrievedContext.trim());
  if (input.isCampaignSession) sections.push("REMINDER: Begin your response with a [SCENE] block before any narrative text. This is mandatory infrastructure — the system strips it before display.");
  return sections.length ? sections.join(SECTION_DELIMITER) : null;
}

interface AntiRepetitionRule {
  pattern: string;
  replacement_guidance: string;
  rule_type?: "ban" | "limit" | "vary";
  max_per_scene?: number;
  frequency?: number;
  status?: "active" | "new" | "dormant";
}

function renderAntiRepetitionRules(contextDefaultsJson: string | null): string | null {
  if (!contextDefaultsJson) return null;
  try {
    const defaults = JSON.parse(contextDefaultsJson);
    const rules: AntiRepetitionRule[] = defaults.antiRepetitionRules;
    if (!Array.isArray(rules) || rules.length === 0) return null;

    const bans: AntiRepetitionRule[] = [];
    const limits: AntiRepetitionRule[] = [];
    const varies: AntiRepetitionRule[] = [];
    const dormant: AntiRepetitionRule[] = [];
    for (const r of rules) {
      if (r.status === "dormant") dormant.push(r);
      else if (r.rule_type === "ban") bans.push(r);
      else if (r.rule_type === "limit") limits.push(r);
      else varies.push(r);
    }

    const sections: string[] = [];
    if (bans.length) {
      const lines = bans.map((r, i) => `${i + 1}. ${r.pattern}\n   → ${r.replacement_guidance}`);
      sections.push(`### NEVER USE — model tics flagged as overused\n\n${lines.join("\n\n")}`);
    }
    if (limits.length) {
      const lines = limits.map((r, i) => {
        const cap = r.max_per_scene ?? 1;
        return `${i + 1}. ${r.pattern} — max ${cap} per scene\n   → ${r.replacement_guidance}`;
      });
      sections.push(`### LIMIT PER SCENE — legitimate devices that turn into tics when overused\n\n${lines.join("\n\n")}`);
    }
    if (varies.length) {
      const lines = varies.map((r, i) => `${i + 1}. ${r.pattern}\n   → ${r.replacement_guidance}`);
      sections.push(`### VARY — avoid defaulting to these; use the alternatives\n\n${lines.join("\n\n")}`);
    }
    if (dormant.length) {
      const lines = dormant.map(r => `- ${r.pattern}`);
      sections.push(`### DORMANT GUARDS — previously flagged, not currently a problem (preventive only)\n\n${lines.join("\n")}`);
    }

    if (!sections.length) return null;
    return `## Anti-Repetition Rules\n\nThese narrative patterns have been flagged as overused in this campaign. Follow the type-specific guidance below — bans are absolute, limits cap per-scene usage, varies push toward alternatives, dormant guards are preventive only.\n\n${sections.join("\n\n")}`;
  } catch { return null; }
}

const RUNTIME_META_PREFIXES = [
  "**Credit Balance Error:**",
  "**API Error:**",
  "**Network Error:**",
  "**Authentication Error:**",
  "*[Stopped before response began]*",
  "*[Response contained only thinking]",
];

function normalizeRuntimeMessages(messages: Array<{ role: "user" | "assistant"; content: string; attachments: ChatPromptAttachment[] }>) {
  const normalized: Array<{ role: "user" | "assistant"; content: string; attachments: ChatPromptAttachment[] }> = [];
  for (const message of messages) {
    if (shouldSkipRuntimeMessage(message.content)) continue;
    const sanitizedContent = sanitizeRuntimeMessageContent(message.content);
    if (!sanitizedContent.trim() && !message.attachments.length) continue;
    const previous = normalized[normalized.length - 1];
    if (previous?.role === message.role && !previous.attachments.length && !message.attachments.length) {
      previous.content = joinMessageContent(previous.content, sanitizedContent);
      continue;
    }
    normalized.push({
      role: message.role,
      content: sanitizedContent,
      attachments: [...message.attachments],
    });
  }
  return normalized;
}

function joinMessageContent(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  return `${left}\n\n${right}`;
}

function shouldSkipRuntimeMessage(content: string) {
  return RUNTIME_META_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function sanitizeRuntimeMessageContent(content: string) {
  return content
    .replace(/\n\n\*\[Stopped\]\*$/, "")
    .replace(/\n\n---\n\n\*\[Stream interrupted:.*?\]\*$/, "");
}

function appendTruncationWarning(content: string, outputTruncated: boolean, maxOutputTokens: number | null | undefined) {
  if (!outputTruncated) return content;
  const limit = (maxOutputTokens ?? 32768).toLocaleString();
  return `${content}\n\n---\n\n**⚠ Output truncated** — hit the model's max output token limit (${limit}). The response was cut off.`;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function buildSceneConstraintBlock(constraint: { location: string; present: string[]; presentUnaware: string[] }): string {
  const presentList = constraint.present.join(", ") || "—";
  const unawareList = constraint.presentUnaware.join(", ") || "—";
  return [
    "---",
    "",
    "## SCENE CORRECTION — Mandatory for this turn only",
    "",
    "The user has corrected the scene state for the turn you are about to rewrite. Use exactly these values in your [SCENE] block — do not deviate, do not add or remove characters, do not reinterpret:",
    "",
    `location: ${constraint.location}`,
    `present: ${presentList}`,
    `present_unaware: ${unawareList}`,
    "",
    "Write your narrative response consistent with this authoritative scene state. Any character not in PRESENT or PRESENT_UNAWARE is NOT in this scene and must not appear, speak, or act in your prose.",
  ].join("\n");
}

function appendOneShotConstraint(systemPrompt: string | null, constraint: string | null): string | null {
  if (!constraint) return systemPrompt;
  if (!systemPrompt) return constraint;
  return `${systemPrompt}\n\n${constraint}`;
}

function formatSessionExport(detail: SessionDetailResponse) {
  const lines = [`# ${detail.session.name}`, ""];
  for (const message of detail.messages) {
    if (message.role === "cold-start") {
      lines.push("## Cold Start");
      lines.push("");
      lines.push(message.content);
      lines.push("");
      continue;
    }
    if (message.sceneData) {
      const scene = deserializeSceneData(message.sceneData);
      if (scene) {
        lines.push(`---`);
        lines.push(`*Scene: ${scene.location} · Present: ${scene.present.join(", ")}*`);
        lines.push(`---`);
        lines.push("");
      }
    }
    lines.push(`## ${message.role === "user" ? "You" : "Assistant"}`);
    lines.push("");
    lines.push(cleanExportContent(message.content) || "_(empty)_");
    if (message.attachments.length) {
      lines.push("");
      lines.push("### Attachments");
      lines.push("");
      for (const attachment of message.attachments) lines.push(...formatExportAttachment(attachment));
    }
    if (message.generatedImages.length) {
      lines.push("");
      lines.push("### Generated Images");
      lines.push("");
      for (const image of message.generatedImages) lines.push(`- ${image.prompt} (${image.mimeType})`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function formatExportAttachment(attachment: SessionDetailResponse["messages"][number]["attachments"][number]) {
  if (attachment.contentMode === "text") {
    const fence = buildMarkdownFence(attachment.content);
    return [
      `#### ${attachment.filename} (${attachment.mimeType})`,
      "",
      fence,
      attachment.content,
      fence,
      "",
    ];
  }
  if (attachment.mimeType === "application/pdf") return [`- PDF attachment: ${attachment.filename} (${attachment.mimeType})`, ""];
  if (attachment.mimeType.startsWith("image/")) return [`- Image attachment: ${attachment.filename} (${attachment.mimeType})`, ""];
  return [`- Binary attachment: ${attachment.filename} (${attachment.mimeType})`, ""];
}

function cleanExportContent(content: string) {
  return content
    .replace(/\n?\*\[(Stopped|Stream interrupted)\]\*$/g, "")
    .trim();
}

function buildExportFilename(name: string) {
  const slug = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "session"}.md`;
}

function buildMarkdownFence(content: string) {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function windowConversation<T extends { role: string; content: string }>(
  conversation: T[],
  budget: {
    modelCtx: number;
    modelMaxOut: number;
    contextBudgetTokens: number;
    guaranteedMessageCount: number;
    systemPromptTokens: number;
    retrievedContextTokens: number;
  },
): T[] {
  const nonColdStart = conversation.filter(m => m.role !== "cold-start");
  if (nonColdStart.length <= budget.guaranteedMessageCount) return conversation;

  const modelInputBudget = budget.modelCtx - budget.modelMaxOut;
  const effectiveBudget = Math.floor(
    (modelInputBudget > 0 ? Math.min(budget.contextBudgetTokens, modelInputBudget) : budget.contextBudgetTokens) * 0.95
  );
  const fixedCost = budget.systemPromptTokens + budget.retrievedContextTokens;
  let remaining = effectiveBudget - fixedCost;
  if (remaining <= 0) return conversation;

  const guaranteed = nonColdStart.slice(-budget.guaranteedMessageCount);
  const older = nonColdStart.slice(0, -budget.guaranteedMessageCount);
  // Estimate guaranteed cost from the stable older-message average so the backfill
  // budget doesn't oscillate per turn and flip rawStart across stride boundaries.
  const avgTokens = older.length > 0
    ? Math.ceil(older.reduce((s, m) => s + m.content.length, 0) / (3.5 * older.length))
    : 700;
  remaining -= budget.guaranteedMessageCount * avgTokens;

  let backfillCount = 0;
  let backfillTokens = 0;
  for (let i = older.length - 1; i >= 0; i--) {
    const cost = estimateTokens(older[i]!.content);
    if (cost > remaining - backfillTokens) break;
    backfillTokens += cost;
    backfillCount++;
  }

  const coldStart = conversation.filter(m => m.role === "cold-start");
  if (backfillCount === 0) return [...coldStart, ...guaranteed];
  const CACHE_STRIDE = 20;
  const rawStart = older.length - backfillCount;
  const pinnedStart = Math.max(0, Math.floor(rawStart / CACHE_STRIDE) * CACHE_STRIDE);
  return [...coldStart, ...older.slice(pinnedStart), ...guaranteed];
}

function extractInlineThinking(text: string): { thinking: string | null; content: string } {
  const blocks: string[] = [];
  const cleaned = text.replace(/<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>\s*/g, (_, block) => { blocks.push(block); return ""; });
  return { thinking: blocks.length ? blocks.join("\n") : null, content: cleaned };
}
