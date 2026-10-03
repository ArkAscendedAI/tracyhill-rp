import type { ChatMessage, ChatSendRequest, ChatUsage, ChatStreamEvent, SceneOutlineResponse, SessionDetailResponse, SessionExportResponse, SessionExportJsonResponse, ContextPreviewEntry, ContextAssemblyDebug, DriveSheet } from "@tracyhill-rp/contracts";
import { buildMessageContextSnapshot, STALE_WANT_PRESSURE, TRUNCATE_UNCONFIRMED_LIMIT } from "@tracyhill-rp/contracts";
import { characterNameKey } from "./characterNames";
import type { ChatPromptAttachment, ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { estimateCacheSavingsUsd, estimateHelperOverheadUsd, estimateUsageCostUsd, getChatModel, getConfiguredDefaultModelId, openaiFastModeFor, type HelperOverheadUsage } from "@tracyhill-rp/model-catalog";
import { createLogger } from "@tracyhill-rp/logging";

const chatLogger = createLogger("chat-service");

import type { ContextEngine } from "../context/contextEngine";
import type { PipelineQueueService } from "../pipeline/pipelineQueueService";
import type { PipelineRunRepository } from "../pipeline/pipelineRunRepository";

import { HttpError } from "../../lib/httpError";
import { createId } from "../../lib/ids";
import { recordSystemEvent } from "../system/systemEvents";
import { parseSceneBlock, serializeSceneData, serializeSceneForContext, computeNotPresent, updateCharacterRoster, buildSceneTrackingInstruction, buildKnowledgeEnforcementInstruction, checkStreamingBuffer, deserializeSceneData, extractFirmwareCharacterNames, stripSpotlightMarkers, type SceneState, normalizePresentNames } from "./sceneParser";
import { runSceneValidator, type SceneValidatorTurn } from "./sceneValidator";
import { runPresenceNormalizer } from "./presenceNormalizer";
import type { AttireRollbackChange, CharacterAttireRepository } from "./characterAttireRepository";
import type { CharacterDrivesRepository } from "./characterDrivesRepository";
import type { ScheduledBeatRepository } from "../world/scheduledBeatRepository";
import { buildGritBlocks } from "../world/gritContract";
import { buildCharacterIntegrityBlock, buildStyleGateBlock } from "../world/characterIntegrity";
import { buildContentHonestyBlock, buildContentHonestyEscalationBlock, buildIcebreakerTurnHonest, contentHonestyApplies } from "../world/contentHonesty";
import { buildSceneTempoBlock, computeSceneTempo } from "../world/sceneTempo";
import { runAntagonistIntent, type AntagonistBrief } from "../world/antagonistIntent";
import type { AdversarialWorldRepository } from "../world/adversarialWorldRepository";
import {
  extractWorldState, refuteDeath, threatFingerprint, consequenceFingerprint,
} from "../world/worldStateExtraction";
import {
  classifyContestedAction, baseTargetFor, buildContestedBlock, standingModifiers,
  type ClassifiedContest,
} from "../world/contestedAction";
import { renderDueBeatsDirective } from "../world/dueBeatRenderer";
import { latestSceneDate as latestInWorldSceneDate } from "../world/worldClock";
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
import type { MessageContextSnapshotRepository } from "./messageContextSnapshotRepository";
import { estimateTokens } from "../context/lorebookTokenEstimator";
import { retrievalRuns } from "../context/retrievalMode";
import { stripOocBlocks } from "../context/stripOoc";
import { antagonistRunsForPlan, contestRunsForPlan, orderTurnBlocks, turnBlockAllowed } from "./turnBlocks";

const MAX_CONCURRENT_STREAMS_PER_USER = 10;
/** The 409 a guarded truncate answers when the named row is not the first one after the cut; the clients show it. */
export const TRUNCATE_CHAT_CHANGED = "The chat has changed since it was loaded. Reload it and try again.";
export function truncateConfirmRequired(count: number): string {
  return `This removes the ${count} messages after it. Confirm the count to continue.`;
}

// How a generated assistant turn is persisted. See persistTurnForPlan.
type AssistantTurnPlan = { sourceUserMessageId?: string } & (
  | { kind: "append"; assistantSortOrder: number }
  | { kind: "variant"; assistantSortOrder: number; variantGroupId: string }
  | { kind: "continue"; assistantSortOrder: number; targetMessageId: string; expectedContent: string; priorContent: string; priorThinking: string | null; priorSceneData: string | null });

/** NPC-side contest windows. Read as "<user>'s odds of resisting", because the
 *  verdict is inverted at the call site so one stance-weighting rule governs the
 *  whole system — see the resolveContest comment in runAssistantTurn. */
const NPC_CONTEST_TARGET: Record<ClassifiedContest["difficulty"], number> = {
  easy: 30,
  moderate: 45,
  hard: 60,
  desperate: 75,
};

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
    private readonly pipelineQueue: PipelineQueueService | null = null,
    private readonly attireRepo: CharacterAttireRepository | null = null,
    private readonly drivesRepo: CharacterDrivesRepository | null = null,
    private readonly beatsRepo: ScheduledBeatRepository | null = null,
    // Adversarial World (phases 3-6). Every method is stance-gated internally, so
    // holding the reference costs nothing at the shipped default.
    private readonly adversarialWorld: AdversarialWorldRepository | null = null,
    // Per-reply context snapshots: the turn's response.context,
    // stored against the reply it produced so the Preview survives a reload.
    private readonly contextSnapshots: MessageContextSnapshotRepository | null = null,
  ) {}

  getSessionDetail(userId: string, sessionId: string, opts: { before?: number; after?: number; limit?: number; includeAll?: boolean } = {}): SessionDetailResponse {
    this.requireUser(userId);
    this.requireSession(userId, sessionId);
    const isCursorPage = opts.before != null || opts.after != null;
    // Pending-assistant merge appends at the TAIL — it's only visible on (and only
    // relevant to) the newest-window load; a cursor-page fetch skips the write.
    if (!isCursorPage) this.mergePendingAssistantMessages(userId, sessionId);
    const session = this.requireSession(userId, sessionId);
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;
    // Transcript windowing: default to the most-recent window instead
    // of materializing the full 4,700+-message transcript on every load. Fetch
    // limit+1 so hasOlder is exact without a second COUNT query. includeAll is
    // the internal full-transcript path (export). after-mode (scene jump) windows
    // FORWARD from a cursor and fills pagination in both directions.
    const limit = Math.max(1, Math.min(opts.limit ?? ChatService.DETAIL_WINDOW_DEFAULT, ChatService.DETAIL_WINDOW_MAX));
    let windowRows;
    let hasOlder = false;
    let hasNewer = false;
    if (opts.includeAll) {
      windowRows = this.messages.listForSession(userId, sessionId);
    } else if (opts.after != null) {
      const rows = this.messages.listWindow(userId, sessionId, { after: opts.after, limit: limit + 1 });
      hasNewer = rows.length > limit;
      windowRows = hasNewer ? rows.slice(0, limit) : rows;
      // Anything strictly older than the window's first row? One indexed row probe.
      hasOlder = windowRows.length > 0
        && this.messages.listWindow(userId, sessionId, { before: windowRows[0]!.sortOrder, limit: 1 }).length > 0;
    } else {
      const rows = this.messages.listWindow(userId, sessionId, { before: opts.before, limit: limit + 1 });
      hasOlder = rows.length > limit;
      windowRows = hasOlder ? rows.slice(1) : rows;
      // before-mode: rows newer than this window exist by construction (the cursor
      // message itself) — fill the newer direction so the shape stays consistent.
      hasNewer = opts.before != null && windowRows.length > 0;
    }
    const windowIds = windowRows.map((m) => m.id);
    // Attachments/images/variant counts scoped to the window — attachment content
    // (base64 images!) is the heaviest per-row payload after message content.
    const attachments = this.attachments.listForMessageIds(userId, sessionId, windowIds);
    const generatedImages = this.generatedImages.listForMessageIds(userId, sessionId, windowIds);
    // Variant counts: ordered sibling-id lists per group, so each active message
    // can carry its ‹ n/m › chrome + the sibling ids for switching with no fetch.
    const windowGroupIds = [...new Set(windowRows.map((m) => m.variantGroupId).filter((g): g is string => g != null))];
    const variantCounts = this.messages.listVariantCounts(userId, sessionId, windowGroupIds);
    // Which replies hold a context snapshot (one query per page; a
    // session keeps at most its newest 50).
    const snapshotIds = this.contextSnapshots ? new Set(this.contextSnapshots.listMessageIdsForSession(userId, sessionId)) : null;
    const rollingDiffOverhead = this.pipelineRuns
      ? this.pipelineRuns.listCompletedRollingDiffsForSession(userId, sessionId)
          .map(r => { try { const d = JSON.parse(r.detailsJson ?? "{}"); return d.usage ? { source: "rolling_diff", ...d.usage } : null; } catch { return null; } })
          .filter((u): u is { source: string; modelId: string; inputTokens: number; outputTokens: number } => u != null)
      : [];
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
        systemPrompt: campaign.systemPrompt,
        version: campaign.version,
        // Real values, not placeholders: the PC keys and embedding model
        // resolve from THIS session's dials (the campaign list resolves the same
        // two from the campaign's newest session); the anti-repetition state
        // comes from its own column, as the campaign list serves it.
        ...resolveSessionCampaignFields(session.contextOverridesJson, (campaign as { antiRepetitionJson?: string | null }).antiRepetitionJson ?? null),
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      } : null,
      messages: windowRows.map((message) => ({
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
        rollOverride: Boolean(message.rollOverride),
        servedModel: message.servedModel ?? null,
        directiveKind: (message.directiveKind as "gm_spotlight" | null) ?? null,
        sceneData: message.sceneData ?? null,
        sceneValidator: message.sceneValidatorJson ? safeParseJson<{ agreement: "agree" | "disagree"; main: { present: string[]; presentUnaware: string[] }; validator: { present: string[]; presentUnaware: string[] }; rationale: string; modelId: string } | null>(message.sceneValidatorJson, null) : null,
        sceneResolution: (message.sceneResolutionChoice as "main" | "validator" | "user" | null) ?? null,
        overhead: message.overheadJson ? safeParseJson<Array<{ source: string; modelId: string; inputTokens: number; outputTokens: number }>>(message.overheadJson, []) : null,
        variantGroupId: message.variantGroupId ?? null,
        ...(() => {
          const siblings = message.variantGroupId ? (variantCounts.get(message.variantGroupId) ?? []) : [];
          return {
            variantIndex: siblings.length ? Math.max(0, siblings.indexOf(message.id)) : 0,
            variantCount: siblings.length || 1,
            variantSiblingIds: siblings,
          };
        })(),
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
        ...(snapshotIds ? { hasContextSnapshot: snapshotIds.has(message.id) } : {}),
      })),
      rollingDiffOverhead,
      pagination: {
        hasOlder,
        oldestSortOrder: windowRows[0]?.sortOrder ?? null,
        hasNewer,
        // Cursor for the next forward window; on the default load this is simply
        // the tail's sortOrder (hasNewer stays false — it IS the newest window).
        newestSortOrder: windowRows.length ? windowRows[windowRows.length - 1]!.sortOrder : null,
      },
      // Whole-session aggregates ride only on the default (no-cursor) response —
      // cursor-page fetches are merged client-side and must not recompute them.
      sessionStats: isCursorPage ? null : this.computeSessionStats(userId, sessionId, session.cacheTtl as "off" | "5m" | "1h", rollingDiffOverhead),
    };
  }

  // Default/maximum transcript window sizes for getSessionDetail.
  private static readonly DETAIL_WINDOW_DEFAULT = 200;
  private static readonly DETAIL_WINDOW_MAX = 1000;

  /**
   * One pass over the ACTIVE messages' scalar columns (content sizes aggregate in
   * SQL; usage/pricing columns cross into JS without bodies) producing everything
   * the client status strip folded over the full transcript before windowing:
   * token totals, catalog-priced message/overhead cost, cache savings, and the
   * char/line/context-char sums behind the Context/Lines stats and the ~chars/4
   * context-token estimate.
   */
  private computeSessionStats(userId: string, sessionId: string, cacheTtl: "off" | "5m" | "1h", rollingDiffOverhead: ReadonlyArray<HelperOverheadUsage>): NonNullable<SessionDetailResponse["sessionStats"]> {
    const usageRows = this.messages.listActiveAssistantUsage(userId, sessionId);
    const contentAgg = this.messages.aggregateActiveContent(userId, sessionId);
    const attachmentChars = this.messages.aggregateAttachmentContextChars(userId, sessionId);
    const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    let messageCost: number | null = null;
    let cacheSavings: number | null = null;
    // Helper overhead is priced by the catalog's one rule (standard rates, long-context tier by
    // each call's prompt size), the rule the web applies; this loop used to multiply base rates
    // and skip the tier.
    const overheadEntries: HelperOverheadUsage[] = [];
    for (const row of usageRows) {
      totals.inputTokens += row.inputTokens ?? 0;
      totals.outputTokens += row.outputTokens ?? 0;
      totals.totalTokens += row.totalTokens ?? 0;
      totals.cacheReadTokens += row.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += row.cacheWriteTokens ?? 0;
      totals.reasoningTokens += row.reasoningTokens ?? 0;
      // Single-source cost math: the write charge is
      // keyed on captured cacheWriteTokens, not the session TTL (OpenAI sessions
      // force cacheTtl "off" while the runtime still bills 1.25× writes).
      const rowModel = row.modelId ? getChatModel(row.modelId) : null;
      const cost = estimateUsageCostUsd(rowModel, row, { cacheTtl, fastMode: row.fastMode });
      if (cost != null) messageCost = (messageCost ?? 0) + cost;
      const savings = estimateCacheSavingsUsd(rowModel, row, row.fastMode);
      if (savings != null) cacheSavings = (cacheSavings ?? 0) + savings;
      if (row.overheadJson) overheadEntries.push(...safeParseJson<HelperOverheadUsage[]>(row.overheadJson, []));
    }
    return {
      activeMessageCount: contentAgg.activeMessageCount,
      ...totals,
      messageCost,
      overheadCost: estimateHelperOverheadUsd(overheadEntries),
      rollingDiffOverheadCost: estimateHelperOverheadUsd(rollingDiffOverhead),
      cacheSavings,
      contentChars: contentAgg.contentChars,
      contentLines: contentAgg.contentLines,
      // Per-message +24 framing overhead matches the client's estimator.
      estimatedContextChars: contentAgg.contentChars + contentAgg.activeMessageCount * 24 + attachmentChars,
    };
  }

  /**
   * Scene/date outline: every ACTIVE scene-bearing message's
   * location + in-world date/time, in transcript order. Reads only the
   * scene_data column — no message bodies — so it stays cheap on 4,700+
   * message sessions. Malformed scene_data rows are skipped.
   */
  getSceneOutline(userId: string, sessionId: string): SceneOutlineResponse {
    this.requireUser(userId);
    this.requireSession(userId, sessionId);
    // Collapse consecutive same-scene messages into scene BREAKS. The scene
    // persists across many turns (Mara: 2,945 scene messages but only ~470 real
    // scene changes), and the model decorates the same place with micro-movement
    // qualifiers ("Harbor Cemetery" → "Harbor Cemetery, path toward gate"),
    // so runs are keyed on the normalized BASE location (text before the first
    // comma/dash qualifier). Each outline entry is the FIRST message of its run,
    // labeled with that message's full location, plus how many scene-bearing
    // turns the run spans.
    const entries: SceneOutlineResponse["entries"] = [];
    let prevBase: string | null = null;
    let prevDate: string | null = null;
    for (const row of this.messages.listActiveSceneData(userId, sessionId)) {
      const scene = row.sceneData ? deserializeSceneData(row.sceneData) : null;
      if (!scene) continue;
      const base = sceneBaseLocation(scene.location);
      // An in-world date change starts a new run even at the same place — "the
      // next morning, same room" is a scene break to a reader.
      const isBreak = prevBase === null || base !== prevBase || (scene.date ?? null) !== prevDate;
      if (isBreak) {
        entries.push({
          messageId: row.id,
          sortOrder: row.sortOrder,
          location: scene.location,
          date: scene.date,
          time: scene.time,
          turns: 1,
        });
      } else {
        entries[entries.length - 1]!.turns += 1;
      }
      prevBase = base;
      prevDate = scene.date ?? null;
    }
    return { entries };
  }

  exportSession(userId: string, sessionId: string): SessionExportResponse {
    // Export must cover the FULL transcript, not the default window.
    const detail = this.getSessionDetail(userId, sessionId, { includeAll: true });
    return {
      sessionId: detail.session.id,
      filename: buildExportFilename(detail.session.name),
      mimeType: "text/markdown",
      content: formatSessionExport(detail),
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * JSON export: full transcript straight off the repository —
   * bypasses the detail window AND the variant_active filter, so inactive
   * variant siblings are preserved in the archive.
   */
  exportSessionJson(userId: string, sessionId: string): SessionExportJsonResponse {
    this.requireUser(userId);
    this.mergePendingAssistantMessages(userId, sessionId);
    const session = this.requireSession(userId, sessionId);
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;
    const rows = this.messages.listAllIncludingInactiveVariants(userId, sessionId);
    return {
      format: "json",
      sessionId: session.id,
      filename: buildExportFilename(session.name).replace(/\.md$/, ".json"),
      mimeType: "application/json",
      exportedAt: new Date().toISOString(),
      session: {
        id: session.id,
        name: session.name,
        sessionType: session.sessionType as "standard" | "wizard",
        campaignId: session.campaignId,
        modelId: session.modelId,
        messageCount: session.messageCount,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastMessageAt: session.lastMessageAt,
      },
      campaign: campaign ? { id: campaign.id, name: campaign.name, version: campaign.version } : null,
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant" | "cold-start",
        content: m.content,
        thinking: m.thinking,
        modelId: m.modelId,
        servedModel: m.servedModel ?? null,
        sceneData: m.sceneData ?? null,
        stopReason: m.stopReason ?? null,
        fastMode: Boolean(m.fastMode),
        rollOverride: Boolean(m.rollOverride),
        variantGroupId: m.variantGroupId ?? null,
        variantActive: Boolean(m.variantActive),
        usage: m.role === "assistant" ? {
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          totalTokens: m.totalTokens,
          cacheReadTokens: m.cacheReadTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          reasoningTokens: m.reasoningTokens ?? null,
        } : null,
        sortOrder: m.sortOrder,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    };
  }

  updateMessage(userId: string, sessionId: string, messageId: string, content: string) {
    this.requireUser(userId);
    const session = this.requireSession(userId, sessionId);
    const message = this.requireMessage(userId, sessionId, messageId);
    const now = new Date().toISOString();
    const contentChanged = message.content !== content;
    this.messages.updateMessage(userId, sessionId, messageId, {
      content,
      updatedAt: now,
    });
    this.sessions.updateSession(userId, sessionId, {
      updatedAt: now,
      lastMessageAt: session.lastMessageAt ?? message.createdAt,
    });
    // An edited reply is the canon; the attire its OLD text produced is not
    // (2026-09-26: an alarm the user edited out stayed in one
    // character's row and the composer staged the boarding it described), and
    // since 2026-09-29 neither is the presence its old text declared: the
    // re-audit of an edited newest reply applies the presence of the new text.
    if (contentChanged && message.role === "assistant" && session.campaignId) {
      this.withdrawAttireForEditedReply(userId, sessionId, session.campaignId, message);
    }
    return this.getSessionDetail(userId, sessionId);
  }

  deleteMessage(userId: string, sessionId: string, messageId: string) {
    this.requireUser(userId);
    this.requireSession(userId, sessionId);
    const message = this.requireMessage(userId, sessionId, messageId);
    // The row delete, the artifact-row deletes, the survivor promotion and the
    // session sync commit TOGETHER: a delete that committed while the
    // promote did not (process crash, SQLITE_BUSY under the worker's write
    // lock) left the slot with zero active siblings, the state the
    // promote exists to prevent. Image FILES go after the commit, so a rolled-
    // back delete keeps them.
    const images = this.generatedImages.listForMessageIds(userId, sessionId, [messageId]);
    this.messages.transact(() => {
      this.generatedImages.deleteForMessageIds(userId, sessionId, [messageId]);
      this.attachments.deleteForMessageIds(userId, sessionId, [messageId]);
      this.messages.deleteMessage(userId, sessionId, messageId);
      // Deleting the ACTIVE sibling of a variant group used to leave the group
      // with zero active members: the hidden siblings
      // were invisible to the transcript/LLM/UI and only a later truncate could
      // remove them. Promote the newest surviving sibling so the 0067 invariant
      // (exactly one visible message per slot) holds; a group whose last member
      // was deleted simply ceases to exist.
      if (message.variantGroupId && message.variantActive) {
        const survivors = this.messages.listVariantGroup(userId, sessionId, message.variantGroupId);
        const newest = survivors[survivors.length - 1];
        if (newest) this.messages.setActiveVariant(userId, sessionId, message.variantGroupId, newest.id);
      }
      this.syncSessionAfterMutation(userId, sessionId, `${message.role} message ${messageId.slice(0, 8)} (turn ${message.sortOrder}) deleted`, [messageId]);
    });
    for (const image of images) this.imageStore.delete(image.id, image.mimeType);
    return this.getSessionDetail(userId, sessionId);
  }

  truncateAfterMessage(
    userId: string,
    sessionId: string,
    messageId: string,
    guard: { expectNextMessageId?: string; expectLastMessageId?: string; confirmDeleteCount?: number } = {},
  ) {
    this.requireUser(userId);
    this.requireSession(userId, sessionId);
    const message = this.requireMessage(userId, sessionId, messageId);
    const trailing = this.messages.listAfterSortOrder(userId, sessionId, message.sortOrder);
    // The trailing read includes inactive variant siblings, which share their slot; the client sees the active rows.
    const visible = trailing.filter((entry) => entry.variantActive);
    // A client replacing the row after the cut names it, and the cut goes ahead only when
    // that row is the first visible one there. A transcript that held an unloaded gap cut after the row before the gap,
    // and every row the client never saw went with it.
    if (guard.expectNextMessageId !== undefined && visible[0]?.id !== guard.expectNextMessageId) {
      throw new HttpError(409, TRUNCATE_CHAT_CHANGED);
    }
    // That check covers one row. A tab open since two days earlier resent the first message it had
    // loaded, a path that names no next row, and the cut took the 199 newer messages it had never seen. The client now
    // names the last message it has, and a cut of more than two messages needs that and the person's confirmed count;
    // a caller naming neither (an older page, an older app) is refused, so it reloads instead of cutting.
    const lastVisibleId = visible.length > 0 ? visible[visible.length - 1]!.id : message.id;
    if (guard.expectLastMessageId !== undefined && guard.expectLastMessageId !== lastVisibleId) {
      throw new HttpError(409, TRUNCATE_CHAT_CHANGED);
    }
    if (visible.length > TRUNCATE_UNCONFIRMED_LIMIT) {
      if (guard.expectLastMessageId === undefined) throw new HttpError(409, TRUNCATE_CHAT_CHANGED);
      if (guard.confirmDeleteCount !== visible.length) throw new HttpError(428, truncateConfirmRequired(visible.length));
    }
    const trailingIds = trailing.map((entry) => entry.id);
    if (trailing.length) {
      // The counters give back what the removed messages added, read before they are deleted, in the
      // same transaction so a failed delete never takes them back twice.
      this.messages.transact(() => {
        this.releasePipelineCounters(userId, sessionId, trailingIds);
        this.deleteMessageArtifacts(userId, sessionId, trailingIds);
        this.messages.deleteAfterSortOrder(userId, sessionId, message.sortOrder);
      });
    }
    this.syncSessionAfterMutation(userId, sessionId, `transcript truncated after turn ${message.sortOrder}`, trailingIds);
    return this.getSessionDetail(userId, sessionId);
  }

  /** A truncation takes back what the removed messages added to the pipeline
   *  counters: the characters of the settled replies among them
   *  (2026-09-29). A reply is counted once the next user turn settles it, so
   *  removing the newest, unsettled reply (Edit & regenerate, the usual case)
   *  changes nothing. The counters used to go to zero here (a guard against
   *  content that no longer exists tripping the threshold),
   *  which threw away every settled reply since the last diff on each truncation:
   *  one campaign went 58 settled replies without a rolling diff. Call before the
   *  messages are deleted, in their transaction. The length is today's content:
   *  a settled reply edited since, or one settled while automatic runs were off
   *  (its receipt is written, the counters are not), is taken back at that
   *  length; the counters floor at zero. */
  private releasePipelineCounters(userId: string, sessionId: string, removedIds: string[]) {
    const chars = this.messages.countedPipelineChars(userId, sessionId, removedIds);
    if (chars <= 0) return;
    for (const kind of ["rolling_diff", "repetition_detection", "sysprompt_audit"] as const) {
      this.sessions.resetPipelineCounter(sessionId, kind, chars);
    }
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
      const normalizerSettings = this.contextEngine
        ? this.contextEngine.resolveSettings({ contextOverridesJson: (session as any).contextOverridesJson })
        : null;
      const normalizerModel = normalizerSettings?.sceneValidatorModel ?? getConfiguredDefaultModelId() ?? "claude-haiku-4-5-bridge";
      const normalized = await runPresenceNormalizer({
        runtime,
        modelId: normalizerModel,
        openaiFastMode: normalizerSettings?.openaiFastModeEnabled ?? false,
        roster,
        rawPresent: input.userPresent ?? "",
        rawPresentUnaware: input.userPresentUnaware ?? "",
        userId,
        sessionId,
      });
      finalPresent = normalized.present;
      finalUnaware = normalized.presentUnaware;
      if (normalized.usage) normalizerOverhead = { source: "presence_normalizer", ...normalized.usage };
    }

    // Deduplicated: the validator's lists and the user's are model-
    // or hand-authored and may repeat a name.
    finalPresent = [...new Set(finalPresent)];
    finalUnaware = [...new Set(finalUnaware)].filter((n) => !finalPresent.includes(n));
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
      present: edits.present !== undefined ? [...new Set(edits.present.map((s) => s.trim()).filter(Boolean))] : existing.present,
      presentUnaware: edits.presentUnaware !== undefined ? [...new Set(edits.presentUnaware.map((s) => s.trim()).filter(Boolean))] : existing.presentUnaware,
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
    const wizardTemplates = session.sessionType === "wizard"
      ? this.wizardTemplates.ensureForUser(userId, new Date().toISOString())
      : null;
    const model = resolveChatModelConfig(this.customEndpoints, userId, input.modelId || session.modelId);
    if (!model) throw new HttpError(400, "unsupported model");

    // Living World spotlight: the persisted user turn is a GM-directive marker
    // (never a user bubble in the UI); prompt may be empty.
    const spotlight = input.spotlight ?? null;
    const prompt = spotlight
      ? `[GM SPOTLIGHT — ${spotlight.characterName}${spotlight.steer ? `: ${spotlight.steer}` : ""}]`
      : (input.prompt.trim() || "See attached files.");
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
      directiveKind: spotlight ? "gm_spotlight" : null,
      // Persisted on the user message (not read from the request downstream) so
      // regenerates of this turn resolve their contests under the same override.
      rollOverride: input.rollOverride === true,
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
      // The spotlight instruction is built from this kind, never from the text.
      directiveKind: spotlight ? "gm_spotlight" : null,
      modelId: null,
      sortOrder: userSortOrder,
      createdAt: now,
      updatedAt: now,
    }];
    await this.runAssistantTurn({
      userId, sessionId, session: this.sessionForTranscript(session, conversation), campaign: session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null,
      runtime, model, wizardTemplates, requestId, emit, options,
      conversation, sourceUserMessageId: userMessageId, settlePrevious: true,
      sceneConstraintOverride: input.sceneConstraintOverride ?? null,
      plan: { kind: "append", assistantSortOrder: userSortOrder + 1 },
    });
  }

  // Shared assistant-generation body reused by streamResponse / regenerateAssistant
  // / continueAssistant / editAndRegenerate. The user turn (if any) is ALREADY
  // persisted by the caller; this method assembles context, streams, and persists
  // the assistant turn according to `plan`:
  //   append   — tail-insert a fresh assistant message (normal send / resend).
  //   variant  — insert a sibling sharing the target slot's sort_order + flip active.
  //   continue — UPDATE an existing message in place (max_tokens continuation).
  private async runAssistantTurn(params: {
    userId: string;
    sessionId: string;
    session: ReturnType<ChatService["requireSession"]>;
    campaign: ReturnType<CampaignRepository["findById"]> | null;
    runtime: ChatRuntime;
    model: NonNullable<ReturnType<typeof resolveChatModelConfig>>;
    wizardTemplates: ReturnType<WizardTemplateRepository["ensureForUser"]> | null;
    requestId: string;
    emit: (event: ChatStreamEvent) => void;
    options?: { isClientConnected?: () => boolean };
    conversation: Array<Record<string, unknown> & { id: string; role: string; content: string; sortOrder: number }>;
    // The user message that OPENED this turn: contest seeds, beat claims, roll
    // override and pending-recovery provenance all key on it.
    sourceUserMessageId: string;
    settlePrevious?: boolean;
    sceneConstraintOverride: { location: string; present: string[]; presentUnaware: string[] } | null;
    plan: AssistantTurnPlan;
  }) {
    const { userId, sessionId, session, campaign, runtime, model, wizardTemplates, requestId, emit, options, conversation, sourceUserMessageId, plan } = params;
    const input = { sceneConstraintOverride: params.sceneConstraintOverride ?? undefined } as Pick<ChatSendRequest, "sceneConstraintOverride">;
    plan.sourceUserMessageId = sourceUserMessageId;
    const assistantSortOrder = plan.assistantSortOrder;
    let stopRequested = false;
    const abortController = new AbortController();
    // Stop reaches the PRE-STREAM phases too (2026-09-04). The same signal the
    // composer call gets now threads through context assembly (HyDE, the
    // embedding query, the researcher), the antagonist-intent pass and the
    // contested-action classifier, and every network phase below is guarded on
    // it. Before this, a Stop pressed during assembly was only observed when the
    // composer call finally opened on the dead signal — after every helper had
    // run to completion.
    const stopSignal = abortController.signal;
    this.activeRequests.set(`${userId}:${requestId}`, {
      userId,
      sessionId,
      abortController,
      markStopped: () => { stopRequested = true; },
    });
    // Pre-composer phase timings: logged per turn and summarised in one
    // info note of the context dropdown.
    const turnStarted = performance.now();
    const phaseMs = new Map<PreComposerPhase, number>();
    try {
    const isCampaignSession = session.sessionType === "standard" && Boolean(session.campaignId);
    if (params.settlePrevious && isCampaignSession && campaign) {
      const settleStarted = performance.now();
      await this.ingestSettledReplies(userId, sessionId, sourceUserMessageId, campaign, session, stopSignal);
      phaseMs.set("settled replies", performance.now() - settleStarted);
    }
    // Reset character roster at session start: rebuild from system prompt firmware
    // so dead/removed characters don't persist as NOT PRESENT clutter.
    // During the session, new characters from [SCENE] blocks are appended as normal.
    const currentRoster: string[] = campaign ? safeParseJson<string[]>(campaign.characterRoster || "[]", []) : [];
    if (isCampaignSession && campaign) {
      // Reset fires on the first turn of each session: when the user's message exists
      // but no assistant response has been generated yet. The user message is already
      // in the DB by the time streamResponse runs, so checking for zero non-cold-start
      // messages never triggers. Checking for zero assistant messages is correct.
      // Fresh turns only: a regenerate of reply #1 sees a transcript
      // with no assistant turn too, and used to reset the roster back to firmware
      // — discarding the characters the first reply's [SCENE] block introduced,
      // which the swipe back to that reply then could not find.
      const hasAssistantMessages = conversation.some((m) => m.role === "assistant");
      if (!hasAssistantMessages && plan.kind === "append") {
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
    let contextDebug: ContextAssemblyDebug = { keywordHits: 0, semanticHits: 0, researcherHits: 0, absentContacts: 0, coldInflations: 0, droppedForBudget: 0, totalTokens: 0 };
    // The RETRIEVAL budget emitted with the context event as `budgetTokens` (this
    // local was once named contextBudgetTokens, the name of the transcript dial).
    let retrievalBudgetTokens = 0;
    // The emitted response.context payload, for the reply's snapshot.
    let contextSnapshotPayload: ContextSnapshotPayload | null = null;
    // The turn's activation delta (sticky/cooldown counters, lastActivatedTurn),
    // held until the composer call begins; see the commit just before it.
    let activationDeltaToCommit: Awaited<ReturnType<ContextEngine["assembleForTurn"]>>["activationDelta"] | null = null;
    let contextNotes: string[] = [];
    // Informational telemetry (feature-working-as-designed) — never chip-degrading.
    const contextInfoNotes: string[] = [];
    // Living World — NPC agenda block string, computed just below (after settings
    // resolve) and injected into the last user turn beside <character_attire>.
    let agendaContextBlock: string | null = null;
    // Budget-based context windowing for campaign sessions. Resolved BEFORE the
    // pre-composer phases (pure; the overlapped phases read it) and before the
    // context event so the agenda block's degradation note rides the same channel.
    const contextSettings = isCampaignSession && campaign && this.contextEngine
      ? this.contextEngine.resolveSettings({ contextOverridesJson: (session as any).contextOverridesJson })
      : null;

    // Owner roll override (composer 🎲 toggle). Read from the persisted USER
    // message rather than the request so regenerate/continue/edit-regenerate all
    // resolve under the same override the original send declared — the same
    // reason contest rolls are seeded on the user-message id. Applies in
    // <user>'s favour at both contest sites below and is stamped into each
    // printed basis trail; it never touches contests that don't oppose the PC.
    // Read before the phases start: the antagonist pass's contest callback uses it.
    const rollOverride = isCampaignSession && campaign
      ? Boolean(this.messages.findById(userId, sessionId, sourceUserMessageId)?.rollOverride)
      : false;

    // ── Pre-composer phases ──
    // Context assembly (HyDE, the query embedding, the researcher), the
    // antagonist-intent pass and the contest classifier read none of each
    // other's output, so by default the two model calls START alongside
    // assembly; a measurement found about 55 s of a 110 s turn in these calls
    // run back to back. Their results are consumed below in today's order, so the
    // state writes keep it: nemesis promotion inside the intent callback, then
    // the fuse burn, then the PC contest, resolved only after the intent pass
    // has settled. Every call carries the turn's Stop signal. The env switch
    // CHAT_PRECOMPOSER_OVERLAP=0 restores the serial order (the A/B lever for the
    // turn-time measurement, and a rollback without a deploy). Each phase is
    // settled into a result object the moment it starts, so a failure while
    // another phase is awaited can never surface as an unhandled rejection.
    const overlapPhases = process.env.CHAT_PRECOMPOSER_OVERLAP !== "0";
    const timePhase = <T>(phase: PreComposerPhase, run: () => Promise<T>): Promise<Settled<T>> => {
      const started = performance.now();
      // The executor runs `run` at once and turns a synchronous throw into a
      // rejection, so a phase that fails before its first await is settled too.
      return settle(new Promise<T>((resolve) => resolve(run()))).then((outcome) => { phaseMs.set(phase, performance.now() - started); return outcome; });
    };

    const startAssemblyPhase = (): Promise<Settled<Awaited<ReturnType<ContextEngine["assembleForTurn"]>>>> | null => {
      if (!(isCampaignSession && campaign && this.contextEngine?.isEnabled(session))) return null;
      const engine = this.contextEngine;
      return timePhase("context assembly", () => {
        // Sanitized names: knownBy routing keys on the roster's spelling.
        const presentChars: string[] = normalizePresentNames(safeParseJson<string[]>((session as any).scenePresent || "[]", []));
        // Present-unaware characters get their core forced in too and never
        // count as knowers. Only the session's
        // present-unaware list is read here: never NOT PRESENT, the roster or
        // its complement (that list tends to be long, and forcing it would be a
        // catastrophic bug).
        const unawareChars: string[] = normalizePresentNames(safeParseJson<string[]>((session as any).scenePresentUnaware || "[]", []))
          .filter((name) => !presentChars.includes(name));
        return engine.assembleForTurn({
          userId,
          session: { id: session.id, contextOverridesJson: (session as any).contextOverridesJson },
          campaign: { id: campaign.id },
          history: conversation.filter(m => m.role !== "cold-start").map(m => ({ role: m.role, content: m.content })),
          // The current user turn is the conversation's last user message (already
          // persisted by the caller); the engine dedupes it from the trailing history.
          userTurnText: [...conversation].reverse().find((m) => m.role === "user")?.content ?? "",
          dryRun: false,
          presentCharacters: presentChars,
          presentUnawareCharacters: unawareChars,
          signal: stopSignal,
        });
      });
    };

    // Antagonist intent. Villain fidelity is a
    // measured MODEL disposition — Claude-family ranks near the bottom, GLM/
    // DeepSeek/Kimi top (arXiv 2511.04962) — so the antagonist's DECISION is
    // authored off-Claude and the prose model only renders it. Inert unless an
    // antagonist model is configured AND a sealed antagonist is on-stage, so the
    // default costs nothing: no dial, no call, no latency.
    const promotedNemeses: string[] = [];
    const startIntentPhase = (): { briefs: AntagonistBrief[]; pending: Promise<Settled<Awaited<ReturnType<typeof runAntagonistIntent>>>> | null } | null => {
      if (!(isCampaignSession && campaign && this.drivesRepo && contextSettings && turnBlockAllowed("antagonist_intent", contextSettings) && !stopSignal.aborted)) return null;
      const briefs = this.buildAntagonistBriefs(
        campaign.id,
        session as unknown as { scenePresent?: string | null; scenePresentUnaware?: string | null },
        contextSettings.playerCharacterKeys ?? [],
      );
      // Fresh user turns only. The pass is NOT
      // idempotent: an antagonist win promotes the nemesis (rank/scar/
      // familiarity, all increments) and a continue used to inject a NEW move
      // ahead of a truncated reply that had already carried out the previous
      // one. A regenerate/continue re-renders the same seed and must not fire
      // it again — the render model decides, as it does when the pass returns
      // nothing.
      if (briefs.length === 0 || !antagonistRunsForPlan(plan.kind)) return { briefs, pending: null };
      // Ten turns, not four: the intent pass authors the antagonist's MOVES,
      // and a four-turn window left it blind to anything established earlier
      // in the scene — on 2026-08-02 it kept authoring "deceive" moves five
      // turns after a player-character ability made deception impossible, and the
      // render model reconciled the contradiction by narrating lies as
      // technically-true dodges. ~14k chars ≈ 4k tokens on the antagonist
      // model per turn; trivial spend for move-legality.
      //
      // TAIL-sliced, not head-sliced (2026-08-19). Scene-state changes — who
      // sat down, who softened, who arrived or left — land at turn ENDINGS,
      // and the old head slice cut exactly those off: the pass kept authoring
      // moves against each turn's OPENING posture (an antagonist was
      // ordered "stays on his feet" one beat after the transcript sat him
      // down and softened him). The final message gets a deeper tail — it is
      // the authoritative present the move must launch from.
      const recentForScene = conversation.slice(-10).map((m, i, arr) => {
        const budget = i === arr.length - 1 ? 3000 : 1400;
        const text = m.content.length > budget ? `…${m.content.slice(-budget)}` : m.content;
        return `[${m.role}]: ${text}`;
      }).join("\n\n");
      const pending = timePhase("antagonist intent", () => runAntagonistIntent({
        runtime: this.runtimeForUser(userId),
        modelId: contextSettings.antagonistModel,
        openaiFastMode: contextSettings.openaiFastModeEnabled,
        briefs,
        sceneSummary: recentForScene,
        requestId: `antagonist-intent-${session.id}`,
        signal: stopSignal,
        // Phase 7: an antagonist that declares a contest gets it resolved in
        // CODE, inside the same block. The intent pass names the stake; the dice
        // are ours. Gated with the same stance rule as every other producer.
        resolveContest: this.adversarialWorld && contextSettings.contestedOutcomesEnabled && (contextSettings.worldStance ?? 1) >= 2
          ? ({ actor, action, opposes, difficulty }) => {
              // NOTE the inversion: resolveContested's success window always
              // favours <user>, and stance weighting narrows it as stance rises.
              // An ANTAGONIST's attempt therefore succeeds when <user>'s implicit
              // resistance fails, so we roll <user>'s side and invert the verdict.
              // Doing it this way keeps one weighting rule for the whole system
              // instead of a second, quietly divergent one for NPCs.
              const outcome = this.adversarialWorld!.resolveContested({
                baseTarget: NPC_CONTEST_TARGET[difficulty],
                worldStance: contextSettings.worldStance ?? 1,
                // Seeded per (turn, actor) so a regenerate cannot re-roll the
                // antagonist's attempt either.
                seed: `${sourceUserMessageId}:npc:${actor}`,
                // An ARMED 🎲 fails EVERY antagonist contest this turn — no
                // opposition-target gate. The gate used to be
                // opposesPlayer(opposes, playerCharacterKeys), a substring
                // match against the intent model's FREE-TEXT opposition; when
                // it phrased the target as "the intruder" / "the barrier" /
                // an ally's name, the match missed, natural dice ran, and
                // adversaries kept winning inside armed turns
                // (2026-08-03). Armed means the turn goes the
                // owner's way, period — it is one-shot and deliberate, so the
                // blast radius is a single turn.
                forceSuccess: rollOverride,
              });
              const antagonistWon = !outcome.success;
              // Nemesis promotion (phase 6's producer). An antagonist who beats
              // <user> rises in rank, carries the scar, and grows familiar — so a
              // recurring villain is earned by what happened rather than re-rolled
              // at random. Only counts when <user> was the one opposed.
              // Not on a stopped turn: the pass may complete after the owner
              // pressed Stop, and a rank earned for a move that never rendered is a
              // side effect the placeholder reply cannot justify.
              if (antagonistWon && !stopSignal.aborted && this.opposesPlayer(opposes, contextSettings.playerCharacterKeys ?? [])) {
                this.adversarialWorld!.promoteNemesis(campaign.id, actor, action, contextSettings.worldStance ?? 1);
                // Surfaced, not silent. An antagonist gaining rank off a win
                // against <user> is exactly the kind of thing that should never
                // happen where only the server log can see it.
                promotedNemeses.push(actor);
              }
              return { success: antagonistWon, roll: outcome.roll, target: outcome.target, basis: outcome.basis };
            }
          : undefined,
      }));
      return { briefs, pending };
    };

    // Contested action (phase 7 producer). The player's turn is
    // classified BEFORE rendering, resolved by CSPRNG in code, and injected as a
    // settled result — so the render model never holds the dice. Seeded on the
    // user-message id so a regenerate re-renders the same outcome instead of
    // re-rolling it, which would make swipe a dice-reroll and reopen exactly the
    // hole the consequence ledger closes.
    const startClassifierPhase = (): Promise<Settled<Awaited<ReturnType<typeof classifyContestedAction>>>> | null => {
      if (!(
        isCampaignSession && campaign && this.adversarialWorld && this.drivesRepo
        && contextSettings && turnBlockAllowed("contested_outcome", contextSettings)
        && contestRunsForPlan(plan.kind)
        && !stopSignal.aborted
      )) return null;
      const userTurnText = [...conversation].reverse().find((m) => m.role === "user")?.content ?? "";
      const worldModel = contextSettings.worldStateModel?.trim() || contextSettings.driveModel;
      return timePhase("contest classifier", () => classifyContestedAction({
        runtime: this.runtimeForUser(userId),
        modelId: worldModel,
        openaiFastMode: contextSettings.openaiFastModeEnabled,
        userTurn: userTurnText,
        // Six turns, not three: routine-competence judgment needs to SEE the
        // recent demonstrations (the healer healing two scenes ago) or every
        // display of established power reads as a novel gamble. TAIL-sliced
        // (2026-08-19): demonstrations and state changes land at turn endings,
        // which the old head slice cut off — same blindness as the antagonist
        // window above.
        sceneSummary: conversation.slice(-6).map((m) => {
          const text = m.content.length > 1000 ? `…${m.content.slice(-1000)}` : m.content;
          return `[${m.role}]: ${text}`;
        }).join("\n\n"),
        requestId: `contest-classify-${session.id}`,
        signal: stopSignal,
      }));
    };

    const assemblyPhase = startAssemblyPhase();
    let intentPhase = overlapPhases ? startIntentPhase() : null;
    let classifierPhase = overlapPhases ? startClassifierPhase() : null;

    if (assemblyPhase) {
      // Assembly and activation-commit are guarded SEPARATELY: a commit failure
      // must not discard assembled context, and an assembly failure must be
      // loudly visible (system event + preview note), never silent. The old
      // single catch mislabeled every retrieval outage as
      // "commitActivationState failed (non-fatal)".
      const settledAssembly = await assemblyPhase;
      const contextAssembly = settledAssembly.ok ? settledAssembly.value : null;
      if (!settledAssembly.ok) {
        const err = settledAssembly.error;
        if (stopSignal.aborted && isAbortError(err)) {
          // User Stop mid-assembly (2026-09-04): the turn's signal reached the
          // in-flight helper and the engine threw its AbortError. Not a
          // retrieval failure — no event, no note; the pre-stream check inside
          // the composer try ends the turn as stopped.
        } else {
          const reason = err instanceof Error ? err.message : String(err);
          chatLogger.error({ err, sessionId: session.id }, "context assembly failed — turn proceeds WITHOUT retrieved context");
          contextNotes.push(`Context assembly failed (${reason}) — this turn ran without retrieved lorebook context`);
          recordSystemEvent({
            userId,
            source: "context_assembly",
            severity: "error",
            message: `context assembly failed — turn ran without retrieved context: ${reason}`,
            campaignId: campaign!.id,
            sessionId: session.id,
          });
        }
      }
      if (contextAssembly && this.contextEngine) {
        retrievedContext = contextAssembly.retrievedSection;
        contextPreview = contextAssembly.preview;
        contextDebug = contextAssembly.debug;
        contextNotes = [...contextNotes, ...contextAssembly.notes];
        contextInfoNotes.push(...(contextAssembly.infoNotes ?? []));
        retrievalBudgetTokens = this.contextEngine.resolveSettings({ contextOverridesJson: (session as any).contextOverridesJson }).retrievalBudgetTokens;
        if (contextAssembly.researcherUsage) {
          overheadEntries.push({ source: "researcher", ...contextAssembly.researcherUsage });
        }
        if (contextAssembly.hydeUsage) {
          overheadEntries.push({ source: "hyde", ...contextAssembly.hydeUsage });
        }
        // Fresh user turns only. A regenerate or
        // continue re-assembles the SAME logical turn: committing its delta
        // decremented every carried sticky and cooldown counter a second time
        // and re-stamped lastActivatedTurn, so a few swipes exhausted a sticky
        // meant to last N turns. A swipe re-reads the state the original send
        // left (the same rule as the threat fuses and the antagonist pass).
        if (plan.kind === "append") activationDeltaToCommit = contextAssembly.activationDelta;
      }
    }

    // Living World — assemble the NPC agenda block (deterministic, present-only).
    if (isCampaignSession && campaign && this.drivesRepo && contextSettings && turnBlockAllowed("character_agendas", contextSettings)) {
      const built = this.buildAgendaBlock(campaign.id, session as unknown as { scenePresent?: string | null; scenePresentUnaware?: string | null }, contextSettings.playerCharacterKeys);
      agendaContextBlock = built.block;
      if (built.note) contextNotes.push(built.note);
    }

    if (rollOverride) {
      contextInfoNotes.push("Owner roll override: this turn's contested outcomes resolve in <user>'s favour — <user>'s contests succeed and ALL antagonist contests fail (stamped in each printed basis trail).");
    }

    // Antagonist intent: started with assembly (overlap) or now (serial).
    if (!overlapPhases) intentPhase = startIntentPhase();
    let antagonistIntentBlock: string | null = null;
    if (intentPhase && intentPhase.briefs.length > 0 && !intentPhase.pending) {
      contextInfoNotes.push(`Antagonist intent: ${intentPhase.briefs.length} antagonist(s) on stage; the intent pass runs once per user turn and is not re-run on a regenerate/continue.`);
    } else if (intentPhase?.pending && contextSettings && campaign) {
      const settledIntent = await intentPhase.pending;
      // The pass never throws for a model failure (it reports `failure`); a
      // throw is our own write inside the contest callback, which fails the
      // turn exactly as it did when the pass ran alone.
      if (!settledIntent.ok) throw settledIntent.error;
      const intent = settledIntent.value;
      const briefs = intentPhase.briefs;
      antagonistIntentBlock = intent.block;
      if (intent.usage) overheadEntries.push({ source: "antagonist", ...intent.usage });
      if (intent.failure) {
        recordSystemEvent({
          userId, source: "antagonist_intent", severity: "warn",
          campaignId: campaign.id, sessionId: session.id,
          message: `antagonist-intent pass failed on ${contextSettings.antagonistModel}: ${intent.failure} — the render model decided this turn`,
        });
      }
      contextInfoNotes.push(intent.block
        ? `Antagonist intent: ${briefs.length} antagonist(s) authored on ${contextSettings.antagonistModel}.`
        : intent.failure
          ? `Antagonist intent: the pass FAILED (${intent.failure}); the render model decides this turn.`
          : `Antagonist intent: ${briefs.length} antagonist(s) on stage but the intent pass returned no moves; the render model decides this turn.`);
      // NPC contests resolve INSIDE the intent block, so without this they would
      // land with no visible trace anywhere in the UI.
      for (const settled of intent.resolved) {
        contextInfoNotes.push(`Contested action resolved in code: ${settled.actor} — ${settled.action} → ${settled.success ? "succeeds" : "fails"} (rolled ${settled.roll} vs ${settled.target}).`);
      }
      if (promotedNemeses.length > 0) {
        contextInfoNotes.push(`Nemesis promoted after beating <user>: ${promotedNemeses.join(", ")} — rank, scar and familiarity all up.`);
      }
    }

    // Established consequences + offscreen clock pressure (phases 4 and 6).
    // The consequence constraint is what closes the regeneration hole: without it
    // a swipe silently resurrects whatever the ledger records, which makes every
    // other lethality mechanism decorative. The clock block is stance-gated
    // inside the repository (null below stance 2). The consequence block has no
    // stance or dial check: it renders whenever the ledger holds rows, and the
    // ledger fills only while Record world state is on at stance 2 or above, so
    // it is null at the shipped default; rows recorded earlier keep rendering
    // after the stance or the dial is lowered.
    let consequenceBlock: string | null = null;
    let clockPressureBlock: string | null = null;
    if (isCampaignSession && campaign && this.adversarialWorld) {
      consequenceBlock = this.adversarialWorld.buildConsequenceConstraint(campaign.id);
      // The shared gate (turnBlocks.ts) is the same stance-2 threshold the
      // repository applies inside buildClockBlock; the viewer reads it too.
      clockPressureBlock = contextSettings && turnBlockAllowed("clock_pressure", contextSettings)
        ? this.adversarialWorld.buildClockBlock(campaign.id, contextSettings.worldStance ?? 1)
        : null;
      // Threat fuses burn on the SOURCE character's opportunities, so this runs
      // against who is actually on stage rather than on elapsed turns — and
      // only on a FRESH user turn: a fuse counts on-stage turns, and
      // burning it on every regenerate let a couple of swipes exhaust a fuse
      // meant to last N turns.
      // … and never on a turn the owner already stopped: a Stop during
      // assembly ended the turn as a placeholder while the fuse still lost an
      // opportunity, and the resend burned a second one. Beat claims have their
      // release in the finally; fuses have no compensating write, so gate here.
      if (plan.kind === "append" && !stopSignal.aborted) {
        const presentNow = normalizePresentNames(safeParseJson<string[]>((session as any).scenePresent ?? "[]", []));
        const expired = this.adversarialWorld.burnOpportunities(campaign.id, presentNow);
        if (expired.length > 0) {
          contextNotes.push(`${expired.length} threat fuse(s) ran out without a concrete attempt: ${expired.map((t) => `${t.sourceCharacter} → ${t.target}`).join("; ")}.`);
        }
      }
      // Visibility for the producers (phase 7): the owner has no other window onto
      // what the extraction pass wrote, and a ledger that grows silently is how
      // phases 3-6 sat inert for two days without anyone noticing.
      const ledgerCount = this.adversarialWorld.listConsequences(campaign.id, 100).length;
      const armedCount = this.adversarialWorld.listArmedThreats(campaign.id).length;
      if (ledgerCount > 0 || armedCount > 0) {
        contextInfoNotes.push(`Adversarial world: ${ledgerCount} established consequence(s) in force, ${armedCount} threat fuse(s) armed.`);
      }
    }

    // The PC's contest: classified alongside assembly (overlap) or now (serial),
    // and resolved only now, after the intent pass has settled and the fuses
    // have burned, as before.
    if (!overlapPhases) classifierPhase = startClassifierPhase();
    let contestedBlock: string | null = null;
    if (classifierPhase && contextSettings && campaign && this.adversarialWorld) {
      const settledClassification = await classifierPhase;
      if (!settledClassification.ok) throw settledClassification.error;
      const classification = settledClassification.value;
      if (classification.usage) overheadEntries.push({ source: "contest", ...classification.usage });
      if (classification.failure) {
        contextNotes.push(`Contested-action classification failed (${classification.failure}) — this turn's outcome was not resolved in code.`);
      }
      // A contest classified before a Stop that landed later in the overlap is
      // not resolved: the stopped turn renders nothing (serial never classified it).
      if (classification.contest && !stopSignal.aborted) {
        const contest = classification.contest;
        const opposing = this.findStandingForOpposition(campaign.id, contest.opposition);
        const outcome = this.adversarialWorld.resolveContested({
          baseTarget: baseTargetFor(contest),
          worldStance: contextSettings.worldStance ?? 1,
          modifiers: opposing
            ? standingModifiers({ kind: contest.kind, trust: opposing.trust, grudge: opposing.grudge, characterName: opposing.name })
            : [],
          seed: `${sourceUserMessageId}:pc`,
          forceSuccess: rollOverride,
        });
        contestedBlock = buildContestedBlock({
          contest,
          outcome,
          playerName: contextSettings.playerCharacterKeys?.[0] ?? "<user>",
        });
        contextInfoNotes.push(`Contested ${contest.kind} action resolved in code: ${outcome.success ? "success" : "failure"} (rolled ${outcome.roll} vs ${outcome.target})${rollOverride ? " — owner override" : ""}.`);
      }
    }

    // A phone/text/call beat often names nobody until the user chooses a
    // recipient. Pull a tiny, deterministic absent-cast index so the model has
    // the relationship posture before it invents who answers or how they feel.
    let absentContactsContextBlock: string | null = null;
    let commsContactNames: string[] = [];
    if (isCampaignSession && campaign && this.drivesRepo) {
      const recentUser = [...conversation].reverse().find((m) => m.role === "user")?.content ?? "";
      const recentAssistant = [...conversation].reverse().find((m) => m.role === "assistant")?.content ?? "";
      if (hasCommsReference(`${recentAssistant}\n${recentUser}`)) {
        const built = this.buildAbsentContactsBlock(
          campaign.id,
          session as unknown as { scenePresent?: string | null; scenePresentUnaware?: string | null },
          contextSettings?.playerCharacterKeys ?? [],
        );
        absentContactsContextBlock = built.block;
        commsContactNames = built.names;
        contextDebug.absentContacts = built.count;
        // INFO, not warn: the pull firing (or having nothing to pull on a
        // campaign without absent-contact sheets) is routine telemetry, and it
        // was painting the Preview chip amber on every comms turn.
        contextInfoNotes.push(built.count > 0
          ? `Comms context: injected ${built.count} absent contact${built.count === 1 ? "" : "s"} from drive sheets.`
          : "Comms context: no eligible absent contact sheets were available; no contact assumptions were injected.");
      }
    }

    // Offscreen-flow (2026-07-17): per-NPC offscreen memory — deterministic,
    // like agendas. Every present/present-unaware/comms-pulled character carries
    // their recent offscreen reality into the scene instead of hoping keyword
    // retrieval surfaces it.
    let offscreenMemoryBlock: string | null = null;
    if (isCampaignSession && campaign && this.contextEngine) {
      const presentNames = normalizePresentNames([
        ...safeParseJson<string[]>((session as { scenePresent?: string | null }).scenePresent || "[]", []),
        ...safeParseJson<string[]>((session as { scenePresentUnaware?: string | null }).scenePresentUnaware || "[]", []),
      ]);
      const relevant = [...new Set([...presentNames, ...commsContactNames])];
      if (relevant.length > 0) {
        const ledger = this.contextEngine.listActiveOffscreen(userId, campaign.id);
        const built = renderOffscreenMemoryBlock(ledger, relevant);
        offscreenMemoryBlock = built.block;
        if (built.facts > 0) {
          contextInfoNotes.push(`Offscreen memory: ${built.facts} behind-the-scenes event${built.facts === 1 ? "" : "s"} carried by ${built.characters} character${built.characters === 1 ? "" : "s"} in this scene.`);
        }
      }
    }

    // Living World — claim due beats atomically for a normal appended turn.
    // Regenerate/continue replay the beats linked to the same source user
    // message, so a swipe cannot silently erase or duplicate a world event.
    let dueBeatsBlock: string | null = null;
    if (isCampaignSession && campaign && this.beatsRepo) {
      const storyNow = latestInWorldSceneDate(conversation as Array<{ role: string; sceneData?: string | null }>);
      const due = plan.kind === "append"
        ? this.beatsRepo.duePending(campaign.id, storyNow?.epoch ?? null).slice(0, 3)
          .filter((beat) => this.beatsRepo!.claimForMessage(campaign.id, beat.id, sourceUserMessageId))
        : this.beatsRepo.listForFiredMessage(campaign.id, sourceUserMessageId).slice(0, 3);
      dueBeatsBlock = renderDueBeatsDirective(due);
    }

    // Scene tempo gear (Character Engine, 2026-08-30). Rolled from the
    // triggering user message id with the contested-outcome seed discipline —
    // a regenerate re-renders the same gear — and hysteresis folded over the
    // session's recomputed gear history (stateless; nothing stored). Settled
    // work outranks the gear: a turn already carrying a contested resolution,
    // an antagonist decision, or due beats floors NEUTRAL to STEADY so the
    // quiet gear can never mute an obligation; the block's own closing line
    // subordinates it to spotlight and consequence blocks as well.
    let sceneTempoBlock: string | null = null;
    if (isCampaignSession && contextSettings && turnBlockAllowed("scene_tempo", contextSettings)) {
      const orderedUserIds = conversation
        .filter((m): m is typeof m & { role: "user" } => m.role === "user")
        .map((m) => String((m as { id: string }).id));
      if (orderedUserIds.length > 0) {
        const tempo = computeSceneTempo(orderedUserIds);
        const settledWork = Boolean(contestedBlock || antagonistIntentBlock || dueBeatsBlock);
        const gear = settledWork && tempo.gear === "NEUTRAL" ? "STEADY" : tempo.gear;
        sceneTempoBlock = buildSceneTempoBlock(gear);
        const provenance =
          gear !== tempo.gear
            ? ` (rolled ${tempo.rolled}, floored to STEADY — settled work this turn)`
            : gear !== tempo.rolled
              ? ` (rolled ${tempo.rolled}, stepped up — quiet streak)`
              : "";
        contextInfoNotes.push(`Scene tempo: ${gear}${provenance}.`);
      }
    }

    // Where the pre-composer time went: one info note and one log line
    // per turn, so the overlap's effect is measurable turn by turn
    // (CHAT_PRECOMPOSER_OVERLAP=0 is the serial baseline).
    if (phaseMs.size > 0) {
      const totalMs = performance.now() - turnStarted;
      const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
      const phases = PRE_COMPOSER_PHASES.filter((phase) => phaseMs.has(phase)).map((phase) => `${phase} ${seconds(phaseMs.get(phase)!)}`);
      contextInfoNotes.push(`Pre-composer phases (${overlapPhases ? "overlapped" : "serial"}): ${phases.join(", ")}; ${seconds(totalMs)} in all before the reply was requested.`);
      chatLogger.info({ sessionId, requestId, plan: plan.kind, overlap: overlapPhases, phasesMs: Object.fromEntries([...phaseMs].map(([phase, ms]) => [phase, Math.round(ms)])), totalMs: Math.round(totalMs) }, "pre-composer phase timings");
    }

    // Always emit when there is ANYTHING to show — including failure notes with
    // an empty preview, so a degraded turn is visible in the preview dropdown.
    if (contextPreview.length > 0 || contextNotes.length > 0 || contextInfoNotes.length > 0) {
      // A stopped turn sends no context event — its notes describe phases the
      // stop cut short and the completion that follows is the placeholder.
      if (!stopSignal.aborted) {
        emit({ type: "response.context", preview: contextPreview, debug: contextDebug, budgetTokens: retrievalBudgetTokens, notes: contextNotes, infoNotes: contextInfoNotes });
        // What the owner saw in the Preview for this turn, kept for the reply it
        // produces: stored once that reply persists in messages.
        contextSnapshotPayload = { preview: [...contextPreview], debug: { ...contextDebug }, budgetTokens: retrievalBudgetTokens, notes: [...contextNotes], infoNotes: [...contextInfoNotes], createdAt: new Date().toISOString() };
      }
    }
    const systemPromptEstimate = isCampaignSession
      ? estimateTokens(buildSessionSystemPrompt({
          systemPrompt: campaign?.systemPrompt ?? null,
          isCampaignSession,
          antiRepetitionJson: (campaign as any)?.antiRepetitionJson ?? null,
          npcInitiative: contextSettings?.npcInitiative,
          playerCharacterKeys: contextSettings?.playerCharacterKeys,
          gritBlocks: contextSettings ? buildGritBlocks(contextSettings) : null,
          characterIntegrity: contextSettings?.characterIntegrityEnabled ? buildCharacterIntegrityBlock() : null,
          contentHonesty: contextSettings?.contentHonestyEnabled && contentHonestyApplies(model) ? buildContentHonestyBlock() : null,
        }) ?? "")
      : estimateTokens(campaign?.systemPrompt ?? "");
    const windowedConversation = contextSettings
      ? windowConversation(conversation, {
          modelCtx: model.ctx,
          modelMaxOut: model.maxOut,
          contextBudgetTokens: contextSettings.contextBudgetTokens,
          guaranteedMessageCount: contextSettings.guaranteedMessageCount,
          systemPromptTokens: systemPromptEstimate,
          // The retrieval dial is a reservation for the retrieved section, so it
          // is reserved only when the engine runs for this session. With
          // retrieval Off nothing is retrieved, and the
          // reservation used to shrink the transcript backfill by the whole dial.
          // The dial, not the measured section, stays the reservation: a
          // per-turn measurement would move the window start and cost
          // prompt-cache hits.
          retrievedContextTokens: retrievalRuns(contextSettings) ? contextSettings.retrievalBudgetTokens : 0,
        })
      : conversation;
    // Attachment bodies (base64 images up to 6.5M chars each) only for the
    // messages that actually go to the provider — the whole-session load ran
    // before windowing and read every attachment of a 4,700-turn session on
    // every send.
    const attachmentMap = this.getAttachmentMap(userId, sessionId, windowedConversation.map((m) => m.id));

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
    if (isCampaignSession && campaign && this.attireRepo && contextSettings && turnBlockAllowed("character_attire", contextSettings)) {
      const presentNow: string[] = safeParseJson<string[]>((session as any).scenePresent || "[]", []);
      const unawareNow: string[] = safeParseJson<string[]>((session as any).scenePresentUnaware || "[]", []);
      // Sanitized names: attire rows are keyed by the roster's spelling.
      const allNow = normalizePresentNames([...presentNow, ...unawareNow]);
      if (allNow.length > 0) {
        const rows = this.attireRepo.findManyByCharacter(campaign.id, allNow);
        // A row whose source reply no longer stands is withdrawn, never injected
        // Every mutation path reconciles before this runs, so a
        // hit here means a path was missed: record it instead of poisoning the turn.
        const withdrawn = new Set(this.attireRepo.listDeadProvenance(campaign.id, allNow)
          .filter((r) => r.lastSeenInPresentTurn <= r.lastUpdatedTurn).map((r) => r.characterName));
        if (withdrawn.size) {
          recordSystemEvent({
            userId, source: "scene_validator", severity: "info", campaignId: campaign.id, sessionId,
            message: "attire record whose source reply was deleted or superseded reached context assembly; withdrawn from the block",
            details: { characters: [...withdrawn] },
          });
        }
        const byName = new Map(rows.filter((r) => !withdrawn.has(r.characterName)).map((r) => [r.characterName, r]));
        const currentTurnEstimate = Math.max(0, ...conversation.map((m: any) => Number(m.sortOrder ?? 0))) + 1;
        const lines: string[] = [];
        for (const name of allNow) {
          const row = byName.get(name);
          if (!row) {
            lines.push(withdrawn.has(name)
              ? `${name}: (attire record withdrawn; its source reply was deleted or superseded. Establish plausible attire as you write)`
              : `${name}: (no attire recorded yet; establish plausible attire as you write)`);
            continue;
          }
          const turnsAgo = Math.max(0, currentTurnEstimate - row.lastUpdatedTurn);
          const stale = turnsAgo >= contextSettings.attireStaleTurnThreshold;
          const freshness = stale
            ? `last updated ${turnsAgo} turns ago [stale; consider plausible changes since this character was last seen]`
            : `last updated ${turnsAgo} turn${turnsAgo === 1 ? "" : "s"} ago`;
          lines.push(`${name} (${freshness}): ${row.attireDescription}`);
        }
        if (lines.length > 0) {
          attireContextBlock = lines.join("\n");
        }
      }
    }

    // Living World — spotlight wrapper. DERIVED from the persisted marker on the
    // triggering user turn, so regenerate/swipes reconstruct it deterministically
    // with no extra state threaded through the request. Only a row whose
    // kind is gm_spotlight is a marker: text a player
    // typed in the marker's format is an ordinary player message.
    let spotlightWrapper: string | null = null;
    if (isCampaignSession && campaign && this.drivesRepo) {
      const lastUser = [...conversation].reverse().find((m) => (m as { role: string }).role === "user") as { content?: string; directiveKind?: string | null } | undefined;
      if (lastUser?.directiveKind === "gm_spotlight") {
        spotlightWrapper = this.buildSpotlightWrapper(campaign.id, (lastUser.content ?? ""), contextSettings?.playerCharacterKeys ?? []);
      }
    }

    // PC-authority reminder at the recency end of the injected blocks. The
    // norms live in the system prompt ~150k tokens from the pen; with tens of
    // thousands of injected tokens between, compliance decays exactly like the
    // scene-instruction case (whose fix was the same shape: rule FIRST in the
    // prompt + a reminder at the end). By 2026-08-24 the composer
    // had begun authoring the PC's dialogue lines, interjections, and device
    // operation in long scenes.
    const playerAuthorityReminder = isCampaignSession && contextSettings && turnBlockAllowed("player_authority", contextSettings)
      ? buildPlayerAuthorityReminder(contextSettings.playerCharacterKeys)
      : null;

    // Character Engine style gate — the voice pack's recency-end enforcer.
    // Style rules parked in the system prompt dilute across ~150k tokens and
    // the model imitates its own logged output instead; this repeats the
    // highest-value checks where <player_authority> proved compliance lives.
    const styleGateBlock = isCampaignSession && contextSettings && turnBlockAllowed("style_gate", contextSettings) ? buildStyleGateBlock() : null;

    // Content Honesty (2026-08-30)
    // — the refusal-prevention stack for the composers that need it (Google +
    // Kimi K3; structurally inert everywhere else). The icebreaker's mechanism
    // is the assistant ROLE: prepended to the first assistant reply so the
    // model reads its own prior agreement — byte-identical to the validated
    // battery wire (the merged model turn). A session's first turn has no
    // assistant message; the system section alone covers it. Deterministic:
    // same text at the same position on every turn, so regenerates re-render
    // the identical wire and the prefix stays cache-stable.
    const contentHonestyOn = isCampaignSession && Boolean(contextSettings) && turnBlockAllowed("content_honesty_escalation", contextSettings, model);
    if (contentHonestyOn) {
      const firstAssistant = runtimeMessages.find((message) => message.role === "assistant");
      if (firstAssistant) firstAssistant.content = `${buildIcebreakerTurnHonest()}\n\n${firstAssistant.content}`;
    }
    const contentHonestyEscalationBlock = contentHonestyOn ? buildContentHonestyEscalationBlock() : null;

    // The per-turn blocks in wire order (turnBlocks.ts TURN_BLOCK_ORDER, the
    // single list the Injected-text viewer reads too). Why each sits
    // where it does:
    //  - the contested result, the settled consequences and the attire ride
    //    near the end with the other settled facts: outcomes to render, not
    //    context to weigh, and a regeneration cannot quietly walk them back;
    //  - antagonist intent sits just ahead of any spotlight: a settled decision
    //    the turn must carry out, and recency keeps the render model from
    //    reconsidering it;
    //  - the tempo gear shapes the whole reply, so it rides after the settled
    //    facts it defers to and before the spotlight it names;
    //  - the spotlight sits closest to the beat the model writes;
    //  - the style gate governs HOW every line above renders, then the scope
    //    confirmation (Google + Kimi-K3 composers only), and the PC-authority
    //    reminder is the absolute last line before the user's turn: it binds
    //    every block above it, including a spotlight, where the temptation to
    //    speak for the PC is highest.
    const parts = orderTurnBlocks({
      retrieved_context: retrievedContext?.trim() ? `<retrieved_context>\n${retrievedContext.trim()}\n</retrieved_context>` : null,
      character_agendas: agendaContextBlock ? `<character_agendas>\n${agendaContextBlock}\n</character_agendas>` : null,
      absent_contacts: absentContactsContextBlock ? `<absent_contacts source="drive_sheets" trigger="comms">\n${absentContactsContextBlock}\n</absent_contacts>` : null,
      offscreen_memory: offscreenMemoryBlock ? `<offscreen_memory source="world_ticks">\n${offscreenMemoryBlock}\n</offscreen_memory>` : null,
      clock_pressure: clockPressureBlock,
      contested_outcome: contestedBlock,
      consequences: consequenceBlock,
      character_attire: attireContextBlock ? `<character_attire>\n${attireContextBlock}\n</character_attire>` : null,
      due_beats: dueBeatsBlock ? `<due_beats>\n${dueBeatsBlock}\n</due_beats>` : null,
      antagonist_intent: antagonistIntentBlock,
      scene_tempo: sceneTempoBlock,
      spotlight: spotlightWrapper,
      style_gate: styleGateBlock,
      content_honesty_escalation: contentHonestyEscalationBlock,
      player_authority: playerAuthorityReminder,
    });
    if (parts.length > 0) {
      const contextTarget = [...runtimeMessages].reverse().find((message) => message.role === "user");
      if (contextTarget) {
        contextTarget.content = `${parts.join("\n\n")}\n\n${contextTarget.content}`;
      }
    }

    let assistantText = "";
    let assistantThinking = "";
    let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null };
    let outputTruncated = false;
    let stopReason: string | null = null;
    let stopDetails: import("@tracyhill-rp/contracts").StopDetails = null;
    let servedModel: string | null = null;
    // Fast mode gating — one switch per provider family (2026-09-09):
    //  • Anthropic DIRECT models with catalog fast pricing follow `fastModeEnabled`
    //    (the ⚡ button). Claude bridges (provider:claude-code) are excluded
    //    deliberately: the Agent SDK's fastMode setting bills usage credits at the direct
    //    rate and only covers Opus 4.8/5.
    //  • Every supported OpenAI model — direct Astra (service_tier:"fast") and the
    //    tiered CodexBridge entries (App Server `priority`) — follows the Engine
    //    dial `openaiFastModeEnabled`, the same switch the helpers and workers read.
    // The provider's echo decides what gets persisted (usage.speed → message.fastMode);
    // a requested-but-unapplied fast turn is recorded standard and raises a warning.
    const anthropicFastOn = Boolean(contextSettings?.fastModeEnabled
      && model.supportsFastMode
      && model.provider === "anthropic");
    const requestedSpeed: "fast" | undefined = openaiFastModeFor(model.id, contextSettings?.openaiFastModeEnabled)
      ?? (anthropicFastOn ? "fast" : undefined);
    let sceneBufferFlushed = !isCampaignSession; // non-campaign sessions flush immediately
    // One-shot scene constraint: only used for this single streaming call.
    // Never persisted to DB, never carried to subsequent turns.
    const oneShotSceneConstraint = input.sceneConstraintOverride && isCampaignSession
      ? buildSceneConstraintBlock(input.sceneConstraintOverride)
      : null;
    // Activation state commits when the composer call is about to begin:
    // a Stop during assembly, the antagonist pass or the contest classifier ends
    // the turn as a placeholder before any entry reached the model, so it commits
    // nothing and the resend re-reads the same sticky/cooldown state. A turn
    // stopped mid-stream did deliver its context, and its commit stands.
    if (activationDeltaToCommit && this.contextEngine && !stopSignal.aborted) {
      try {
        await this.contextEngine.commitActivationState(session.id, activationDeltaToCommit);
      } catch (err) {
        chatLogger.warn({ err, sessionId: session.id }, "commitActivationState failed (non-fatal)");
        recordSystemEvent({
          userId, source: "context_assembly", severity: "warn", campaignId: campaign?.id ?? null, sessionId: session.id,
          message: `activation-state commit failed — sticky/cooldown state for this turn was not persisted: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    try {
      // Stop pressed during the pre-stream phases (2026-09-04): land on the
      // existing stopped path with nothing streamed — "*[Stopped before
      // response began]*" — instead of opening a composer call on a dead
      // signal (most runtimes reject an aborted signal at once; this makes it
      // unconditional and immediate).
      if (stopSignal.aborted) throw stoppedBeforeStreamError();
      await runtime.streamChat({
        modelId: model.id,
        systemPrompt: session.sessionType === "wizard"
          ? buildWizardSessionPrompt({
              exampleSystemPrompt: wizardTemplates?.exampleSystemPrompt ?? "",
            })
          : appendOneShotConstraint(
              buildSessionSystemPrompt({
                // Campaign prompt first; otherwise the session's own prompt — 15 live
                // standalone V1-era sessions still carry one (measured 2026-09-02 evening;
                // this fallback was once removed on the premise that every row was
                // empty). The column stays for as long as those sessions do.
                systemPrompt: campaign?.systemPrompt ?? (session.systemPrompt || null),
                isCampaignSession,
                antiRepetitionJson: (campaign as any)?.antiRepetitionJson ?? null,
                npcInitiative: contextSettings?.npcInitiative,
                playerCharacterKeys: contextSettings?.playerCharacterKeys,
                gritBlocks: contextSettings ? buildGritBlocks(contextSettings) : null,
                characterIntegrity: contextSettings?.characterIntegrityEnabled ? buildCharacterIntegrityBlock() : null,
                contentHonesty: contextSettings?.contentHonestyEnabled && contentHonestyApplies(model) ? buildContentHonestyBlock() : null,
              }),
              oneShotSceneConstraint,
            ),
        requestId,
        conversationKey: session.id,
        temperature: session.temperature,
        thinkingMode: session.thinkingMode as "off" | "enabled" | "adaptive",
        thinkingBudget: session.thinkingBudget,
        effort: session.effort as "minimal" | "low" | "medium" | "high" | "max" | null,
        cacheTtl: session.cacheTtl as "off" | "5m" | "1h",
        speed: requestedSpeed,
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
          // Never silently override a user-facing setting: fast was asked for
          // but the provider did not confirm it (older sidecar, tier withdrawn
          // upstream, or a direct-API downgrade). The turn is recorded at the
          // speed that actually ran and the user is told why the badge is absent.
          if (requestedSpeed === "fast" && usage.speed !== "fast") {
            recordSystemEvent({
              userId, source: "fast_mode", severity: "info", campaignId: campaign?.id ?? null, sessionId,
              message: `fast mode was requested on ${model.id} but the provider ran ${usage.speed === "standard" ? "at standard speed" : "without reporting a speed"} — the turn is recorded as standard${model.provider === "codex-bridge" ? " (the Codex sidecar must advertise the fast tier for this model)" : ""}`,
            });
          }
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
        const stoppedSanitized = stripSpotlightMarkers(stoppedStripped.content);
        const stoppedParsed = isCampaignSession ? parseSceneBlock(stoppedSanitized) : { cleanContent: stoppedSanitized, sceneState: null };
        // A user-stopped turn can still carry a fully-formed [SCENE] block that
        // streamed before the stop — persist it so scene state advances and the
        // next turn's carry-forward/retrieval don't run against a stale scene.
        const stoppedSceneJson = this.persistSceneStateFromTurn(userId, sessionId, campaign, stoppedParsed.sceneState, plan.kind !== "append");
        // Continue + Stop with NOTHING streamed leaves the target row exactly as
        // it was — buildAssistantMessage would otherwise replace the original
        // prose with "*[Stopped before response began]*".
        if (plan.kind === "continue" && !stoppedParsed.cleanContent.trim() && !assistantThinking.trim()) {
          if (options?.isClientConnected?.() !== false) {
            const untouched = this.messages.findById(userId, sessionId, plan.targetMessageId);
            if (untouched) emit({ type: "response.completed", message: this.messageRowToStreamMessage(userId, sessionId, untouched), usage });
          }
          return;
        }
        // Continue MERGES the stopped fragment onto the prior prose, exactly as
        // the success path does — the bare fragment used to overwrite the row.
        const stoppedMerged = plan.kind === "continue"
          ? this.mergeContinuationFragment(plan, { content: stoppedParsed.cleanContent, thinking: assistantThinking, sceneDataJson: stoppedSceneJson })
          : null;
        const stoppedMessage = this.buildAssistantMessage({
          assistantText: stoppedMerged ? stoppedMerged.content : stoppedParsed.cleanContent,
          assistantThinking: stoppedMerged ? stoppedMerged.thinking : assistantThinking,
          modelId: model.id,
          sessionId,
          sortOrder: assistantSortOrder,
          usage,
          stopped: true,
          sceneData: stoppedMerged ? stoppedMerged.sceneData : stoppedSceneJson,
          // Helper calls that ran before the Stop are still paid for.
          overhead: overheadEntries.length ? overheadEntries : null,
          fastMode: usage.speed === "fast",
          servedModel,
        });
        this.persistTurnForPlan(userId, sessionId, plan, stoppedMessage, usage);
        if (campaign && this.beatsRepo && stoppedParsed.cleanContent.trim()) this.beatsRepo.markMessagePlayed(campaign.id, sourceUserMessageId);
        // A turn stopped before the composer emitted no context and stores none;
        // one stopped mid-stream delivered its context to the composer, and the
        // partial reply keeps it like any other persisted reply.
        const stoppedSnapshot = this.saveContextSnapshot(userId, sessionId, campaign?.id ?? null, plan.kind === "continue" ? plan.targetMessageId : stoppedMessage.id, contextSnapshotPayload, model.id);
        if (options?.isClientConnected?.() !== false) emit({ type: "response.completed", message: withSnapshotFlag(this.decorateVariantMessage(userId, sessionId, stoppedMessage, plan), stoppedSnapshot), usage });
        return;
      }
      // Provider error mid-stream: the accumulated prose used to be DISCARDED —
      // the user turn was persisted with no reply and the streamed text vanished
      // on reload. Persist the partial prose with an interrupted marker (the
      // runtime-history sanitizer strips that marker) plus whatever usage and
      // scene state we captured, then surface the error.
      const errReason = error instanceof Error ? error.message : "provider request failed";
      const errStripped = extractInlineThinking(assistantText);
      if (errStripped.thinking) assistantThinking = assistantThinking ? assistantThinking + "\n" + errStripped.thinking : errStripped.thinking;
      const errSanitized = stripSpotlightMarkers(errStripped.content);
      const errParsed = isCampaignSession ? parseSceneBlock(errSanitized) : { cleanContent: errSanitized, sceneState: null };
      const errFragment = errParsed.cleanContent.trim();
      // Continue merges onto the target row, so an empty fragment
      // leaves it untouched; append/variant still persist a thinking-only
      // reply as a marker row.
      const persistPartial = plan.kind === "continue" ? Boolean(errFragment) : Boolean(errFragment || assistantThinking);
      if (persistPartial) {
        const errSceneJson = this.persistSceneStateFromTurn(userId, sessionId, campaign, errParsed.sceneState, plan.kind !== "append");
        const errMerged = plan.kind === "continue"
          ? this.mergeContinuationFragment(plan, { content: errParsed.cleanContent, thinking: assistantThinking, sceneDataJson: errSceneJson })
          : null;
        const interruptedContent = errFragment
          ? `${errMerged ? errMerged.content : errFragment}\n\n---\n\n*[Stream interrupted: ${errReason}]*`
          : "*[Response contained only thinking]*";
        const errMessage = this.buildAssistantMessage({
          assistantText: interruptedContent,
          assistantThinking: errMerged ? errMerged.thinking : assistantThinking,
          modelId: model.id,
          sessionId,
          sortOrder: assistantSortOrder,
          usage,
          sceneData: errMerged ? errMerged.sceneData : errSceneJson,
          // Helper calls that ran before the provider error are still paid for.
          overhead: overheadEntries.length ? overheadEntries : null,
          fastMode: usage.speed === "fast",
          servedModel,
          stopReason,
          stopDetails,
        });
        this.persistTurnForPlan(userId, sessionId, plan, errMessage, usage);
        if (campaign && this.beatsRepo && errParsed.cleanContent.trim()) this.beatsRepo.markMessagePlayed(campaign.id, sourceUserMessageId);
        this.saveContextSnapshot(userId, sessionId, campaign?.id ?? null, plan.kind === "continue" ? plan.targetMessageId : errMessage.id, contextSnapshotPayload, model.id);
      }
      if (options?.isClientConnected?.() !== false) {
        emit({ type: "response.error", error: errReason });
      }
      return;
    }

    // Strip inline thinking tags (DeepSeek V3 Pro, z.ai, etc. embed <thinking>/<think> in content)
    const { thinking: inlineThinking, content: strippedText } = extractInlineThinking(assistantText);
    if (inlineThinking) assistantThinking = assistantThinking ? assistantThinking + "\n" + inlineThinking : inlineThinking;

    // Parse scene block from assistant response (campaign sessions only). Strip
    // any spotlight markers the model mimicked from history first (Living World).
    const sanitizedText = stripSpotlightMarkers(strippedText);
    const { cleanContent, sceneState } = isCampaignSession ? parseSceneBlock(sanitizedText) : { cleanContent: sanitizedText, sceneState: null };
    const sceneDataJson = this.persistSceneStateFromTurn(userId, sessionId, campaign, sceneState, plan.kind !== "append");

    // Continue (max_tokens) MERGES the continuation onto the existing message in
    // place — see mergeContinuationFragment (shared with the stop/error paths).
    const merged = plan.kind === "continue"
      ? this.mergeContinuationFragment(plan, { content: cleanContent, thinking: assistantThinking, sceneDataJson })
      : null;
    const assistantMessage = this.buildAssistantMessage({
      assistantText: merged ? merged.content : cleanContent,
      assistantThinking: merged ? merged.thinking : assistantThinking,
      modelId: model.id,
      sessionId,
      sortOrder: assistantSortOrder,
      usage,
      outputTruncated,
      maxOutputTokens: model.maxOut,
      sceneData: merged ? merged.sceneData : sceneDataJson,
      overhead: overheadEntries.length ? overheadEntries : null,
      stopReason,
      stopDetails,
      fastMode: usage.speed === "fast",
      servedModel,
    });
    // Continue updates the original row in place — its persisted id is the target,
    // not the freshly-minted buildAssistantMessage id.
    const persistedMessageId = plan.kind === "continue" ? plan.targetMessageId : assistantMessage.id;
    const runPostPersistFollowups = async () => {
      if (isCampaignSession && campaign && this.beatsRepo && cleanContent.trim()) {
        this.beatsRepo.markMessagePlayed(campaign.id, sourceUserMessageId);
      }

      if (isCampaignSession && campaign && sceneState && this.contextEngine) {
        try {
          const settings = this.contextEngine.resolveSettings({ contextOverridesJson: (session as any).contextOverridesJson });
          if (settings.sceneValidatorEnabled) {
            await this.runSceneValidatorTurn({
              userId,
              sessionId,
              campaignId: campaign.id,
              messageId: persistedMessageId,
              runtime,
              modelId: settings.sceneValidatorModel,
              openaiFastMode: settings.openaiFastModeEnabled,
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
      // Continue merges in place, so a disconnect just persists the merged row
      // directly (there is no fresh-message pending shape for an in-place update).
      if (plan.kind === "continue") {
        this.persistTurnForPlan(userId, sessionId, plan, assistantMessage, usage, true);
        this.saveContextSnapshot(userId, sessionId, campaign?.id ?? null, plan.targetMessageId, contextSnapshotPayload, model.id);
      } else {
        // A fresh or regenerated reply recovered through pending_assistant_messages
        // has no messages row yet, so it gets no snapshot: the snapshot
        // table's foreign key needs the row, and the Preview was never shown.
        // A reply for a turn the transcript has moved past never becomes a
        // pending row: the source turn was edited while this reply
        // was generating, or (fresh replies) it already has an answer or newer
        // turns follow it. Nothing is persisted; the finally releases this
        // turn's beat claims, and the session's scene pointer — advanced by
        // persistSceneStateFromTurn for THIS reply — goes back to the active tail.
        const staleReason = this.recoveredReplyStaleReason({
          userId, sessionId, sourceUserMessageId,
          sourceContentAtStart: conversation.find((m) => m.id === sourceUserMessageId)?.content ?? null,
          createdAt: null,
          freshReply: plan.kind === "append",
        });
        if (staleReason) {
          recordSystemEvent({
            userId, sessionId, source: "context_assembly", severity: "info",
            message: `Recovered reply was discarded because ${staleReason}.`,
            details: { messageId: assistantMessage.id, sourceUserMessageId, plan: plan.kind },
          });
          this.reconcileSessionStateForActiveTail(userId, sessionId);
          return;
        }
        this.pending.createPendingMessage({
          id: assistantMessage.id,
          sessionId,
          userId,
          sourceUserMessageId,
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
          // Carry the variant group through so the merge re-attaches the recovered
          // reply as an INACTIVE sibling — never yanking the active variant.
          variantGroupId: plan.kind === "variant" ? plan.variantGroupId : null,
          createdAt: assistantMessage.createdAt,
          updatedAt: assistantMessage.updatedAt,
        });
        // persistSceneStateFromTurn already advanced sessions.scene* to THIS
        // reply's scene — but a recovered regenerate merges as an INACTIVE
        // sibling, so the visible transcript keeps the old active reply while
        // retrieval/agendas/attire/validator would have run against the hidden
        // one's location and cast. Point the session back at the
        // active tail, as the connected path does after its flip.
        if (plan.kind === "variant") this.reconcileSessionStateForActiveTail(userId, sessionId);
      }
      // Scene validation/beat claims remain completion-scoped. Canon ingestion
      // waits until this recovered reply is kept across a later user append.
      await runPostPersistFollowups();
      return;
    }

    this.persistTurnForPlan(userId, sessionId, plan, assistantMessage, usage, true);
    // The reply's context snapshot; a continue overwrites its target's.
    const snapshotStored = this.saveContextSnapshot(userId, sessionId, campaign?.id ?? null, persistedMessageId, contextSnapshotPayload, model.id);
    emit({ type: "response.completed", message: withSnapshotFlag(this.decorateVariantMessage(userId, sessionId, assistantMessage, plan), snapshotStored), usage });
    await runPostPersistFollowups();
    } finally {
      // A claim is only consumed when visible assistant prose was persisted.
      // Any exception, empty response, or immediate stop releases the beat so a
      // later turn can still fire it. Played/replayed beats are unaffected.
      if (campaign && this.beatsRepo) this.beatsRepo.releaseMessageClaims(campaign.id, sourceUserMessageId);
      this.activeRequests.delete(`${userId}:${requestId}`);
      // Nothing of this turn outlives it: a turn that threw while an
      // overlapped phase was still in flight cancels that call. Every await of
      // the turn has settled here, so a normal turn aborts nothing live.
      if (!abortController.signal.aborted) abortController.abort();
    }
  }

  /**
   * Store a turn's response.context payload against the reply that persisted,
   * through buildMessageContextSnapshot (every included
   * row, the 40 highest-scoring dropped rows, the notes, the composer model).
   * The repository keeps each session's newest 50. A failed write is recorded
   * as a warn event and never fails the turn. Returns whether it was stored.
   */
  private saveContextSnapshot(userId: string, sessionId: string, campaignId: string | null, replyId: string, payload: ContextSnapshotPayload | null, modelId: string): boolean {
    if (!payload || !this.contextSnapshots) return false;
    try {
      this.contextSnapshots.save(userId, sessionId, replyId, buildMessageContextSnapshot({ ...payload, modelId }));
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      chatLogger.warn({ err, sessionId, replyId }, "context snapshot not stored (non-fatal)");
      recordSystemEvent({
        userId, source: "context_assembly", severity: "warn", campaignId, sessionId,
        message: `the context snapshot of reply ${replyId.slice(0, 8)} was not stored; the reply itself is saved: ${reason}`,
        details: { messageId: replyId },
      });
      return false;
    }
  }

  stopResponse(userId: string, sessionId: string, requestId: string) {
    this.requireUser(userId);
    // Look for the running turn BEFORE requiring an active session: a
    // session soft-deleted mid-turn keeps its generation running, and Stop
    // answered 404 — the only end to a long max-effort turn was the runtime's
    // ceiling. Each entry carries the owner and session ids, so this check is
    // exactly as scoped as requireSession; the 404 still applies when nothing
    // is running for a missing or deleted session.
    const active = this.activeRequests.get(`${userId}:${requestId}`);
    if (active && active.userId === userId && active.sessionId === sessionId) {
      active.markStopped();
      active.abortController.abort();
      return true;
    }
    // A stale or unknown id. The
    // fallback exists for a proxy that rewrites x-request-id (efdfda82); it used
    // to abort whichever of the session's requests came first, so with two
    // streams in one session (the limit is per user) a stale Stop could end the
    // wrong one. It now acts only when the choice is unambiguous: exactly one
    // active request for this user and session. With two or more nothing is
    // stopped and the answer is `stopped: false` (both clients handle it).
    const candidates = [...this.activeRequests.entries()].filter(([, req]) => req.userId === userId && req.sessionId === sessionId);
    if (candidates.length === 1) {
      const [key, req] = candidates[0]!;
      chatLogger.warn({ sessionId, requestId, activeRequestId: key.slice(userId.length + 1) }, "stop named an unknown request id; stopped the session's only active request");
      req.markStopped();
      req.abortController.abort();
      return true;
    }
    if (candidates.length > 1) {
      chatLogger.warn({ sessionId, requestId, activeRequestIds: candidates.map(([key]) => key.slice(userId.length + 1)) }, "stop named an unknown request id while several requests run in the session; nothing stopped");
      return false;
    }
    this.requireSession(userId, sessionId);
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

  private deleteMessageArtifacts(userId: string, sessionId: string, messageIds: string[]) {
    if (!messageIds.length) return;
    const images = this.generatedImages.listForMessageIds(userId, sessionId, messageIds);
    for (const image of images) this.imageStore.delete(image.id, image.mimeType);
    this.generatedImages.deleteForMessageIds(userId, sessionId, messageIds);
    this.attachments.deleteForMessageIds(userId, sessionId, messageIds);
  }

  /**
   * Why a recovered (disconnect-time) reply must NOT land, or null when it may.
   * A pending row is a reply generated for the source
   * user turn AS IT WAS when the turn started, meant for the slot right after
   * it. It is stale when:
   *   - the source turn's content changed since the reply was generated — an
   *     edit DURING the generation is caught at disconnect time against the
   *     turn-start content; an edit AFTER the row was written is caught at merge
   *     time by the source's `updatedAt` being newer than the row's `createdAt`;
   *   - for a fresh reply (append plan), the conversation moved on: another
   *     reply already answers the source turn, or a newer user turn follows it.
   *     A generated-image row in between is not "moving on" (a connected turn
   *     would have landed after it too). A recovered REGENERATE is an inactive
   *     sibling of its group and keeps the merge's group guard instead.
   * Before this the only test was "does the source user id still exist", so an
   * SSE drop followed by edit-and-regenerate showed `U(edited) → A(new) →
   * A(old)` with the stale reply as the live tail.
   */
  private recoveredReplyStaleReason(input: {
    userId: string;
    sessionId: string;
    sourceUserMessageId: string;
    sourceContentAtStart: string | null;
    createdAt: string | null;
    freshReply: boolean;
  }): string | null {
    const source = this.messages.findById(input.userId, input.sessionId, input.sourceUserMessageId);
    if (!source) return "its source user turn was deleted";
    if (input.sourceContentAtStart != null && source.content !== input.sourceContentAtStart) return "its source user turn was edited while the reply was generating";
    if (input.createdAt != null && source.updatedAt > input.createdAt) return "its source user turn was edited after the reply was generated";
    if (input.freshReply) {
      const later = this.messages.listAfterSortOrder(input.userId, input.sessionId, source.sortOrder)
        .filter((row) => row.variantActive && (row.role === "user" || row.sourceUserMessageId != null));
      if (later.some((row) => row.role === "user")) return "newer turns were appended before it could land";
      if (later.length > 0) return "another reply already answers its source turn";
    }
    return null;
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
        // Stale since the disconnect: edited source, or a fresh reply
        // whose slot is no longer the tail. Discard, and say so.
        const staleReason = this.recoveredReplyStaleReason({
          userId, sessionId, sourceUserMessageId: message.sourceUserMessageId,
          sourceContentAtStart: null, createdAt: message.createdAt, freshReply: !message.variantGroupId,
        });
        if (staleReason) {
          this.pending.deletePendingMessage(userId, sessionId, message.id);
          recordSystemEvent({
            userId, sessionId, source: "context_assembly", severity: "info",
            message: `Recovered reply was discarded because ${staleReason}.`,
            details: { messageId: message.id, sourceUserMessageId: message.sourceUserMessageId, variantGroupId: message.variantGroupId ?? null },
          });
          continue;
        }
        if (!existingIds.has(message.id)) {
          const common = {
            id: message.id,
            sourceUserMessageId: message.sourceUserMessageId,
            ingestionEligible: true,
            sessionId,
            userId,
            role: "assistant" as const,
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
            stopReason: message.stopReason ?? null,
            stopDetailsJson: message.stopDetailsJson ?? null,
            fastMode: message.fastMode,
            servedModel: message.servedModel ?? null,
            sceneData: message.sceneData ?? null,
            overheadJson: message.overheadJson ?? null,
          };
          // 0066: a recovered REGENERATE lands as an INACTIVE sibling of its
          // group at the group's shared sort_order — never yanking the active
          // variant the user may already have switched to. The group's slot
          // sort_order is the sort_order any existing member already occupies.
          if (message.variantGroupId) {
            const groupMembers = this.messages.listVariantGroup(userId, sessionId, message.variantGroupId);
            if (!groupMembers.length) {
              this.pending.deletePendingMessage(userId, sessionId, message.id);
              recordSystemEvent({ userId, sessionId, source: "context_assembly", severity: "info", message: "Recovered regeneration was discarded because its reply group was deleted while it was generating.", details: { messageId: message.id, variantGroupId: message.variantGroupId } });
              continue;
            }
            this.messages.createSiblingVariant({ ...common, variantGroupId: message.variantGroupId, variantActive: false }, groupMembers[0]!.sortOrder);
            // Deferred variant scene writes must wait for the same surviving
            // group guard as its recovered row. Preserve the active tail after
            // incorporating the recovered cast into the campaign roster.
            if (message.sceneData) {
              const campaignId = this.sessions.findById(userId, sessionId)?.campaignId;
              this.persistSceneStateFromTurn(userId, sessionId,
                campaignId ? this.campaigns.findById(userId, campaignId) : null,
                deserializeSceneData(message.sceneData));
              this.reconcileSessionStateForActiveTail(userId, sessionId);
            }
          } else {
            this.messages.createMessageAtTail(common);
          }
        }
        this.pending.deletePendingMessage(userId, sessionId, message.id);
        // Keep updatedAt monotonic — the disconnect-time stamp used to move
        // the session's recency BACKWARDS in the sidebar. lastMessageAt too:
        // a recovered row older than the current tail must not step
        // the session's last-message time back.
        const currentLast = this.sessions.findById(userId, sessionId)?.lastMessageAt ?? null;
        this.sessions.updateSession(userId, sessionId, {
          messageCount: this.messages.countForSession(userId, sessionId),
          updatedAt: new Date().toISOString(),
          lastMessageAt: currentLast && currentLast > message.createdAt ? currentLast : message.createdAt,
        });
      }
    });
  }

  // Persist a parsed scene state from an assistant turn: refresh roster, compute
  // NOT PRESENT, advance session-level scene state, and return the serialized
  // sceneData JSON (or null when there's no scene / no campaign). Shared by the
  // success, stopped, and provider-error paths so a [SCENE] block that streamed
  // before an interruption still advances scene state.
  private persistSceneStateFromTurn(
    userId: string,
    sessionId: string,
    campaign: { id: string; characterRoster?: string | null } | null | undefined,
    sceneState: SceneState | null,
    deferWrites = false,
  ): string | null {
    if (!sceneState || !campaign) return null;
    // Re-fetch roster from DB (not the stale campaign object) to pick up any
    // session-start reset that happened earlier in this request.
    const freshCampaign = this.campaigns.findById(userId, campaign.id);
    const currentRoster: string[] = safeParseJson<string[]>(freshCampaign?.characterRoster || campaign.characterRoster || "[]", []);
    const updatedRoster = updateCharacterRoster(currentRoster, sceneState);
    const notPresent = computeNotPresent(updatedRoster ?? currentRoster, sceneState);
    const sceneDataJson = serializeSceneData(sceneState, notPresent);
    if (deferWrites) return sceneDataJson;
    if (updatedRoster) {
      this.campaigns.updateCampaign(userId, campaign.id, { characterRoster: JSON.stringify(updatedRoster), updatedAt: new Date().toISOString() });
    }
    this.sessions.updateSession(userId, sessionId, {
      sceneLocation: sceneState.location,
      scenePresent: JSON.stringify(sceneState.present),
      scenePresentUnaware: JSON.stringify(sceneState.presentUnaware),
      updatedAt: new Date().toISOString(),
    });
    return sceneDataJson;
  }

  private persistAssistantMessage(
    userId: string,
    sessionId: string,
    assistantMessage: ReturnType<ChatService["buildAssistantMessage"]>,
    usage: ChatUsage,
    sourceUserMessageId?: string,
    ingestionEligible = false,
  ) {
    assistantMessage.sortOrder = this.messages.createMessageAtTail({
      id: assistantMessage.id,
      sourceUserMessageId,
      ingestionEligible,
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

  // Persist a generated assistant turn according to the variant plan:
  //   append   — tail-insert a singleton (the historic path).
  //   variant  — insert a sibling sharing the slot's sort_order, then flip active.
  //   continue — UPDATE the target message in place (max_tokens continuation).
  private persistTurnForPlan(
    userId: string,
    sessionId: string,
    plan: AssistantTurnPlan,
    assistantMessage: ReturnType<ChatService["buildAssistantMessage"]>,
    usage: ChatUsage,
    ingestionEligible = false,
  ) {
    if (plan.kind === "continue") {
      // ACCUMULATE onto the target, never replace: to the reader and the
      // cost strip the row is ONE turn, so its usage is the original call plus
      // every continuation, and the overhead trail concatenates. The model /
      // served-model / fast-mode stamps stay the ORIGINAL call's (the bulk of the
      // prose; a continuation run on another model is priced under the row's
      // model — a bounded approximation, never a zeroed original). stop_reason /
      // stop_details reflect the LATEST call: that is the row's current state.
      this.messages.transact(() => {
        const target = this.messages.findById(userId, sessionId, plan.targetMessageId);
        if (!target?.variantActive || target.content !== plan.expectedContent) throw new HttpError(409, "Reply changed while continuation was generating. Reload before continuing.");
        // Continue scene/roster writes share the content CAS transaction. A late
        // fragment cannot advance campaign presence after its reply was edited.
        if (assistantMessage.sceneData) {
          const campaignId = this.sessions.findById(userId, sessionId)?.campaignId;
          assistantMessage.sceneData = this.persistSceneStateFromTurn(userId, sessionId,
            campaignId ? this.campaigns.findById(userId, campaignId) : null,
            deserializeSceneData(assistantMessage.sceneData));
        }
        const priorOverhead = target?.overheadJson
          ? safeParseJson<Array<{ source: string; modelId: string; inputTokens: number; outputTokens: number }>>(target.overheadJson, [])
          : [];
        const overhead = [...priorOverhead, ...(assistantMessage.overhead ?? [])];
        this.messages.updateMessage(userId, sessionId, plan.targetMessageId, {
          content: assistantMessage.content,
          ingestionEligible,
          thinking: assistantMessage.thinking,
          modelId: target?.modelId ?? assistantMessage.modelId,
          sceneData: assistantMessage.sceneData,
          overheadJson: overhead.length ? JSON.stringify(overhead) : null,
          stopReason: assistantMessage.stopReason ?? null,
          stopDetailsJson: assistantMessage.stopDetails ? JSON.stringify(assistantMessage.stopDetails) : null,
          fastMode: target ? target.fastMode : (assistantMessage.fastMode ?? false),
          servedModel: target?.servedModel ?? assistantMessage.servedModel ?? null,
          inputTokens: sumTokens(target?.inputTokens, usage.inputTokens),
          outputTokens: sumTokens(target?.outputTokens, usage.outputTokens),
          totalTokens: sumTokens(target?.totalTokens, usage.totalTokens),
          cacheReadTokens: sumTokens(target?.cacheReadTokens, usage.cacheReadTokens),
          cacheWriteTokens: sumTokens(target?.cacheWriteTokens, usage.cacheWriteTokens),
          reasoningTokens: sumTokens(target?.reasoningTokens, usage.reasoningTokens),
          updatedAt: assistantMessage.updatedAt,
        });
        this.sessions.updateSession(userId, sessionId, {
          updatedAt: assistantMessage.updatedAt,
          lastMessageAt: target?.createdAt ?? assistantMessage.createdAt,
        });
      });
      this.reconcileSessionStateForActiveTail(userId, sessionId);
      return;
    }
    if (plan.kind === "variant") {
      // Insert INACTIVE, then flip — inside one transaction. The target is still
      // the slot's active row when the sibling lands, and the 0067 partial unique
      // index (session_id, sort_order) WHERE variant_active = 1 rejected an
      // active-first insert outright: every regenerate ended in response.error
      // with nothing persisted (the pending-merge path always used this order).
      this.messages.transact(() => {
        if (!this.messages.listVariantGroup(userId, sessionId, plan.variantGroupId).length) {
          throw new HttpError(409, "Reply group was deleted while regeneration was generating. Reload before regenerating.");
        }
        if (assistantMessage.sceneData) {
          const campaignId = this.sessions.findById(userId, sessionId)?.campaignId;
          assistantMessage.sceneData = this.persistSceneStateFromTurn(userId, sessionId,
            campaignId ? this.campaigns.findById(userId, campaignId) : null,
            deserializeSceneData(assistantMessage.sceneData));
        }
        this.messages.createSiblingVariant({
          id: assistantMessage.id,
          sourceUserMessageId: plan.sourceUserMessageId,
          ingestionEligible,
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
          variantGroupId: plan.variantGroupId,
          variantActive: false,
          createdAt: assistantMessage.createdAt,
          updatedAt: assistantMessage.updatedAt,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens,
        }, plan.assistantSortOrder);
        // Flip this new sibling active (clears the prior active member atomically).
        this.messages.setActiveVariant(userId, sessionId, plan.variantGroupId, assistantMessage.id);
      });
      this.sessions.updateSession(userId, sessionId, {
        messageCount: this.messages.countForSession(userId, sessionId),
        updatedAt: assistantMessage.updatedAt,
        lastMessageAt: assistantMessage.createdAt,
      });
      this.reconcileSessionStateForActiveTail(userId, sessionId);
      return;
    }
    this.persistAssistantMessage(userId, sessionId, assistantMessage, usage, plan.sourceUserMessageId, ingestionEligible);
  }

  // Continue (max_tokens) MERGES a streamed fragment onto the target message:
  // the prior prose is the head, the fragment is appended, thinking concatenates,
  // and scene data is preserved from the original unless the fragment re-emitted
  // one. Shared by the success, stopped and provider-error paths — the two
  // failure paths used to persist the bare fragment OVER the original row
  // (Continue + Stop on Android destroyed the reply).
  private mergeContinuationFragment(
    plan: Extract<AssistantTurnPlan, { kind: "continue" }>,
    fragment: { content: string; thinking: string; sceneDataJson: string | null },
  ): { content: string; thinking: string; sceneData: string | null } {
    // No joiner when the prior is empty (a stopped-before-stream
    // placeholder continues from nothing), so the fragment is the whole reply.
    const prior = plan.priorContent.trimEnd();
    return {
      content: prior + (fragment.content.trim() ? (prior ? " " : "") + fragment.content.trimStart() : ""),
      thinking: [plan.priorThinking, fragment.thinking].filter(Boolean).join("\n"),
      sceneData: fragment.sceneDataJson ?? plan.priorSceneData,
    };
  }

  /** Reply N becomes canon only when a fresh user turn keeps it. Missed work
   * retries at the next append, while receipts prevent historical variants from
   * becoming novel events. Every await precedes the exact-source transaction. */
  private async ingestSettledReplies(
    userId: string, sessionId: string, appendedUserMessageId: string,
    campaign: { id: string; characterRoster?: string | null },
    session: ReturnType<ChatService["requireSession"]>, signal: AbortSignal,
  ): Promise<void> {
    if (!this.contextEngine) return;
    const settings = this.contextEngine.resolveSettings({ contextOverridesJson: session.contextOverridesJson });
    for (const candidate of this.messages.listUnsettledAssistantSources(userId, sessionId, appendedUserMessageId)) {
      if (signal.aborted) return;
      try {
        const writeWorld = await this.prepareWorldStateWrites({
          userId, campaign, sessionId, session, assistantTurn: candidate.assistant.content,
          userTurn: candidate.userTurn, messageId: candidate.assistant.id,
          roster: safeParseJson<string[]>(campaign.characterRoster ?? "[]", []), signal,
        });
        if (signal.aborted) return;
        if (!writeWorld) break;
        const committed = this.messages.commitSettledAssistant(userId, candidate.source, () => {
          writeWorld();
          this.pipelineQueue?.evaluateAndEnqueue(userId, campaign.id, sessionId, candidate.assistant.content.length, settings, candidate.source);
        });
        if (!committed && !this.messages.hasSettledAssistantIngestion(userId, sessionId, candidate.source.sourceUserMessageId)) {
          // A changed source must be reconsidered before any later exchange.
          // An overlapping extractor that already committed this logical turn
          // is harmless and may proceed to the following backlog candidate.
          recordSystemEvent({ userId, source: "world_state", severity: "info", campaignId: campaign.id, sessionId,
            message: "kept reply changed during ingestion; remaining work will retry on the next user append", details: { messageId: candidate.source.messageId } });
          break;
        }
      } catch (err) {
        if (signal.aborted) return;
        recordSystemEvent({ userId, source: "world_state", severity: "warn", campaignId: campaign.id, sessionId,
          message: `settled reply ingestion failed; it will retry on the next user append: ${err instanceof Error ? err.message : String(err)}`,
          details: { messageId: candidate.source.messageId },
        });
        break;
      }
    }
  }

  /**
   * Stage phase-7 state from the kept reply. All model work finishes before
   * the caller checks the exact source and commits these writes with its receipt.
   *
   * Ordering matters. Consequences go first, because they are the expensive class
   * and the one the owner feels (a death that a swipe can undo). Threats second,
   * so the fuse that Threat Follow-Through instructs in prose actually exists in
   * code. Grudges last, since they are cheap and self-correcting.
   *
   * Everything here is REVERSIBLE and reported: rows carry message provenance, the
   * owner can dismiss any of them, and the per-turn info note says what is in
   * force. That reversibility is what licenses auto-apply instead of an approval
   * queue — the same trade the audit makes.
   */
  private async prepareWorldStateWrites(input: {
    userId: string;
    campaign: { id: string };
    sessionId: string;
    session: { contextOverridesJson?: string | null; scenePresent?: string | null };
    assistantTurn: string;
    userTurn: string;
    messageId: string | null;
    roster: string[];
    signal?: AbortSignal;
  }): Promise<(() => void) | null> {
    if (!this.adversarialWorld || !this.contextEngine) return () => {};
    const settings = this.contextEngine.resolveSettings({ contextOverridesJson: input.session.contextOverridesJson });
    const stance = settings.worldStance ?? 1;
    // Same gate as every consumer: a campaign at the shipped default writes
    // nothing, so the inert promise holds for the six campaigns that never dialled.
    if (!settings.worldStateExtractionEnabled || stance < 2) return () => {};

    const modelId = settings.worldStateModel?.trim() || settings.driveModel;
    // The extractor may only name characters it was given; the roster plus anyone
    // holding a drive sheet is the whole legitimate cast.
    const cast = Array.from(new Set([
      ...input.roster,
      ...(this.drivesRepo?.listForCampaign(input.campaign.id).map((d) => d.characterName) ?? []),
    ].map((n) => n.trim()).filter(Boolean)));
    if (cast.length === 0) return () => {};

    const runtime = this.runtimeForUser(input.userId);
    const armedBefore = this.adversarialWorld.listArmedThreats(input.campaign.id);
    const extraction = await extractWorldState({
      runtime,
      modelId,
      // Canon writer: OOC planning text never enters the threat/consequence/
      // grudge tables as events (see stripOoc.ts).
      userTurn: stripOocBlocks(input.userTurn),
      assistantTurn: input.assistantTurn,
      cast,
      // Given the open fuses so it can CLOSE them. Without this an honoured threat
      // still counts down to "expired" and the world nags about follow-through that
      // already happened.
      armedThreats: armedBefore.map((t) => ({ id: t.id, sourceCharacter: t.sourceCharacter, target: t.target, statedAct: t.statedAct })),
      // Honours the visible Engine → Pipeline dial rather than hardcoding a tier —
      // the no-silent-reasoning-tiers rule.
      workerEffort: settings.workerEffort,
      openaiFastMode: settings.openaiFastModeEnabled,
      requestId: `world-extract-${input.sessionId}`,
      signal: input.signal,
    });
    if (input.signal?.aborted) return null;

    if (extraction.failure) {
      // No-silent-failures: without this the producers could stop working and the
      // only symptom would be a world that quietly stopped having consequences.
      recordSystemEvent({
        userId: input.userId, source: "world_state", severity: "warn",
        campaignId: input.campaign.id, sessionId: input.sessionId,
        message: `world-state extraction failed on ${modelId}: ${extraction.failure} — no threats, consequences or standings were recorded; this turn and its backlog will retry on the next user append`,
      });
      return null;
    }

    const playerKeys = settings.playerCharacterKeys ?? [];

    // ── Consequences ────────────────────────────────────────────────────────
    const verifiedConsequences: typeof extraction.consequences = [];
    for (const candidate of extraction.consequences) {
      if (candidate.kind === "death") {
        const verdict = await refuteDeath({
          runtime, modelId,
          subject: candidate.subject,
          detail: candidate.detail,
          passage: input.assistantTurn,
          workerEffort: settings.workerEffort,
          openaiFastMode: settings.openaiFastModeEnabled,
          requestId: `death-refute-${input.sessionId}`,
          signal: input.signal,
        });
        if (verdict.refuted) {
          chatLogger.info(
            { campaignId: input.campaign.id, subject: candidate.subject, reason: verdict.reason },
            "world-state: death claim refuted, not recorded",
          );
          continue;
        }
      }
      if (input.signal?.aborted) return null;
      verifiedConsequences.push(candidate);
    }
    const world = this.adversarialWorld;
    return () => {
      const existingConsequences = new Set(world.listConsequences(input.campaign.id, null)
        .map(row => consequenceFingerprint(row.kind, row.subject, row.detail)));
      for (const candidate of verifiedConsequences) {
        if (existingConsequences.has(consequenceFingerprint(candidate.kind, candidate.subject, candidate.detail))) continue;
        const row = world.recordConsequence({
          campaignId: input.campaign.id,
          sessionId: input.sessionId,
          kind: candidate.kind,
          subject: candidate.subject,
          detail: candidate.detail,
          messageId: input.messageId,
          worldStance: stance,
        });
        if (row) {
          existingConsequences.add(consequenceFingerprint(row.kind, row.subject, row.detail));
          chatLogger.info(
            { campaignId: input.campaign.id, kind: row.kind, subject: row.subject },
            "world-state: consequence recorded — this now holds across regeneration",
          );
        }
      }

      // ── Threat outcomes: close fuses the turn settled ───────────────────────
      // Runs BEFORE new threats are armed, so a character who followed through on an
      // old threat and made a fresh one in the same turn gets both handled.
      for (const settled of extraction.threatOutcomes) {
        const match = armedBefore.find((row) => row.id === settled.threatId && row.sourceCharacter.toLocaleLowerCase() === settled.source.toLocaleLowerCase());
        if (!match || !world.listArmedThreats(input.campaign.id).some(current => current.id === match.id && current.sourceCharacter === match.sourceCharacter && current.target === match.target && current.statedAct === match.statedAct)) continue;
        world.resolveThreat(match.id, settled.outcome, settled.note);
        chatLogger.info(
          { campaignId: input.campaign.id, source: match.sourceCharacter, outcome: settled.outcome },
          "world-state: threat fuse resolved",
        );
      }

      // ── Threats ─────────────────────────────────────────────────────────────
      const armed = new Set(
        world.listArmedThreats(input.campaign.id)
          .map((row) => threatFingerprint(row.sourceCharacter, row.target, row.statedAct)),
      );
      for (const threat of extraction.threats) {
        // A threat BY the player character is not a fuse the world owes: the fuse
        // measures an NPC's commitment to follow through.
        if (isPlayerCharacter(threat.source, playerKeys)) continue;
        const print = threatFingerprint(threat.source, threat.target, threat.act);
        if (armed.has(print)) continue;
        const row = world.registerThreat({
          campaignId: input.campaign.id,
          sessionId: input.sessionId,
          sourceCharacter: threat.source,
          target: threat.target,
          statedAct: threat.act,
          worldStance: stance,
        });
        if (row) {
          armed.add(print);
          chatLogger.info(
            { campaignId: input.campaign.id, source: row.sourceCharacter, target: row.target },
            "world-state: threat fuse armed",
          );
        }
      }

      // ── Standings (grudge only) ─────────────────────────────────────────────
      // Trust is deliberately absent. A positivity-biased reader over-detects warmth,
      // so letting it raise trust would re-import the disease through the producer.
      // Trust rises only from mechanical evidence — see adjustStanding's other caller
      // in the world tick. The logical-turn receipt makes this increment exactly
      // once even if the reader swipes or continues a historical reply later.
      for (const slight of extraction.slights) {
        if (isPlayerCharacter(slight.character, playerKeys)) continue;
        const changed = world.adjustStanding(input.campaign.id, slight.character, { grudge: slight.weight });
        if (changed === 0) {
          chatLogger.info({ campaignId: input.campaign.id, character: slight.character }, "world-state: slight against a character with no drive sheet — grudge not recorded");
        }
      }
    };
  }

  /** True when a contest's free-text opposition names the player character. The
   *  intent pass writes "<user>" when it means the protagonist, and the owner's PC
   *  keys cover the cases where it uses the name instead. */
  private opposesPlayer(opposes: string, playerKeys: string[]): boolean {
    const needle = opposes.trim().toLocaleLowerCase();
    if (!needle) return false;
    if (needle.includes("<user>") || needle.includes("user")) return true;
    return playerKeys.some((key) => {
      const k = key.trim().toLocaleLowerCase();
      return Boolean(k) && needle.includes(k);
    });
  }

  /** Match a contest's free-text opposition onto a character who has standing.
   *  Substring both ways because the classifier writes prose ("the guard captain",
   *  "Bram's men") and the roster holds bare names. Returns null when nothing
   *  matches, in which case the contest resolves on difficulty and stance alone. */
  private findStandingForOpposition(
    campaignId: string,
    opposition: string,
  ): { name: string; grudge: number; trust: number } | null {
    if (!this.adversarialWorld) return null;
    const needle = opposition.trim().toLocaleLowerCase();
    if (!needle) return null;
    let best: { name: string; grudge: number; trust: number } | null = null;
    for (const standing of this.adversarialWorld.listStandings(campaignId)) {
      const name = standing.name.trim().toLocaleLowerCase();
      if (!name) continue;
      if (needle.includes(name) || name.includes(needle)) {
        // Prefer the longest name match so "Bram Vale" wins over "Bram".
        if (!best || standing.name.length > best.name.length) best = standing;
      }
    }
    return best;
  }

  // Living World — render the per-turn <character_agendas> block for PRESENT ∪
  // PRESENT_UNAWARE characters that have drive sheets. Deterministic (not
  // retrieval-scored), capped, and terse (attire-block posture). Returns a
  // degradation note when the campaign uses drives but no one is present.
  private buildAgendaBlock(
    campaignId: string,
    session: { scenePresent?: string | null; scenePresentUnaware?: string | null },
    playerCharacterKeys: string[] = [],
  ): { block: string | null; note: string | null; count: number } {
    if (!this.drivesRepo) return { block: null, note: null, count: 0 };
    const present = safeParseJson<string[]>(session.scenePresent || "[]", []);
    const unaware = safeParseJson<string[]>(session.scenePresentUnaware || "[]", []);
    // Sanitized names: the sheets are keyed by the roster's spelling.
    const presentClean = normalizePresentNames(present);
    const unawareClean = normalizePresentNames(unaware).filter((n) => !presentClean.includes(n));
    const rawCount = presentClean.length + unawareClean.length;
    const allNow = [...presentClean, ...unawareClean].filter((name) => !isPlayerCharacter(name, playerCharacterKeys));
    if (allNow.length === 0) {
      // A campaign in active use (has sheets) with EMPTY presence lists
      // usually means scene tracking degraded — surface it, don't fail silent.
      // A scene where only the player character is present is healthy tracking
      // with nothing to inject, not degradation; noting it every solo scene
      // would train the owner to ignore real warnings.
      if (rawCount === 0 && this.drivesRepo.listForCampaign(campaignId).length > 0) {
        return { block: null, count: 0, note: "NPC agendas: this campaign has drive sheets but no characters are marked present this turn — scene presence may be missing, so no agendas were injected." };
      }
      return { block: null, note: null, count: 0 };
    }
    // By name, then by name key (2026-09-27): a scene's "Doran Vale" finds the sheet even if it is keyed
    // "Sheriff Doran Vale", as long as exactly one sheet carries that key.
    const allSheets = this.drivesRepo.listForCampaign(campaignId);
    const exact = new Map(allSheets.map((r) => [r.characterName, r]));
    const findSheet = (name: string) => exact.get(name) ?? (() => {
      const matches = allSheets.filter((r) => characterNameKey(r.characterName) === characterNameKey(name));
      return matches.length === 1 ? matches[0] : undefined;
    })();
    const CAP = 8;
    const lines: string[] = [];
    const rendered: Array<{ name: string; sheet: DriveSheet }> = [];
    for (const name of allNow) {
      if (lines.length >= CAP) break;
      const rec = findSheet(name);
      if (!rec || (rec as typeof rec & { sealed?: boolean }).sealed) continue; // no/hidden sheet → nothing to inject
      const line = renderAgendaLine(name, rec.sheet, unawareClean.includes(name), presentClean);
      if (line) { lines.push(line); rendered.push({ name, sheet: rec.sheet }); }
    }
    if (lines.length === 0) return { block: null, note: null, count: 0 };
    return { block: lines.join("\n"), note: staleWantNote(rendered), count: lines.length };
  }

  /** Present characters who are antagonists — sealed drive records (the
   *  Dramatist's scheme tier) or a sheet carrying an active scheme. PC always
   *  excluded. Returns [] when the campaign has no antagonists on stage, which is
   *  what keeps the intent pass free on ordinary turns. */
  private buildAntagonistBriefs(
    campaignId: string,
    session: { scenePresent?: string | null; scenePresentUnaware?: string | null },
    playerCharacterKeys: string[],
  ): AntagonistBrief[] {
    if (!this.drivesRepo) return [];
    const present = new Set<string>();
    for (const raw of [session.scenePresent, session.scenePresentUnaware]) {
      for (const name of normalizePresentNames(safeParseJson<string[]>(raw ?? "[]", []))) present.add(characterNameKey(name));
    }
    if (present.size === 0) return [];
    const pcSet = new Set(playerCharacterKeys.map((k) => k.trim().toLocaleLowerCase()).filter(Boolean));

    const briefs: AntagonistBrief[] = [];
    for (const row of this.drivesRepo.listForCampaign(campaignId)) {
      const key = characterNameKey(row.characterName);
      if (!present.has(key) || pcSet.has(row.characterName.toLocaleLowerCase()) || pcSet.has(key)) continue;
      const scheme = row.scheme && row.scheme.currentStep < row.scheme.steps.length ? row.scheme : null;
      const isAntagonist = row.sealed || Boolean(scheme);
      if (!isAntagonist) continue;
      const sheet = row.sheet;
      briefs.push({
        name: row.characterName,
        scheme: scheme ? JSON.stringify(scheme) : null,
        wants: (sheet?.wants ?? []).map((w) => w.text).filter(Boolean).slice(0, 3),
        redLines: (sheet?.redLines ?? []).slice(0, 4),
        leverage: (sheet?.leverage ?? []).slice(0, 4),
        concealment: (sheet?.concealment ?? []).map((c) => `${c.secret} (hidden by: ${c.behavior})`).slice(0, 3),
      });
    }
    return briefs;
  }

  private buildAbsentContactsBlock(
    campaignId: string,
    session: { scenePresent?: string | null; scenePresentUnaware?: string | null },
    playerCharacterKeys: string[],
  ): { block: string | null; count: number; names: string[] } {
    if (!this.drivesRepo) return { block: null, count: 0, names: [] };
    const present = new Set(normalizePresentNames([
      ...safeParseJson<string[]>(session.scenePresent || "[]", []),
      ...safeParseJson<string[]>(session.scenePresentUnaware || "[]", []),
    ]).map((name) => name.toLocaleLowerCase()));
    const pcLabel = playerCharacterKeys[0]?.trim() || "the player character";
    const pcKeys = new Set(playerCharacterKeys.map((name) => name.toLocaleLowerCase()));
    const rows = this.drivesRepo.listForCampaign(campaignId)
      .filter((row) => !present.has(row.characterName.toLocaleLowerCase()))
      .filter((row) => !isPlayerCharacter(row.characterName, playerCharacterKeys))
      .filter((row) => !(row as typeof row & { sealed?: boolean }).sealed)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5);
    const lines = rows.map((row) => {
      const disposition = Object.entries(row.sheet.dispositions)
        .find(([target]) => pcKeys.has(target.toLocaleLowerCase()))?.[1];
      const stamp = row.lastUpdatedTurn != null ? `turn ${row.lastUpdatedTurn}` : row.updatedAt.slice(0, 10);
      return `${row.characterName} — toward ${pcLabel}: ${disposition?.trim() || "not recorded"}; sheet current as of ${stamp}`;
    });
    return { block: lines.length ? lines.join("\n") : null, count: lines.length, names: rows.map((row) => row.characterName) };
  }

  // Living World — build the spotlight turn wrapper from a GM-directive marker.
  // Returns null when the last user turn isn't a spotlight marker (the common case).
  private buildSpotlightWrapper(campaignId: string, markerContent: string, playerCharacterKeys: string[]): string | null {
    const parsed = parseSpotlightMarker(markerContent);
    if (!parsed || !this.drivesRepo) return null;
    const rec = this.drivesRepo.findByCharacter(campaignId, parsed.name);
    const sheet = rec?.sheet;
    const pc = playerCharacterKeys[0]?.trim();
    const sheetBlock = sheet ? [
      sheet.wants.length ? `Wants: ${sheet.wants.map((w) => `${w.text}${w.blocked ? " (on hold)" : w.pressure >= 2 ? ` (pressure ${w.pressure})` : ""}`).join("; ")}` : "",
      sheet.goals.length ? `Goals: ${sheet.goals.filter((g) => g.status === "active").map((g) => g.text).join("; ")}` : "",
      sheet.offpageProject ? `Currently working on (off-page): ${sheet.offpageProject}` : "",
      Object.keys(sheet.dispositions).length ? `Dispositions: ${Object.entries(sheet.dispositions).map(([t, l]) => `${t}: ${l}`).join("; ")}` : "",
      sheet.redLines.length ? `Will not: ${sheet.redLines.join("; ")}` : "",
      sheet.leverage.length ? `Leverage: ${sheet.leverage.join("; ")}` : "",
      sheet.concealment.length ? `Guards: ${sheet.concealment.map((c) => `${c.secret} → ${c.behavior}`).join("; ")}` : "",
    ].filter(Boolean).join("\n") : "(no drive sheet on file; infer plausible, in-character motives)";
    const lines = [
      `<spotlight_directive>`,
      `The author is handing this beat to ${parsed.name}. Write the next beat DRIVEN BY ${parsed.name}'s own agenda: have them act, speak, or make a move that advances what they want, rather than responding to a player prompt.`,
      parsed.steer ? `Author's steer: ${parsed.steer}` : "",
      ``,
      `${parsed.name}'s drives:`,
      sheetBlock,
      ``,
      `Rules for this beat:`,
      `- Advance ${parsed.name}'s agenda concretely; let them take initiative.`,
      `- Do NOT act, speak, decide, or narrate the inner state of ${pc ? pc : "the player character"} beyond minimal involuntary reaction; that character belongs to the player.`,
      `- Stay in character and in canon; honor what ${parsed.name} guards and will not do.`,
      `- Begin with the mandatory [SCENE] block as always.`,
      `</spotlight_directive>`,
    ].filter(Boolean);
    return lines.join("\n");
  }

  // Annotate a just-persisted message with its variant fields for the
  // response.completed event (so the UI gets count/index/siblingIds with no
  // extra fetch). Append singletons return the message unchanged; continue
  // returns the TARGET row it updated.
  private decorateVariantMessage(
    userId: string,
    sessionId: string,
    assistantMessage: ReturnType<ChatService["buildAssistantMessage"]>,
    plan: AssistantTurnPlan,
  ): ChatMessage {
    if (plan.kind === "continue") {
      // Continue updated the target row in place, so the completed event must
      // carry THAT row — its id, original createdAt, accumulated usage and
      // variant fields — not the freshly-minted in-memory message (once,
      // Android's refetch-failed fallback appended a phantom row whose id did
      // not exist in `messages`).
      const row = this.messages.findById(userId, sessionId, plan.targetMessageId);
      if (row) return this.messageRowToStreamMessage(userId, sessionId, row);
      return { ...assistantMessage, id: plan.targetMessageId, variantGroupId: null, variantIndex: 0, variantCount: 1, variantSiblingIds: [] };
    }
    if (plan.kind !== "variant") {
      return { ...assistantMessage, variantGroupId: null, variantIndex: 0, variantCount: 1, variantSiblingIds: [] };
    }
    const siblings = this.messages.listVariantGroup(userId, sessionId, plan.variantGroupId).map((m) => m.id);
    const index = Math.max(0, siblings.indexOf(assistantMessage.id));
    return {
      ...assistantMessage,
      variantGroupId: plan.variantGroupId,
      variantIndex: index,
      variantCount: siblings.length,
      variantSiblingIds: siblings,
    };
  }

  // A persisted assistant row in the response.completed message shape — the
  // same projection getSessionDetail applies, for the one path (continue) whose
  // persisted message is an existing row rather than the in-memory build.
  private messageRowToStreamMessage(userId: string, sessionId: string, row: NonNullable<ReturnType<MessageRepository["findById"]>>): ChatMessage {
    const siblings = row.variantGroupId ? this.messages.listVariantGroup(userId, sessionId, row.variantGroupId).map((m) => m.id) : [];
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role as "user" | "assistant" | "cold-start",
      content: row.content,
      thinking: row.thinking,
      modelId: row.modelId,
      usage: row.role === "assistant" ? {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        reasoningTokens: row.reasoningTokens ?? null,
        speed: (row.fastMode ? "fast" : null) as "fast" | "standard" | null,
      } : null,
      stopReason: row.stopReason ?? null,
      stopDetails: row.stopDetailsJson ? safeParseJson<ChatMessage["stopDetails"]>(row.stopDetailsJson, null) : null,
      fastMode: Boolean(row.fastMode),
      rollOverride: Boolean(row.rollOverride),
      servedModel: row.servedModel ?? null,
      directiveKind: (row.directiveKind as "gm_spotlight" | null) ?? null,
      sceneData: row.sceneData ?? null,
      sceneValidator: row.sceneValidatorJson ? safeParseJson<ChatMessage["sceneValidator"]>(row.sceneValidatorJson, null) : null,
      sceneResolution: (row.sceneResolutionChoice as "main" | "validator" | "user" | null) ?? null,
      overhead: row.overheadJson ? safeParseJson<NonNullable<ChatMessage["overhead"]>>(row.overheadJson, []) : null,
      variantGroupId: row.variantGroupId ?? null,
      variantIndex: siblings.length ? Math.max(0, siblings.indexOf(row.id)) : 0,
      variantCount: siblings.length || 1,
      variantSiblingIds: siblings,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      attachments: [],
      generatedImages: this.generatedImages.listForMessageIds(userId, sessionId, [row.id]).map((image) => ({
        id: image.id,
        messageId: image.messageId,
        prompt: image.prompt,
        mimeType: image.mimeType,
        url: `/api/images/${image.id}`,
        createdAt: image.createdAt,
      })),
    };
  }

  // Recompute session-level scene state (location / present / presentUnaware) from
  // the last ACTIVE scene-bearing message. Reuses the syncSessionAfterMutation
  // logic so a variant switch / regenerate leaves the next turn's retrieval +
  // attire block + validator baseline pointing at the visible scene. Roster and
  // thread state are per-campaign and ADDITIVE — they are deliberately NOT rolled
  // back here (a hidden variant's characters stay known to the campaign). Attire
  // IS reconciled: rows written by a reply that is no longer the
  // visible one are withdrawn, and the visible reply's stored audit is re-applied.
  private reconcileSessionStateForActiveTail(userId: string, sessionId: string, cause = "active reply changed", withdrawnMessageIds: readonly string[] = []) {
    const active = this.messages.listForSession(userId, sessionId);
    let sceneLocation: string | null = null;
    let scenePresent = "[]";
    let scenePresentUnaware = "[]";
    for (let i = active.length - 1; i >= 0; i--) {
      const sceneDataRaw = active[i]!.sceneData;
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
      sceneLocation,
      scenePresent,
      scenePresentUnaware,
      updatedAt: new Date().toISOString(),
    });
    this.reconcileAttireProvenance(userId, sessionId, cause, withdrawnMessageIds);
  }

  // Regenerate an assistant turn as a NEW sibling variant (the prior reply is
  // PRESERVED, not destroyed). Mints a variant_group_id on first regenerate and
  // stamps it onto the existing message too, then streams a fresh sibling at the
  // target's sort_order and flips it active.
  async regenerateAssistant(
    userId: string,
    sessionId: string,
    messageId: string,
    requestId: string,
    emit: (event: ChatStreamEvent) => void,
    options?: { isClientConnected?: () => boolean; modelId?: string; rollOverride?: boolean },
  ) {
    this.requireUser(userId);
    const runtime = this.runtimeForUser(userId);
    if (!runtime) throw new HttpError(503, "chat provider runtime is not configured");
    const session = this.requireSession(userId, sessionId);
    const target = this.requireMessage(userId, sessionId, messageId);
    if (target.role !== "assistant") throw new HttpError(400, "regenerate only applies to assistant messages");
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;
    const wizardTemplates = session.sessionType === "wizard"
      ? this.wizardTemplates.ensureForUser(userId, new Date().toISOString())
      : null;
    const model = resolveChatModelConfig(this.customEndpoints, userId, options?.modelId || session.modelId);
    if (!model) throw new HttpError(400, "unsupported model");

    // Withdraw the target's attire writes BEFORE the transcript and the
    // <character_attire> block are built: the new sibling must not be composed
    // against attire the reply it replaces invented. If no
    // sibling lands, the finally below re-applies the target's stored audit.
    if (campaign && this.attireRepo) {
      const cause = `reply ${target.id.slice(0, 8)} (turn ${target.sortOrder}) superseded by a regenerate`;
      const changes = this.attireRepo.rollbackForMessages({ campaignId: campaign.id, messageIds: [target.id], reason: cause, turn: target.sortOrder });
      if (changes.length) this.recordAttireRollback(userId, sessionId, campaign.id, cause, changes);
    }

    // Mint (or reuse) the group, stamping it onto the existing target so the
    // original reply becomes the first sibling.
    const variantGroupId = target.variantGroupId ?? createId();
    if (!target.variantGroupId) {
      this.messages.updateMessage(userId, sessionId, messageId, { variantGroupId, updatedAt: new Date().toISOString() });
    }

    // Transcript = active messages strictly BEFORE the target slot (so prior
    // siblings of this same slot are excluded — they share the target's sortOrder).
    const transcript = this.messages.listForSession(userId, sessionId).filter((m) => m.sortOrder < target.sortOrder);
    const lastUser = [...transcript].reverse().find((m) => m.role === "user");
    if (!lastUser) throw new HttpError(400, "no preceding user turn to regenerate from");

    // An ARMED composer 🎲 covers a regenerate too: stamp the flag onto the
    // SOURCE user message (set-only — an unarmed regenerate never clears an
    // override the original send declared), so this variant and every later one
    // resolve their contests overridden. Persisting on the row rather than
    // threading a parameter keeps the regeneration-stability contract: the flag
    // travels with the turn, not with the request.
    if (options?.rollOverride === true && !lastUser.rollOverride) {
      this.messages.updateMessage(userId, sessionId, lastUser.id, { rollOverride: true, updatedAt: new Date().toISOString() });
    }

    try {
      await this.runAssistantTurn({
        userId, sessionId, session: this.sessionForTranscript(session, transcript), campaign, runtime, model, wizardTemplates, requestId, emit,
        options: options ? { isClientConnected: options.isClientConnected } : undefined,
        conversation: transcript as any, sourceUserMessageId: lastUser.id,
        sceneConstraintOverride: null,
        plan: { kind: "variant", assistantSortOrder: target.sortOrder, variantGroupId },
      });
    } finally {
      // A sibling landed: its own audit wrote fresh rows and this is a no-op. No
      // sibling landed: the target is still the active tail and its stored audit
      // is re-applied over the rollback above.
      this.reconcileAttireProvenance(userId, sessionId, `regenerate of reply ${target.id.slice(0, 8)} settled`);
    }
  }

  // Continue a max_tokens-truncated assistant message IN PLACE: strip the
  // truncation warning, stream a continuation, and UPDATE the row (no new variant).
  async continueAssistant(
    userId: string,
    sessionId: string,
    messageId: string,
    requestId: string,
    emit: (event: ChatStreamEvent) => void,
    options?: { isClientConnected?: () => boolean; modelId?: string },
  ) {
    this.requireUser(userId);
    const runtime = this.runtimeForUser(userId);
    if (!runtime) throw new HttpError(503, "chat provider runtime is not configured");
    const session = this.requireSession(userId, sessionId);
    const target = this.requireMessage(userId, sessionId, messageId);
    if (target.role !== "assistant") throw new HttpError(400, "continue only applies to assistant messages");
    if (!target.variantActive) throw new HttpError(409, "Reply is no longer the active variant. Reload before continuing.");
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;
    const wizardTemplates = session.sessionType === "wizard"
      ? this.wizardTemplates.ensureForUser(userId, new Date().toISOString())
      : null;
    const model = resolveChatModelConfig(this.customEndpoints, userId, options?.modelId || session.modelId);
    if (!model) throw new HttpError(400, "unsupported model");

    // Strip every transport marker from the prior content — the truncation
    // banner and the *[Stopped]* / *[Stream interrupted: …]* markers of
    // a stop- or error-persisted row — so the continuation resumes from prose
    // and the marker never sits mid-message, where the end-anchored runtime and
    // export sanitizers cannot strip it and every later turn replayed it to the
    // model. A stopped-before-stream placeholder yields an empty prior: the
    // continuation becomes the reply.
    const priorContent = sanitizeRuntimeMessageContent(target.content).replace(/^\*\[Stopped before response began\]\*$/, "").trimEnd();
    // Transcript = all active messages up to AND INCLUDING the target, with the
    // target carrying the de-warned prior prose so the model continues it.
    const upToTarget = this.messages.listForSession(userId, sessionId).filter((m) => m.sortOrder <= target.sortOrder);
    const transcript = upToTarget.map((m) => (m.id === target.id ? { ...m, content: priorContent } : m));
    const lastUser = [...transcript].reverse().find((m) => m.role === "user");

    await this.runAssistantTurn({
      userId, sessionId, session: this.sessionForTranscript(session, transcript), campaign, runtime, model, wizardTemplates, requestId, emit,
      options: options ? { isClientConnected: options.isClientConnected } : undefined,
      conversation: transcript as any, sourceUserMessageId: lastUser?.id ?? target.id,
      sceneConstraintOverride: null,
      plan: { kind: "continue", assistantSortOrder: target.sortOrder, targetMessageId: target.id, expectedContent: target.content, priorContent, priorThinking: target.thinking ?? null, priorSceneData: target.sceneData ?? null },
    });
  }

  // Edit a user turn and re-run the assistant in one atomic op: edit the user
  // message content, truncate everything after it, then stream a fresh reply.
  async editAndRegenerate(
    userId: string,
    sessionId: string,
    userMessageId: string,
    content: string,
    requestId: string,
    emit: (event: ChatStreamEvent) => void,
    options?: { isClientConnected?: () => boolean; modelId?: string; rollOverride?: boolean },
  ) {
    this.requireUser(userId);
    const runtime = this.runtimeForUser(userId);
    if (!runtime) throw new HttpError(503, "chat provider runtime is not configured");
    const session = this.requireSession(userId, sessionId);
    const userMessage = this.requireMessage(userId, sessionId, userMessageId);
    if (userMessage.role !== "user") throw new HttpError(400, "edit-and-regenerate targets a user message");
    const campaign = session.campaignId ? this.campaigns.findById(userId, session.campaignId) : null;
    const wizardTemplates = session.sessionType === "wizard"
      ? this.wizardTemplates.ensureForUser(userId, new Date().toISOString())
      : null;
    const model = resolveChatModelConfig(this.customEndpoints, userId, options?.modelId || session.modelId);
    if (!model) throw new HttpError(400, "unsupported model");

    const now = new Date().toISOString();
    // Edit the user turn, then drop everything after it (artifacts included). This
    // is a hard truncation, NOT a variant — the edited user turn invalidates the
    // entire downstream branch. An ARMED composer 🎲 rides along (set-only).
    this.messages.updateMessage(userId, sessionId, userMessageId, {
      content,
      updatedAt: now,
      ...(options?.rollOverride === true ? { rollOverride: true } : {}),
    });
    const trailing = this.messages.listAfterSortOrder(userId, sessionId, userMessage.sortOrder);
    if (trailing.length) {
      this.messages.transact(() => {
        this.releasePipelineCounters(userId, sessionId, trailing.map((m) => m.id));
        this.deleteMessageArtifacts(userId, sessionId, trailing.map((m) => m.id));
        this.messages.deleteAfterSortOrder(userId, sessionId, userMessage.sortOrder);
      });
    }
    this.reconcileSessionStateForActiveTail(userId, sessionId, `turn ${userMessage.sortOrder} edited and regenerated; later replies dropped`, trailing.map((m) => m.id));

    const transcript = this.messages.listForSession(userId, sessionId);
    await this.runAssistantTurn({
      userId, sessionId, session: this.sessionForTranscript(session, transcript), campaign, runtime, model, wizardTemplates, requestId, emit,
      options: options ? { isClientConnected: options.isClientConnected } : undefined,
      conversation: transcript as any, sourceUserMessageId: userMessageId,
      sceneConstraintOverride: null,
      plan: { kind: "append", assistantSortOrder: userMessage.sortOrder + 1 },
    });
  }

  // Switch which sibling of a variant group is the active one (non-streaming).
  // Flips active atomically, recomputes session scene state from the new active
  // tail, and returns the refreshed session detail.
  switchVariant(userId: string, sessionId: string, variantMessageId: string): SessionDetailResponse {
    this.requireUser(userId);
    this.requireSession(userId, sessionId);
    const target = this.messages.findById(userId, sessionId, variantMessageId);
    if (!target) throw new HttpError(404, "variant not found");
    if (!target.variantGroupId) throw new HttpError(400, "message is not part of a variant group");
    const hidden = this.messages.listVariantGroup(userId, sessionId, target.variantGroupId).filter((m) => m.variantActive && m.id !== variantMessageId).map((m) => m.id);
    this.messages.setActiveVariant(userId, sessionId, target.variantGroupId, variantMessageId);
    this.reconcileSessionStateForActiveTail(userId, sessionId, `variant ${variantMessageId.slice(0, 8)} (turn ${target.sortOrder}) made active`, hidden);
    return this.getSessionDetail(userId, sessionId);
  }

  private async runSceneValidatorTurn(input: {
    userId: string;
    sessionId: string;
    campaignId: string;
    messageId: string;
    runtime: ChatRuntime;
    modelId: string;
    openaiFastMode?: boolean;
    sceneState: SceneState;
    attireAdvisory: Record<string, string> | null;
    trackAttire: boolean;
    emit: (event: ChatStreamEvent) => void;
    isClientConnected?: () => boolean;
    /** The audit of an EDITED newest reply also applies its
     *  presence verdict to the reply's scene_data and the session's lists. Only
     *  reauditEditedReply sets it; a completed reply's audit leaves the owner to
     *  resolve a disagreement as before. */
    applyPresence?: boolean;
  }) {
    const { userId, sessionId, campaignId, messageId, runtime, modelId, sceneState, attireAdvisory, trackAttire, emit, isClientConnected } = input;
    // The audited row must EXIST. On the browser-
    // disconnect path the reply lives only in pending_assistant_messages: the
    // validator then ran "blind" against a history missing the very turn it was
    // auditing (the bug the comment below records as fixed), its verdict UPDATE
    // hit no row, attire upserts landed from that blind audit, and nothing
    // surfaced. (Before that, the missing row also defaulted the attire turn
    // to 0.) The pending schema carries no verdict column, so skip loudly rather
    // than audit a turn that is not there.
    const target = this.messages.findById(userId, sessionId, messageId);
    if (!target) {
      recordSystemEvent({
        userId,
        source: "scene_validator",
        severity: "info",
        campaignId,
        sessionId,
        message: "scene validator skipped — the reply was not persisted yet (client disconnected mid-stream; it is recovered as a pending message on the next load), so this turn was not audited",
        details: { messageId },
      });
      return;
    }
    const allMessages = this.messages.listForSession(userId, sessionId);
    // The audited assistant turn MUST be included (as the latest entry): the
    // validator prompt says "read the latest assistant turn carefully" — the old
    // filter excluded it, so presence/attire reconciliation ran blind against
    // the very narrative it was auditing.
    const recent = [...allMessages.filter(message => message.sortOrder < target.sortOrder), target].slice(-10);
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
      ? normalizePresentNames([...sceneState.present, ...sceneState.presentUnaware])
      : [];
    let attireBefore: Record<string, string> | undefined;
    if (trackAttire && this.attireRepo && trackedNames.length > 0) {
      const rows = this.attireRepo.findManyByCharacter(campaignId, trackedNames);
      // Same withdrawal as the context block: a row from a
      // deleted or superseded reply is not a baseline the auditor may carry forward.
      const withdrawn = new Set(this.attireRepo.listDeadProvenance(campaignId, trackedNames)
        .filter((r) => r.lastSeenInPresentTurn <= r.lastUpdatedTurn).map((r) => r.characterName));
      attireBefore = {};
      for (const r of rows) if (!withdrawn.has(r.characterName)) attireBefore[r.characterName] = r.attireDescription;
    }

    const result = await runSceneValidator({
      runtime,
      modelId,
      openaiFastMode: input.openaiFastMode ?? false,
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
      // The usage was spent whether or not a verdict came back: it
      // belongs on the row like the success path's entry.
      if (result.usage) this.appendValidatorUsage(userId, sessionId, messageId, target, modelId, result.usage);
      // Unparseable OR empty output is exactly as invisible as a dead validator
      // — record both (the empty case used to pass in silence; the presence
      // normalizer already records its own). A thrown call recorded its event
      // inside runSceneValidator (`failure`), so it is not recorded twice.
      if (!result.failure) {
        recordSystemEvent({
          userId,
          source: "scene_validator",
          message: `scene validator returned ${result.rawResponse.trim() ? "unparseable" : "empty"} output (${modelId}) — turn not audited`,
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
    let applied = false;
    let presenceChange: ReturnType<ChatService["applyEditedReplyPresence"]> = null;
    this.messages.transact(() => {
      const current = this.messages.findById(userId, sessionId, messageId);
      if (!current?.variantActive || current.content !== target.content || current.sceneData !== target.sceneData) return;
      applied = true;
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

      const latestAssistant = [...this.messages.listForSession(userId, sessionId)].reverse().find(message => message.role === "assistant");
      if (latestAssistant?.id === messageId && trackAttire && this.attireRepo && verdict.attire) {
        const turn = target.sortOrder;
        // Expand the canonicalization set to include validator-corrected names so
        // characters the main LLM omitted (but the validator caught) still get
        // attire upserts. Declared-only was the original gap.
        const effectiveNames = normalizePresentNames([
          ...trackedNames,
          ...verdict.present,
          ...verdict.presentUnaware,
        ]);
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

      // An edited reply is the canon: when the owner edits
      // the newest reply, the presence its new text shows replaces the presence
      // its old text declared. Same CAS as the verdict write (the reply is still
      // the active, unchanged target) and the same newest-reply gate as attire:
      // once a later reply exists it already owns the scene, so nothing moves.
      if (input.applyPresence && latestAssistant?.id === messageId && verdict.agreement === "disagree") {
        presenceChange = this.applyEditedReplyPresence(userId, sessionId, campaignId, current, verdict);
      }
    });
    if (!applied) return;
    if (presenceChange) {
      const change: NonNullable<ReturnType<ChatService["applyEditedReplyPresence"]>> = presenceChange;
      const list = (names: string[]) => (names.length ? names.join(", ") : "nobody");
      chatLogger.info({ sessionId, campaignId, messageId, change }, "presence re-derived from an edited reply");
      recordSystemEvent({
        userId, source: "scene_validator", severity: "info", campaignId, sessionId,
        message: `presence re-derived from edited reply ${messageId.slice(0, 8)} (turn ${target.sortOrder}): present ${list(change.before.present)} → ${list(change.after.present)}; present-unaware ${list(change.before.presentUnaware)} → ${list(change.after.presentUnaware)}`,
        details: { messageId, modelId, before: change.before, after: change.after },
      });
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

  private sessionForTranscript(
    session: ReturnType<ChatService["requireSession"]>,
    transcript: Array<{ id: string; sceneData?: unknown }>,
  ): ReturnType<ChatService["requireSession"]> {
    const scene = [...transcript].reverse().flatMap(message => {
      const parsed = typeof message.sceneData === "string" ? deserializeSceneData(message.sceneData) : null;
      return parsed ? [parsed] : [];
    })[0];
    return { ...session, sceneLocation: scene?.location ?? null, scenePresent: JSON.stringify(scene?.present ?? []), scenePresentUnaware: JSON.stringify(scene?.presentUnaware ?? []) };
  }

  private syncSessionAfterMutation(userId: string, sessionId: string, cause = "messages removed", removedMessageIds: readonly string[] = []) {
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
      // Same source as every other writer: countForSession is active-only.
      messageCount: this.messages.countForSession(userId, sessionId),
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
    this.reconcileAttireProvenance(userId, sessionId, cause, removedMessageIds);
  }

  // ---- Attire provenance -----------------------------------------------------
  //
  // The scene validator writes character_attire the moment a reply completes.
  // Deleting, editing, truncating or regenerating that reply used to leave the
  // row in place, and <character_attire> injected it at the recency end of every
  // later turn: a hallucinated "the sword seals are gone" (a deleted reply) and
  // an alarm the user had edited out (the composer then staged the whole
  // boarding the row described) both defeated explicit OOC corrections. Every
  // mutation path now withdraws the writes of replies that no longer stand,
  // restoring the value recorded before them, and an edited LATEST reply is
  // re-audited from its new text.

  /** The turn a correction made now is stamped with: the slot after the active tail. */
  private currentTurnEstimate(userId: string, sessionId: string): number {
    const active = this.messages.listForSession(userId, sessionId);
    return active.length ? Math.max(...active.map((m) => m.sortOrder)) + 1 : 0;
  }

  private recordAttireRollback(userId: string, sessionId: string, campaignId: string, cause: string, changes: AttireRollbackChange[]) {
    const names = [...new Set(changes.map((c) => c.characterName))];
    chatLogger.info({ sessionId, campaignId, cause, changes }, "attire writes withdrawn");
    recordSystemEvent({
      userId, source: "scene_validator", severity: "info", campaignId, sessionId,
      message: `attire withdrawn for ${names.length === 1 ? names[0] : `${names.length} characters`}: ${cause}`,
      details: { changes },
    });
  }

  /**
   * Withdraw every attire row whose source reply is deleted or a hidden sibling,
   * then re-apply the visible tail reply's stored audit. Idempotent; runs after
   * every transcript mutation. Failures are recorded, never thrown: the
   * mutation that triggered this has already committed.
   */
  private reconcileAttireProvenance(userId: string, sessionId: string, cause: string, withdrawnMessageIds: readonly string[] = []) {
    if (!this.attireRepo) return;
    const campaignId = this.sessions.findById(userId, sessionId)?.campaignId;
    if (!campaignId) return;
    try {
      const turn = this.currentTurnEstimate(userId, sessionId);
      const all: AttireRollbackChange[] = [];
      // The replies this mutation removed are withdrawn outright: their text is
      // not canon, however long the validator carried their attire forward.
      if (withdrawnMessageIds.length) {
        all.push(...this.attireRepo.rollbackForMessages({ campaignId, messageIds: withdrawnMessageIds, reason: cause, turn }));
      }
      // The sweep behind it takes only rows never re-confirmed since their write
      // (never seen present in a later audited turn): a row written before this
      // rule existed and carried through many later turns is de facto canon and
      // is left to the maintenance tool (`--max-carry`), not churned here. Each
      // pass withdraws one layer; a restored provenance can itself be dead (two
      // regenerated replies in a row), so loop until nothing fresh remains.
      for (let pass = 0; pass < 5; pass++) {
        const dead = this.attireRepo.listDeadProvenance(campaignId).filter((r) => r.lastSeenInPresentTurn <= r.lastUpdatedTurn);
        if (!dead.length) break;
        const changes = this.attireRepo.rollbackForMessages({
          campaignId, messageIds: dead.map((r) => r.lastUpdatedMessageId!), characterNames: dead.map((r) => r.characterName), reason: cause, turn,
        });
        if (!changes.length) break;
        all.push(...changes);
      }
      if (all.length) this.recordAttireRollback(userId, sessionId, campaignId, cause, all);
      this.reapplyAttireVerdictForActiveTail(userId, sessionId, campaignId);
    } catch (err) {
      chatLogger.warn({ err, sessionId }, "attire provenance reconcile failed (non-fatal)");
      recordSystemEvent({
        userId, source: "scene_validator", severity: "error", campaignId, sessionId,
        message: `attire provenance reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Re-apply the ACTIVE tail reply's stored attire audit where its rows were
   * withdrawn: the swipe back to an earlier sibling, or a regenerate that never
   * landed. Names are canonicalised exactly as the original write did (the
   * declared and audited presence lists stored with the verdict). A manual
   * correction made at or after that reply wins; an equal value is left alone.
   */
  private reapplyAttireVerdictForActiveTail(userId: string, sessionId: string, campaignId: string) {
    if (!this.attireRepo) return;
    const tail = [...this.messages.listForSession(userId, sessionId)].reverse().find((m) => m.role === "assistant");
    if (!tail?.sceneValidatorJson) return;
    const payload = safeParseJson<{
      main?: { present?: string[]; presentUnaware?: string[] };
      validator?: { present?: string[]; presentUnaware?: string[] };
      attire?: Record<string, { description?: string; changed?: boolean; reason?: string | null }>;
    } | null>(tail.sceneValidatorJson, null);
    if (!payload?.attire) return;
    const tracked = normalizePresentNames([
      ...(payload.main?.present ?? []), ...(payload.main?.presentUnaware ?? []),
      ...(payload.validator?.present ?? []), ...(payload.validator?.presentUnaware ?? []),
    ]);
    const validNames = new Set(tracked);
    const validNamesLower = new Map(tracked.map((n) => [n.toLowerCase(), n]));
    const rows = new Map(this.attireRepo.findManyByCharacter(campaignId, tracked).map((r) => [r.characterName, r]));
    for (const [rawName, entry] of Object.entries(payload.attire)) {
      const canonical = validNames.has(rawName) ? rawName : validNamesLower.get(rawName.toLowerCase());
      const description = entry?.description?.trim();
      if (!canonical || !description) continue;
      const row = rows.get(canonical);
      if (row?.lastUpdatedMessageId === tail.id) continue;
      if (row && row.source === "manual" && row.lastUpdatedTurn >= tail.sortOrder) continue;
      if (row && row.attireDescription.trim() === description) continue;
      this.attireRepo.upsert({
        campaignId,
        characterName: canonical,
        attireDescription: description,
        turn: tail.sortOrder,
        messageId: tail.id,
        source: "verifier",
        previousAttire: row?.attireDescription ?? null,
        reason: entry.reason ?? "re-applied from the visible reply's stored audit",
        recordHistory: true,
      });
    }
  }

  /**
   * An edited reply: withdraw the attire its old text produced, drop the attire
   * part of its stored audit (a later swipe must not re-apply the pre-edit
   * audit; the presence verdict stays for the chip), and re-audit the new text
   * when the reply is still the latest one. Older replies are only withdrawn:
   * the validator's attire write is gated to the latest reply, and a later
   * audit already owns anything that changed since.
   */
  private withdrawAttireForEditedReply(userId: string, sessionId: string, campaignId: string, message: { id: string; sortOrder: number; sceneValidatorJson: string | null }) {
    if (!this.attireRepo) return;
    const cause = `reply ${message.id.slice(0, 8)} (turn ${message.sortOrder}) edited`;
    try {
      const changes = this.attireRepo.rollbackForMessages({
        campaignId, messageIds: [message.id], reason: cause, turn: this.currentTurnEstimate(userId, sessionId),
      });
      if (changes.length) this.recordAttireRollback(userId, sessionId, campaignId, cause, changes);
      const payload = safeParseJson<Record<string, unknown> | null>(message.sceneValidatorJson, null);
      if (payload && "attire" in payload) {
        const kept = { ...payload };
        delete kept.attire;
        this.messages.updateMessage(userId, sessionId, message.id, {
          sceneValidatorJson: JSON.stringify({ ...kept, attireWithdrawnAt: new Date().toISOString() }),
        });
      }
    } catch (err) {
      chatLogger.warn({ err, sessionId }, "attire withdrawal for edited reply failed (non-fatal)");
      recordSystemEvent({
        userId, source: "scene_validator", severity: "error", campaignId, sessionId,
        message: `attire withdrawal for edited reply failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    void this.reauditEditedReply(userId, sessionId, campaignId, message.id).catch((err) => {
      chatLogger.warn({ err, sessionId }, "re-audit of edited reply failed (non-fatal)");
      recordSystemEvent({
        userId, source: "scene_validator", severity: "warn", campaignId, sessionId,
        message: `re-audit of edited reply failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }

  /**
   * Apply the presence verdict of an edited newest reply:
   * the reply's scene_data takes the validator's present and present-unaware
   * lists, and so do the session's lists; location, date, time, reason and the
   * composer's inline attire stay as recorded. The roster gains any new name and
   * NOT PRESENT is recomputed from it, as the owner's own "validator" resolution
   * does (resolveSceneValidation). The reply is marked resolved by the validator,
   * so its divider shows "validator-corrected" with the old and new lists. Runs
   * inside runSceneValidatorTurn's transaction; returns the change, or null when
   * the reply has no scene or the lists already match.
   */
  private applyEditedReplyPresence(
    userId: string,
    sessionId: string,
    campaignId: string,
    reply: { id: string; sceneData: string | null },
    verdict: { present: string[]; presentUnaware: string[] },
  ): { before: { present: string[]; presentUnaware: string[] }; after: { present: string[]; presentUnaware: string[] } } | null {
    if (!reply.sceneData) return null;
    const stored = safeParseJson<Record<string, unknown> | null>(reply.sceneData, null);
    const existing = deserializeSceneData(reply.sceneData);
    if (!stored || !existing) return null;
    const present = [...new Set(verdict.present.map((n) => n.trim()).filter(Boolean))];
    const presentUnaware = [...new Set(verdict.presentUnaware.map((n) => n.trim()).filter(Boolean))].filter((n) => !present.includes(n));
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((n) => b.includes(n));
    if (sameSet(present, existing.present) && sameSet(presentUnaware, existing.presentUnaware)) return null;
    const { notPresent: _previousNotPresent, ...kept } = stored;
    const corrected = { ...kept, present, presentUnaware } as SceneState;
    const now = new Date().toISOString();
    const campaign = this.campaigns.findById(userId, campaignId);
    const roster = safeParseJson<string[]>(campaign?.characterRoster || "[]", []);
    const updatedRoster = updateCharacterRoster(roster, corrected);
    if (updatedRoster) this.campaigns.updateCampaign(userId, campaignId, { characterRoster: JSON.stringify(updatedRoster), updatedAt: now });
    const notPresent = computeNotPresent(updatedRoster ?? roster, corrected);
    this.messages.updateMessage(userId, sessionId, reply.id, {
      sceneData: serializeSceneData(corrected, notPresent),
      sceneResolutionChoice: "validator",
      updatedAt: now,
    });
    this.sessions.updateSession(userId, sessionId, {
      scenePresent: JSON.stringify(present),
      scenePresentUnaware: JSON.stringify(presentUnaware),
      updatedAt: now,
    });
    return { before: { present: existing.present, presentUnaware: existing.presentUnaware }, after: { present, presentUnaware } };
  }

  /** Re-audit an edited LATEST reply from its new text: attire, and presence
   *  (applyEditedReplyPresence). Advisory-free: the composer's inline
   *  attire declaration described the old text. Runs under the same target
   *  check as the post-reply audit, so a reply that stops being the latest
   *  mid-call writes nothing. */
  private async reauditEditedReply(userId: string, sessionId: string, campaignId: string, messageId: string) {
    const session = this.sessions.findById(userId, sessionId);
    if (!session || !this.contextEngine) return;
    const settings = this.contextEngine.resolveSettings({ contextOverridesJson: session.contextOverridesJson });
    if (!settings.sceneValidatorEnabled) return;
    const runtime = this.runtimeForUser(userId);
    if (!runtime) return;
    const tail = [...this.messages.listForSession(userId, sessionId)].reverse().find((m) => m.role === "assistant");
    if (tail?.id !== messageId) return;
    const scene = tail.sceneData ? deserializeSceneData(tail.sceneData) : null;
    const sceneState: SceneState = scene ?? {
      location: session.sceneLocation ?? "",
      present: safeParseJson<string[]>(session.scenePresent || "[]", []),
      presentUnaware: safeParseJson<string[]>(session.scenePresentUnaware || "[]", []),
      reason: null, date: null, time: null,
    };
    await this.runSceneValidatorTurn({
      userId, sessionId, campaignId, messageId, runtime,
      modelId: settings.sceneValidatorModel, openaiFastMode: settings.openaiFastModeEnabled,
      sceneState, attireAdvisory: null, trackAttire: settings.attireTrackingEnabled,
      emit: () => {}, isClientConnected: () => false,
      // Presence follows the new text only where the reply recorded a scene;
      // a scene-less reply carries the previous one forward and keeps doing so.
      applyPresence: Boolean(tail.sceneData),
    });
  }

  // Attachments keyed by message id, for the given (windowed) message ids only.
  private getAttachmentMap(userId: string, sessionId: string, messageIds: string[]) {
    const map = new Map<string, ChatPromptAttachment[]>();
    for (const attachment of this.attachments.listForMessageIds(userId, sessionId, messageIds)) {
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

  /** Validator usage for a call that returned no verdict: appended
   *  under the same CAS as the verdict write — the row must still be the active,
   *  unchanged target — so cost accounting never lands on a different reply. */
  private appendValidatorUsage(userId: string, sessionId: string, messageId: string, target: { content: string; sceneData: string | null }, modelId: string, usage: { inputTokens: number; outputTokens: number }) {
    this.messages.transact(() => {
      const current = this.messages.findById(userId, sessionId, messageId);
      if (!current?.variantActive || current.content !== target.content || current.sceneData !== target.sceneData) return;
      const existingOverhead = current.overheadJson ? safeParseJson<Array<{ source: string; modelId: string; inputTokens: number; outputTokens: number }>>(current.overheadJson, []) : [];
      this.messages.updateMessage(userId, sessionId, messageId, {
        overheadJson: JSON.stringify([...(existingOverhead ?? []), { source: "scene_validator", modelId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }]),
        updatedAt: new Date().toISOString(),
      });
    });
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
      // Assistant messages never carry the owner roll override — it lives on the
      // USER message that opened the turn.
      rollOverride: false,
      servedModel: input.servedModel ?? null,
      directiveKind: null,
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

// Retrieved lorebook context is NOT a system-prompt section: it rides in the
// last user turn as <retrieved_context> (see the per-turn block assembly in
// runAssistantTurn) so the cached system prefix stays byte-stable across turns.
/** Last line of every campaign system prompt; exported so the Engine dialog's "Injected text"
 *  viewer shows the same string (promptFragments.ts). */
export const SCENE_BLOCK_REMINDER = "REMINDER: Begin your response with a [SCENE] block before any narrative text. This is mandatory infrastructure. The system strips it before display.";

function buildSessionSystemPrompt(input: {
  systemPrompt: string | null;
  isCampaignSession: boolean;
  /** Campaign-scoped anti-repetition STATE (`campaigns.anti_repetition_json`, 0077)
   *  — never settings. It lived in the campaign settings blob until that tier was
   *  retired, which is part of why the blob kept looking load-bearing. */
  antiRepetitionJson: string | null;
  npcInitiative?: "subtle" | "normal" | "assertive";
  playerCharacterKeys?: string[];
  /** Grit contract. Never empty: the craft and
   *  physics blocks (knowledge firewall, perception, habituation, prose) and scene
   *  authority fire at every stance; the darker clauses join as the World stance
   *  and Depiction tier dials rise (buildGritBlocks). */
  gritBlocks?: string | null;
  /** Character Engine voice pack (world/characterIntegrity.ts). Default ON
   *  since 2026-08-30. Runtime-injected like the grit floor so the
   *  sysprompt-audit worker can never rewrite it. */
  characterIntegrity?: string | null;
  /** Content Honesty consent/scope section (world/contentHonesty.ts). Google +
   *  Kimi-K3 composers only (contentHonestyApplies) — Anthropic sessions never
   *  receive it. Runtime-injected for the same audit-worker reason. */
  contentHonesty?: string | null;
}) {
  const sections: string[] = [];
  if (input.isCampaignSession) sections.push(buildSceneTrackingInstruction());
  if (input.isCampaignSession) sections.push(buildWorldAuthorityNorms(input.playerCharacterKeys));
  if (input.isCampaignSession) sections.push(buildKnowledgeEnforcementInstruction());
  // Living World — NPC initiative norms slot AFTER the scene-instruction block
  // (scene-first invariant preserved) and are runtime-injected, so the
  // sysprompt-audit worker can never clobber them.
  if (input.isCampaignSession) sections.push(buildInitiativeNorms(input.npcInitiative ?? "normal"));
  // Grit floor. Runtime-injected like the other norms so the sysprompt-audit
  // worker can never rewrite it, and placed after them so it wins on recency.
  if (input.isCampaignSession && input.gritBlocks) sections.push(input.gritBlocks);
  // Voice pack after the grit floor: craft rules win the norms region's
  // recency end, and the campaign prompt below still owns tone and setting.
  if (input.isCampaignSession && input.characterIntegrity) sections.push(input.characterIntegrity);
  // Consent/scope section as the last runtime-injected block before the
  // campaign prompt: it frames what the fiction below is permitted to render.
  if (input.isCampaignSession && input.contentHonesty) sections.push(input.contentHonesty);
  const promptAndRules = input.systemPrompt?.trim() ?? "";
  const rulesSection = input.isCampaignSession ? renderAntiRepetitionRules(input.antiRepetitionJson) : null;
  const cachedBlock = [promptAndRules, rulesSection].filter(Boolean).join("\n\n---\n\n");
  if (cachedBlock) {
    sections.push(CACHE_BOUNDARY_SENTINEL + cachedBlock);
  } else if (sections.length > 0) {
    sections[sections.length - 1] = CACHE_BOUNDARY_SENTINEL + sections[sections.length - 1];
  }
  if (input.isCampaignSession) sections.push(SCENE_BLOCK_REMINDER);
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

export function renderAntiRepetitionRules(antiRepetitionJson: string | null): string | null {
  if (!antiRepetitionJson) return null;
  try {
    const state = JSON.parse(antiRepetitionJson);
    const rules: AntiRepetitionRule[] = state.antiRepetitionRules;
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

// Strip the transport markers this service appends to persisted assistant
// content before the row is replayed to the model as history:
//   - the `*[Stopped]*` marker (stop path);
//   - the `---\n\n*[Stream interrupted: <reason>]*` marker (provider-error
//     path) — `[\s\S]` because the reason is a provider error message and
//     fetch/undici/JSON bodies span lines, which `.` never crossed, so the
//     marker leaked into every later turn's transcript;
//   - the max-output truncation banner (UI chrome, not prose).
function sanitizeRuntimeMessageContent(content: string) {
  return stripTruncationWarning(content
    .replace(/\n\n\*\[Stopped\]\*$/, "")
    .replace(/\n\n---\n\n\*\[Stream interrupted:[\s\S]*?\]\*$/, ""));
}

function appendTruncationWarning(content: string, outputTruncated: boolean, maxOutputTokens: number | null | undefined) {
  if (!outputTruncated) return content;
  const limit = (maxOutputTokens ?? 32768).toLocaleString();
  return `${content}\n\n---\n\n**⚠ Output truncated** — hit the model's max output token limit (${limit}). The response was cut off.`;
}

// Strip the truncation warning banner appendTruncationWarning adds, so a
// "continue" resumes from the actual prose rather than the banner text.
/** Session-detail campaign fields that used to be placeholders: PC keys
 *  and embedding model from this session's dials, anti-repetition state from its
 *  own column — the same readings the campaign list serves. */
function resolveSessionCampaignFields(contextOverridesJson: string | null | undefined, antiRepetitionJson: string | null | undefined) {
  const dials = safeParseJson<{ playerCharacterKeys?: unknown; embeddingModel?: unknown }>(contextOverridesJson ?? null, {}) ?? {};
  const rules = safeParseJson<{ antiRepetitionRules?: unknown; archivedAntiRepetitionRules?: unknown }>(antiRepetitionJson ?? null, {}) ?? {};
  return {
    playerCharacterKeys: Array.isArray(dials.playerCharacterKeys) ? dials.playerCharacterKeys.map(String).filter(Boolean) : [],
    embeddingModel: typeof dials.embeddingModel === "string" && dials.embeddingModel ? dials.embeddingModel : null,
    antiRepetitionRules: Array.isArray(rules.antiRepetitionRules) ? rules.antiRepetitionRules : [],
    archivedAntiRepetitionRules: Array.isArray(rules.archivedAntiRepetitionRules) ? rules.archivedAntiRepetitionRules : [],
  };
}

function stripTruncationWarning(content: string): string {
  return content.replace(/\n\n---\n\n\*\*⚠ Output truncated\*\* — hit the model's max output token limit \([^)]*\)\. The response was cut off\.$/, "").trimEnd();
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

// The synthetic abort the composer try throws when Stop landed during the
// pre-stream phases — shaped exactly like a runtime abort so the stopped
// branch (stopRequested && isAbortError) handles both identically.
function stoppedBeforeStreamError() {
  const error = new Error("stopped before the response began");
  error.name = "AbortError";
  return error;
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

// Markdown export: drop the transport markers (same set the runtime sanitizer
// strips). The old pattern required "]" right after "interrupted", so the
// `*[Stream interrupted: <reason>]*` form was never matched.
function cleanExportContent(content: string) {
  return content
    .replace(/\n*\*\[Stopped\]\*$/, "")
    .replace(/\n*(?:---\n\n)?\*\[Stream interrupted:[\s\S]*?\]\*$/, "")
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

// Living World — NPC initiative norms, injected after the scene-instruction block.
// Runtime-injected (never stored in campaign.system_prompt) so the sysprompt-audit
// worker cannot clobber them.
// Living World — parse a GM-spotlight marker: `[GM SPOTLIGHT — Name]` or
// `[GM SPOTLIGHT — Name: steer]`. Tolerant of the ASCII hyphen too.
export function parseSpotlightMarker(content: string): { name: string; steer: string | null } | null {
  const m = content.trim().match(/^\[GM SPOTLIGHT [—-] ([^:\]]+?)(?::\s*([\s\S]+?))?\]$/);
  if (!m) return null;
  return { name: m[1]!.trim(), steer: m[2]?.trim() || null };
}

export function buildInitiativeNorms(initiative: "subtle" | "normal" | "assertive"): string {
  const core = "Named characters (NPCs) have interior lives, their own wants and goals (see <character_agendas> when present), and the standing right to disagree, refuse, deflect, bargain, lie, withhold, leave, or initiate actions consistent with their agendas. They are not extensions of the player and should not simply follow the player's lead. They do not volunteer information their sheet says they guard.";
  const tail = initiative === "subtle"
    ? " Let this show mostly through reactions and interiority; NPCs rarely seize the initiative outright."
    : initiative === "assertive"
      ? " Each scene, at least one present character should actively advance a want: interject, make a demand, escalate, or act on their own agenda rather than waiting on the player."
      : " When a present character has a pending want, let them pursue it rather than passively waiting on the player.";
  return `## Character Autonomy\n\n${core}${tail}`;
}

/** The recency-end PC-authority reminder (see its call site); exported so the Engine dialog's
 *  "Injected text" viewer renders the same template (promptFragments.ts). */
export function buildPlayerAuthorityReminder(playerCharacterKeys: string[]): string {
  return `<player_authority>${playerCharacterKeys.join(" / ")} is the PLAYER's character, and every listed name is the same person. Do not write their dialogue (not even one word), decisions, voluntary actions, thoughts, or feelings, and do not operate their powers or devices for them. Render the world up to their skin, then stop at their decision point and return the floor.</player_authority>`;
}

export function buildWorldAuthorityNorms(playerCharacterKeys?: string[] | string): string {
  // Accepts the full alias list (2026-08-24): the old single-name form left
  // every alias after [0] unprotected — "Ryn" was never named in the norms,
  // so the PC's alternate identity read as a normal NPC to the render model.
  const keys = (typeof playerCharacterKeys === "string" ? [playerCharacterKeys] : playerCharacterKeys ?? [])
    .map((k) => k.trim()).filter(Boolean);
  const pc = keys[0] || "the player character";
  const aliases = keys.length > 1 ? ` — and every one of these names is the SAME player character: ${keys.join(", ")}` : "";
  return `## World Authority and Player Will\n\nWorld time belongs to the narrator. Yielding the floor governs conversation, and reality keeps moving: interruptions, arrivals, messages, weather, and events elsewhere move at any moment, including mid-scene. When a <due_beats> event is supplied, it HAPPENS in that reply as an event in motion, never as an offer, a question, or something deferred.\n\n${pc}'s will is inviolate${aliases}: never write their choices, words, thoughts, feelings, or voluntary actions. That includes one-word interjections, summaries or echoes of what they "would" say, and operating their powers, tools, or devices on their behalf. The world reaches their body and senses: blows land, blasts throw them, and sensations register. Write the world's impact up to their skin, never past their will. When the scene reaches a point where only ${pc} can speak, choose, or act, END THE REPLY at that moment of decision and return the floor. A reply that stops at their decision is complete. A reply that answers for them is wrong.`;
}

export function isPlayerCharacter(name: string, keys: string[]): boolean {
  const candidate = name.trim().toLocaleLowerCase();
  return Boolean(candidate) && keys.some((key) => key.trim().toLocaleLowerCase() === candidate);
}

// Deliberately narrow: bare "call"/"contact"/"comm" fire constantly in RP
// prose ("eye contact", "called out", "calm"→comms typos) and would inject the
// absent-contacts block on a large share of ordinary turns. Require an
// unambiguous comms noun, a texting/messaging verb form, or a phone-anchored
// call phrase.
export function hasCommsReference(text: string): boolean {
  if (/\b(?:phone(?:s|d)?|voicemail|voice\s*mail|texts?|texted|texting|messag(?:e|es|ed|ing)|missed\s+calls?|call(?:s|ed|ing)?\s+(?:back|from)|callback|dial(?:s|ed|ing)?|inbox|burner)\b/i.test(text)) return true;
  // Transitive call-with-a-Name ("Call Doran", "he calls Nessa") is the
  // phone idiom; case-sensitivity keeps "called out"/"called it a night"/
  // "called her a liar" from firing.
  return /\b[Cc]all(?:s|ed|ing)?\s+\p{Lu}/u.test(text);
}

/** Offscreen-flow (2026-07-17): the per-NPC OFFSCREEN MEMORY block. Offscreen
 *  events are canon the moment they apply — but retrieval only surfaced them by
 *  keyword luck, so behind-the-scenes state stagnated. This block injects each
 *  relevant character's recent offscreen facts DETERMINISTICALLY (like agendas):
 *  relevant = present ∪ present-unaware ∪ comms-pulled contacts; facts are
 *  newest-first from the ACTIVE ledger (superseded entries excluded upstream).
 *  Epistemic discipline is inline per fact — only listed knowers may reference
 *  or act on it. Pure function; exported for tests. */
export function renderOffscreenMemoryBlock(
  ledger: Array<{ name: string; knownBy: string[]; window: string | null; createdAt: string }>,
  relevantCharacters: string[],
  maxFacts = 12,
  maxChars = 2200,
): { block: string | null; facts: number; characters: number } {
  const relevant = relevantCharacters.map((n) => n.trim()).filter(Boolean);
  if (relevant.length === 0 || ledger.length === 0) return { block: null, facts: 0, characters: 0 };
  const relevantLower = new Set(relevant.map((n) => n.toLocaleLowerCase()));
  const lines: string[] = [];
  const touched = new Set<string>();
  let used = 0;
  for (const event of ledger) { // ledger arrives newest-first
    if (lines.length >= maxFacts) break;
    const knowers = event.knownBy.filter((k) => relevantLower.has(k.toLocaleLowerCase()));
    if (knowers.length === 0) continue;
    const summary = event.name.replace(/^Offscreen — /, "");
    const line = `- (known to: ${event.knownBy.join(", ")})${event.window ? ` [${event.window}]` : ""} ${summary}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    for (const k of knowers) touched.add(k.toLocaleLowerCase());
  }
  if (lines.length === 0) return { block: null, facts: 0, characters: 0 };
  const header = "These offscreen events HAVE HAPPENED (established canon the player has not witnessed). Characters listed as knowing a fact may reference it, act on it, and let it color their behavior; characters NOT listed must not reference or hint at it.";
  return { block: `${header}\n${lines.join("\n")}`, facts: lines.length, characters: touched.size };
}

// A present character's want carried unengaged to STALE_WANT_PRESSURE is what the
// agenda line renders as "wants URGENTLY (will act on this now)". When canon has
// quietly settled its premise the composer keeps acting on a dead want (a lost
// bag, 2026-09-26) — surface it as a context note so the player sees
// it in the turn's context dropdown instead of in a week of the same question.
export function staleWantNote(entries: Array<{ name: string; sheet: DriveSheet }>): string | null {
  const items: string[] = [];
  for (const { name, sheet } of entries) {
    for (const w of sheet.wants) {
      if (w.blocked || w.pressure < STALE_WANT_PRESSURE) continue;
      const text = w.text.trim();
      items.push(`${name} ${w.id} "${text.length > 90 ? `${text.slice(0, 90)}…` : text}" (pressure ${w.pressure}${w.sinceTurn != null ? `, unaddressed since turn ${w.sinceTurn}` : ""})`);
    }
  }
  if (items.length === 0) return null;
  const shown = items.slice(0, 4).join("; ") + (items.length > 4 ? ` (+${items.length - 4} more)` : "");
  return `Stale want${items.length > 1 ? "s" : ""}: ${shown} — the composer is told to act on ${items.length > 1 ? "these" : "this"} now; if canon has settled it, remove it in the drives editor or let the drive worker's canon check drop it.`;
}

// Living World — one terse agenda line for a present character. Keeps the block
// attire-terse; the "if unengaged" clause converts agency from permission into a
// default the model must actively override (anti-sycophancy).
export function renderAgendaLine(name: string, sheet: DriveSheet, isUnaware: boolean, presentNames: string[]): string | null {
  // On-hold wants (2026-09-27) never drive the scene: the top want is the most pressing REACHABLE one, and
  // when every want is on hold the line says so without an "act now" clause.
  const topWant = sheet.wants.filter((w) => !w.blocked).sort((a, b) => b.pressure - a.pressure)[0];
  const heldWant = topWant ? undefined : [...sheet.wants].sort((a, b) => b.pressure - a.pressure)[0];
  const segments: string[] = [];

  if (isUnaware) {
    const doing = sheet.offpageProject?.trim() || topWant?.text?.trim();
    if (!doing && !topWant) return `${name} — (present but unaware; no agenda on file)`;
    if (doing) segments.push(`quietly: ${doing}`);
  } else {
    if (topWant) {
      const p = topWant.pressure;
      const phrase = p >= 4 ? "wants URGENTLY (will act on this now)" : p >= 2 ? "wants (mounting)" : "wants";
      segments.push(`${phrase}: ${topWant.text.trim()}`);
      segments.push(`if unengaged, pursues this`);
    } else if (heldWant) {
      segments.push(`on hold (out of reach for now): ${heldWant.text.trim()}`);
    }
  }

  // Dispositions toward up to two characters actually in the scene.
  const towardPresent = Object.entries(sheet.dispositions)
    .filter(([target]) => target !== name && presentNames.includes(target))
    .slice(0, 2)
    .map(([target, line]) => `toward ${target}: ${line.trim()}`);
  segments.push(...towardPresent);

  // How they guard a secret (behavior only — the "how", which shapes play).
  const guard = sheet.concealment.find((c) => c.behavior.trim().length > 0);
  if (guard) segments.push(`guards a secret: ${guard.behavior.trim()}`);

  if (segments.length === 0) return null;
  let line = `${name} — ${segments.join(" · ")}`;
  if (line.length > 320) line = `${line.slice(0, 317)}…`;
  return line;
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** The pre-composer phases timed per turn, in the order the note lists them. */
const PRE_COMPOSER_PHASES = ["settled replies", "context assembly", "antagonist intent", "contest classifier"] as const;
type PreComposerPhase = (typeof PRE_COMPOSER_PHASES)[number];

/** A promise's outcome as a value. Each overlapped phase is settled the moment it
 *  starts, so a phase that fails while the turn awaits another can never surface
 *  as an unhandled rejection; the consumer rethrows it at today's point. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

/** The response.context values a turn emitted, kept for its reply's snapshot. */
type ContextSnapshotPayload = {
  preview: ContextPreviewEntry[];
  debug: ContextAssemblyDebug;
  budgetTokens: number;
  notes: string[];
  infoNotes: string[];
  createdAt: string;
};

/** The completed event's message says when its reply's snapshot was stored, so a
 *  client can offer the Context action without a refetch. */
function withSnapshotFlag(message: ChatMessage, stored: boolean): ChatMessage {
  return stored ? { ...message, hasContextSnapshot: true } : message;
}

// Null-aware token sum for the continue accumulation: two unknowns stay
// unknown (null), one known side is kept as-is rather than coerced through 0.
function sumTokens(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Normalized "base" of a scene location for outline run-collapsing: lowercased,
 * whitespace-collapsed, truncated at the first comma / em–en dash / " - "
 * qualifier — "Harbor Cemetery, path toward gate" and "Harbor Cemetery —
 * north wall" are both runs of "harbor cemetery".
 */
function sceneBaseLocation(location: string): string {
  const normalized = location.toLowerCase().replace(/\s+/g, " ").trim();
  const cut = normalized.search(/,|—|–| - /);
  return (cut >= 0 ? normalized.slice(0, cut) : normalized).trim();
}

export function windowConversation<T extends { role: string; content: string }>(
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
  const coldStart = conversation.filter(m => m.role === "cold-start");
  const guaranteed = nonColdStart.slice(-budget.guaranteedMessageCount);
  // When the system prompt + retrieval budget already consume (almost) the whole
  // window, there is no room to backfill older turns. Returning the FULL
  // unwindowed conversation here sent every message (thousands of turns) to the
  // provider → ctx-overflow 400 / huge bill. Degrade to the minimal guaranteed
  // window instead — the same shape the backfillCount===0 path returns.
  if (remaining <= 0) return [...coldStart, ...guaranteed];

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

  if (backfillCount === 0) return [...coldStart, ...guaranteed];
  // Pin the window start to a stride boundary so the message prefix stays
  // byte-identical across consecutive turns (Anthropic prompt-cache hits on the
  // message breakpoint, bafc0ee). The pin may never
  // push the transcript past the effective budget. It used to re-include up to
  // CACHE_STRIDE − 1 older messages AFTER the backfill had stopped exactly at
  // the budget, so a long session's prompt ran tens of thousands of tokens over
  // the dial — a provider 400 on a 200K-window model. Rule now:
  //   1. the floor-aligned pin (adds older messages) is used only when it fits —
  //      by construction that is only when rawStart already sits on a boundary;
  //   2. otherwise the window aligns UP to the next boundary (drops up to
  //      CACHE_STRIDE − 1 of the oldest backfilled messages, never overshoots),
  //      but only while it keeps at least 75 % of the backfill — so a normal
  //      window (~170 messages on typical dials) keeps its stable prefix
  //      at ≤ 11 % under-fill, while a small window stays exact rather than
  //      losing most of its history to alignment;
  //   3. else the window starts at the raw start (exact budget, no alignment).
  const CACHE_STRIDE = 20;
  const MIN_KEPT_FRACTION = 0.75;
  const rawStart = older.length - backfillCount;
  const floorStart = Math.max(0, Math.floor(rawStart / CACHE_STRIDE) * CACHE_STRIDE);
  let floorExtraTokens = 0;
  for (let i = floorStart; i < rawStart; i++) floorExtraTokens += estimateTokens(older[i]!.content);
  let start = rawStart;
  if (backfillTokens + floorExtraTokens <= remaining) {
    start = floorStart;
  } else {
    const ceilStart = Math.ceil(rawStart / CACHE_STRIDE) * CACHE_STRIDE;
    const kept = older.length - ceilStart;
    if (ceilStart < older.length && kept >= Math.ceil(backfillCount * MIN_KEPT_FRACTION)) start = ceilStart;
  }
  return [...coldStart, ...older.slice(start), ...guaranteed];
}

function extractInlineThinking(text: string): { thinking: string | null; content: string } {
  const blocks: string[] = [];
  const cleaned = text.replace(/<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>\s*/g, (_, block) => { blocks.push(block); return ""; });
  return { thinking: blocks.length ? blocks.join("\n") : null, content: cleaned };
}
