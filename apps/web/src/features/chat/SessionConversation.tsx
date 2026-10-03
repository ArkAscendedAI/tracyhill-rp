import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ChatMessage, PromptTemplate, SceneOutlineEntry, SessionDetailResponse, SessionStats, SessionSummary } from "@tracyhill-rp/contracts";
import { IMAGE_MODELS, composerEffortOnWire, estimateCacheSavingsUsd, estimateUsageCostUsd, getChatModel, supportsOpenAIFastMode, wireChatModelId } from "@tracyhill-rp/model-catalog";

import { ApiError } from "../../shared/api/client";
import { useRollOverride } from "./useRollOverride";
import { renderMarkdown, attachCodeBlockCopyHandlers } from "../../shared/markdown/renderMarkdown";
import { NumericInput } from "../../shared/ui/NumericInput";
import { EngineSettingsDialog } from "./EngineSettingsDialog";
import { Popover } from "../../shared/ui/Popover";

import {
  deleteChatMessage,
  editSceneMetadata,
  exportSessionMarkdown,
  getMessageContextSnapshot,
  getSceneOutline,
  getSessionDetail,
  generateSessionImage,
  isChatChangedRefusal,
  regenerateMessageStream,
  reconcileMessageRange,
  refreshMessageRange,
  resolveSceneValidation,
  stopSessionResponse,
  streamSessionResponse,
  switchMessageVariant,
  truncateChatMessages,
  updateChatMessage,
} from "./chatApi";
import {
  SPOTLIGHT_PENDING_PREFIX,
  buildSpotlightPendingLabel,
  createEmptySessionStreamState,
  isPendingPromptPersisted,
  mapStoredAttachmentToInput,
  replayFloorAfterRemoval,
  type ComposerAttachmentInput,
  type SessionStreamState,
} from "./sessionStreamState";
import {
  createPromptTemplate,
  deletePromptTemplate,
  getPromptTemplates,
  updatePromptTemplate,
} from "../templates/templateApi";
import { buildAvailableChatModels, getProviderKeys, getSavedChatModel } from "../auth/providerKeyApi";
import { enqueueWizardRun, getActiveWizardRuns } from "../wizard/wizardApi";
import { updateSession } from "../workspace/workspaceApi";
import { useCampaigns } from "../campaigns/useCampaigns";
import { enqueueRecap, getAuditFindings, getRecapStatus } from "../pipeline/pipelineApi";
import { AuditFindingsDialog } from "../pipeline/AuditFindingsDialog";
import { CampaignAuditDialog } from "../pipeline/CampaignAuditDialog";
import { emitGlobalToast } from "../../shared/ui/Toast";
import { PipelineQueuePill } from "../pipeline/PipelineQueuePill";
import { getThreadIndexEntries } from "../lorebook/lorebookApi";
import { getDrives } from "../drives/drivesApi";
import { getWorldStatus } from "../world/worldApi";
import { ScheduledBeatsList } from "../world/ScheduledBeatsList";
import { WorldClockLine } from "../world/WorldClockLine";
import { WorldTickDialog } from "../world/WorldTickDialog";
import { useSessionDetail } from "./useSessionDetail";
import { autoRegenReplay, describeSkippedAutoRegen, describeUnreadableSpotlightReplay, resolveAutoRegenTarget } from "./sceneResolution";
import { resolveDisplayedContextSettings } from "./contextSettingsDisplay";
import {
  GAP_FILL_FAILED_TEXT,
  GAP_LOADING_TEXT,
  carryReachesSessionStart,
  carryWindowIntoOlder,
  collectGapRows,
  findWindowGap,
  gapMarkerIndexes,
  gapsAfterWindowChange,
  heldOlderAnswer,
  loadOlderLabel,
  mergeTranscript,
  mergeWindowGap,
  type WindowGap,
} from "./transcriptWindow";
import { CastCardsContent } from "./CastCardsContent";
import { ATTIRE_NONE_TEXT, AUTO_REGEN_OLDER_REPLY_HINT } from "./chatCopy";
import { ContextPreviewContent } from "./ContextPreviewContent";
import { SceneEditForm } from "./SceneEditForm";
import { sceneEditAfterSave, sceneEditFields, sceneEditPayload, sceneEditProblem, type SceneEditFields, type SceneEditPayload, type SceneEditResult } from "./sceneEdit";
import { ATTIRE_DESCRIPTION_MAX, MESSAGE_EDIT_MAX, PROMPT_TEMPLATE_CONTENT_MAX, PROMPT_TEMPLATE_NAME_MAX, imagePromptProblem } from "./chatInputLimits";
import { SceneOutlineContent } from "./SceneOutlineContent";
import { ThreadsContent, parseThreadTracker } from "./ThreadsContent";
import { RECAP_QUEUED_TOAST, StorySoFarSection } from "./StorySoFarSection";
import { chipContextEmptyText, chipContextSource, contextPreviewTitle, liveContextView, newestReplyId, snapshotContextView, type ContextPreviewView, type ContextReply } from "./contextPreviewView";
import { resolveSpotlightChoice } from "./spotlightChoice";
import { addCosts, describeMessageCostBasis, describeSessionCostBasis, sessionOverheadCost } from "./costEstimates";
import { describeAlwaysOnThinking, describeFastTurn } from "./dialLabels";
import { attachmentContentProblem, describeDroppedAttachments, isEnterKey, mergeAttachments } from "./composerInput";
import { composerRestoreStash, failedSendRestore, spotlightFieldsAfterRestore, type FailedSendRestore } from "./composerRestore";
import { removalAfterFailure, replayTextLost, rowStillThere } from "./replayRestore";
import { showTemperatureControlFor } from "./temperatureGate";
import { buildChatModelGroups } from "./chatModelGroups";
import { effectiveThinkingBudget, thinkingBudgetBounds } from "./thinkingBudget";
import { EffortSelect, effortLabel } from "./effortSelect";
import { describeNotifyUnavailable, isNotifyOnCompleteEnabled, notifyTurnComplete, setNotifyOnCompleteEnabled } from "./completionNotifier";
import { getCharacterAttire, updateCharacterAttire } from "./characterAttireApi";
import { Icon } from "../../shared/ui/Icon";
import { Dialog } from "../../shared/ui/Dialog";
import { cutPlan, messagesPhrase } from "./truncateGuard";

type SessionConversationProps = {
  session: SessionSummary;
  streamState: SessionStreamState;
  updateSessionStream: (sessionId: string, updater: SessionStreamState | ((current: SessionStreamState) => SessionStreamState)) => void;
  onOpenDrives?: (campaignId: string, character?: string) => void;
  /** The signed-in user is an admin: the Engine dialog's adversarial-world rows are editable. */
  isAdmin: boolean;
};

type MessageListActions = {
  copyMessage(m: ChatMessage): void;
  startEdit(m: ChatMessage): void;
  resendFrom(i: number): void;
  regenerateFrom(i: number): void;
  switchVariant(m: ChatMessage, direction: -1 | 1): void;
  saveEdit(m: ChatMessage): void;
  cancelEdit(): void;
  resolveScene(messageId: string, choice: "main" | "validator" | "user", present?: string, unaware?: string): Promise<void>;
  saveSceneEdit(messageId: string, edits: SceneEditPayload): Promise<SceneEditResult>;
  openContext(m: ChatMessage, anchor: HTMLElement): void;
};

// NOTE: AppShell mounts this component with `key={activeSession.id}`, and that
// remount is LOAD-BEARING — every piece of instance state below (draft, search,
// edit/confirm dialogs, windowing buffers, the localStorage-seeded rollOverride
// initializer, the stash consumption above) assumes `session.id` never changes
// for a mounted instance. There is deliberately no "reset on session switch"
// effect any more (it could only ever run once, at mount).
export function SessionConversation({ session, streamState, updateSessionStream, onOpenDrives, isAdmin }: SessionConversationProps) {
  const queryClient = useQueryClient();
  const detail = useSessionDetail(session.id);
  const [draft, setDraft] = useState(() => composerRestoreStash.get(session.id)?.draft ?? "");
  const [attachments, setAttachments] = useState<ComposerAttachmentInput[]>(() => composerRestoreStash.get(session.id)?.attachments ?? []);
  // Mirror of `attachments` for the async add paths (paste / file picker /
  // template): they finish after an await, when the render-time closure may be
  // stale. The state itself is updated through the updater form; the ref only
  // feeds the "N files not added" toast.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // Whether THIS instance is still mounted — decides between setState and the
  // stash when a send's finally block runs after a session switch.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    composerRestoreStash.delete(session.id);
    return () => { mountedRef.current = false; };
  }, [session.id]);
  // Owner roll override (🎲 next to Send): default off, applies to the NEXT
  // turn-generating action (send OR regenerate), and disarms after it succeeds —
  // a persistent god-mode left on by accident would silently defeat the whole
  // adversarial layer. The ARMED state is persisted per-session in localStorage:
  // it must survive page reloads and remounts, because an armed override that
  // silently disarms is how an unprotected turn went out seven seconds
  // after a reload on 2026-08-01 (the state lived only in React memory). On
  // failure it stays armed alongside the restored draft.
  const { armed: rollOverride, setArmed: setRollOverride, getOwner: getRollArmOwner, consume: consumeRollOverride } = useRollOverride(session.id);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [startingWizardRun, setStartingWizardRun] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [savingSessionSettings, setSavingSessionSettings] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Flat (not keyed by session id): the shell remounts per session, so an
  // instance only ever mutates its own session's messages.
  const [mutatingMessageId, setMutatingMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const editInitialHeightRef = useRef<number | null>(null);
  const editDraftRef = useRef("");
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templateContentDraft, setTemplateContentDraft] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<null | { type: "delete" | "truncate"; messageId: string; label: string }>(null);
  // A Resend that removes more than two messages asks first; the answer resolves the waiting flow.
  const [confirmingRemoval, setConfirmingRemoval] = useState<null | { count: number; action: string }>(null);
  const removalAnswerRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [confirmingTemplateDelete, setConfirmingTemplateDelete] = useState<PromptTemplate | null>(null);
  const [imageModelId, setImageModelId] = useState(IMAGE_MODELS[0]?.id ?? "gpt-image-2");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuProvider, setModelMenuProvider] = useState<string | null>(null);
  const [localSearchOpen, setLocalSearchOpen] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [statusBarOpen, setStatusBarOpen] = useState(() => typeof window === "undefined" ? true : window.innerWidth > 768);
  const [sessionPopoverOpen, setSessionPopoverOpen] = useState(false);
  // "Notify me": background-tab completion notification opt-in.
  const [notifyEnabled, setNotifyEnabled] = useState(isNotifyOnCompleteEnabled);
  const [enginePopoverOpen, setEnginePopoverOpen] = useState(false);
  const [previewPopoverOpen, setPreviewPopoverOpen] = useState(false);
  const [campaignPopoverOpen, setCampaignPopoverOpen] = useState(false);
  const [threadsPopoverOpen, setThreadsPopoverOpen] = useState(false);
  const [findingsDialogOpen, setFindingsDialogOpen] = useState(false);
  const [castPopoverOpen, setCastPopoverOpen] = useState(false);
  const [spotlightMenuOpen, setSpotlightMenuOpen] = useState(false);
  // A hand-off that failed after a switch away waits in the stash with the composer text.
  const [spotlightChar, setSpotlightChar] = useState(() => composerRestoreStash.get(session.id)?.spotlight?.characterName ?? "");
  const [spotlightSteer, setSpotlightSteer] = useState(() => composerRestoreStash.get(session.id)?.spotlight?.steer ?? "");
  // Mirror of the popover's fields for a failed hand-off's restore, which runs after an await.
  const spotlightFieldsRef = useRef({ characterName: spotlightChar, steer: spotlightSteer });
  spotlightFieldsRef.current = { characterName: spotlightChar, steer: spotlightSteer };
  const [worldDialogOpen, setWorldDialogOpen] = useState(false);
  const [beatsPopoverOpen, setBeatsPopoverOpen] = useState(false);
  const [scenesPopoverOpen, setScenesPopoverOpen] = useState(false);
  const [sceneSearch, setSceneSearch] = useState("");
  // Scene jump (historical view): when the Scenes popover targets a message
  // outside the loaded window, an after-cursor window is fetched and rendered
  // INSTEAD of the live transcript until the user exits back to latest.
  const [historicalView, setHistoricalView] = useState<{
    pages: ChatMessage[];
    anchorId: string | null;
    hasNewer: boolean;
    newestSortOrder: number | null;
    hasOlder: boolean;
    oldestSortOrder: number | null;
  } | null>(null);
  const [historicalLoading, setHistoricalLoading] = useState<"jump" | "older" | "newer" | null>(null);
  const sessionChipRef = useRef<HTMLButtonElement | null>(null);
  const engineChipRef = useRef<HTMLButtonElement | null>(null);
  const previewChipRef = useRef<HTMLButtonElement | null>(null);
  const campaignChipRef = useRef<HTMLButtonElement | null>(null);
  const threadsChipRef = useRef<HTMLButtonElement | null>(null);
  const castChipRef = useRef<HTMLButtonElement | null>(null);
  const spotlightBtnRef = useRef<HTMLButtonElement | null>(null);
  const beatsChipRef = useRef<HTMLButtonElement | null>(null);
  const scenesChipRef = useRef<HTMLButtonElement | null>(null);
  const [auditDialogOpen, setAuditDialogOpen] = useState(false);
  const [sendError, setSendError] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const messageRefs = useRef<Record<string, HTMLElement | null>>({});
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const messageActionsRef = useRef<MessageListActions>(null!);
  const providerConfig = useQuery({
    queryKey: ["provider-keys"],
    queryFn: getProviderKeys,
  });
  const availableChatModels = useMemo(() => buildAvailableChatModels(providerConfig.data), [providerConfig.data]);
  const selectedModel = getSavedChatModel(session.modelId, providerConfig.data);
  const modelUnavailable = Boolean(providerConfig.data && !availableChatModels.some((model) => model.id === session.modelId));
  // The catalog row behind the picker's model — the thinking/fast-mode flags the
  // Session popover reads (thinkingAlwaysOn, thinkingDefaultOn, thinkingOffMaxEffort,
  // fastModeInputCostPerMillionTokens) live on the catalog type, not on the
  // picker's AvailableChatModel subset. Custom-endpoint models are not in the
  // catalog and legitimately have none of them (null here, as before).
  const selectedCatalogModel = selectedModel ? getChatModel(selectedModel.id) : null;
  // The effort the turn sends, for the Session chip; the popover's select shows the same.
  const sessionEffortOnWire = selectedCatalogModel ? composerEffortOnWire(selectedCatalogModel, session.effort, session.thinkingMode) : null;
  const isWizardSession = session.sessionType === "wizard";
  // "sending" for UI purposes ends at response.completed — the server keeps the
  // stream open while the scene validator runs (seconds to tens of seconds),
  // and the composer used to stay locked with a stuck Stop button for all of it.
  const sending = streamState.sending && !streamState.completed;
  const stopping = sending && streamState.stopRequested;
  const visibleError = streamState.error || sendError;

  // --- Transcript windowing ---
  // The detail query only carries the newest window; older windows the user has
  // loaded live in a local buffer so streaming-completion invalidations (which
  // refetch ONLY the newest window) never drop them. Older pages are filtered
  // against the current window start so a post-mutation window shift can't
  // double-render a message.
  const [olderPages, setOlderPages] = useState<ChatMessage[]>([]);
  const historyBuffersRef = useRef({ olderPages, historicalView });
  historyBuffersRef.current = { olderPages, historicalView };
  const historyNavigationRef = useRef(0);
  const messageMutationGenerationRef = useRef(0);
  // hasOlder of the LAST older fetch (null until one happens) — once pages are
  // loaded, the default window's hasOlder refers to messages we already hold.
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The spans a newer window skipped over while older pages were held, being filled from the server. The object
  // is the fill's ticket: every newer detail read replaces it, which supersedes the older fill (the effect below).
  const [gapFill, setGapFill] = useState<{ gaps: WindowGap[] } | null>(null);
  // Bumped whenever the older buffer is dropped, so a Load older already in flight cannot land above the newest window
  // and open a new hole.
  const olderEpochRef = useRef(0);
  // The row at the top of the viewport when a gap fill lands, restored after the commit so the reader's place holds.
  const readingAnchorRef = useRef<{ id: string; offset: number } | null>(null);
  const scrollAdjustRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const defaultWindow: ChatMessage[] = detail.data?.messages ?? [];
  const windowHasOlder = detail.data?.pagination.hasOlder ?? false;
  // The newest window is the newest 200 rows by count, so a completed turn's refetch
  // installs a window that starts two rows later. While older pages are loaded, the rows that
  // slid out move into the older buffer here, during render, so no frame commits the gap.
  // A window that starts past the previous one's end carries the whole previous window and
  // opens a gap the effect below fills; carrying the first row of a window that began the
  // session records Load older's answer as false.
  const [windowSeen, setWindowSeen] = useState({ messages: detail.data?.messages, hasOlder: windowHasOlder });
  const windowChanged = windowSeen.messages !== detail.data?.messages;
  if (windowChanged || windowSeen.hasOlder !== windowHasOlder) {
    setWindowSeen({ messages: detail.data?.messages, hasOlder: windowHasOlder });
    if (windowChanged) {
      const previousWindow = windowSeen.messages ?? [];
      const gap = findWindowGap(olderPages, previousWindow, defaultWindow, loadingOlder);
      setOlderPages((current) => (gap ? mergeWindowGap(current, previousWindow, []) : carryWindowIntoOlder(current, previousWindow, defaultWindow, loadingOlder)));
      if (carryReachesSessionStart(olderPages, previousWindow, windowSeen.hasOlder, defaultWindow, loadingOlder)) setOlderHasMore(false);
      setGapFill((current) => {
        const gaps = gapsAfterWindowChange(current?.gaps ?? [], gap, defaultWindow);
        return gaps.length ? { gaps } : null;
      });
    }
  }
  const pagination = detail.data?.pagination ?? { hasOlder: false, oldestSortOrder: null };
  const sessionStats: SessionStats | null = detail.data?.sessionStats ?? null;
  // NOTE: the oldest LOADED message may lack the scene divider that a scene-
  // bearing message further back established — scene context carries forward
  // in-world, so the first loaded turns can render without a divider. Accepted
  // trade-off; loading older windows restores the dividers.
  const messages: ChatMessage[] = useMemo(
    () => mergeTranscript(olderPages, defaultWindow),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaultWindow is detail.data?.messages
    [detail.data?.messages, olderPages],
  );
  // The last Load older's answer holds only while the older buffer shows rows above the window;
  // dropped here (render-time, like windowSeen) so it cannot come back when rows reach the buffer again.
  const olderAnswer = heldOlderAnswer(olderHasMore, messages, defaultWindow, loadingOlder);
  // After a window change React renders again at once with the carried buffer; deciding then keeps the order right.
  if (!windowChanged && olderAnswer !== olderHasMore) setOlderHasMore(olderAnswer);
  const hasOlder = olderAnswer ?? pagination.hasOlder;
  const olderRemaining = Math.max(0, (sessionStats?.activeMessageCount ?? session.messageCount) - messages.length);
  // The turn a manual attire edit is stamped at: the live tail's sortOrder + 1
  // (the default window always holds the tail, so this is the session max).
  const nextTurn = (defaultWindow[defaultWindow.length - 1]?.sortOrder ?? -1) + 1;
  const activeWizardRuns = useQuery({
    queryKey: ["wizard-active"],
    queryFn: getActiveWizardRuns,
    enabled: isWizardSession,
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running") ? 250 : false,
  });
  const promptTemplates = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: getPromptTemplates,
    enabled: showTemplateDialog && !isWizardSession,
  });
  const campaign = detail.data?.campaign ?? null;
  // Deployment DEFAULT_MODEL_ID override (server-resolved, from the provider-keys
  // bootstrap). Mirrors the server's buildDefaults(): when set, it replaces every
  // chat-model dial default below so the Engine panel shows what the workers will
  // actually run. Campaign/session values still win.
  const defaultModelOverride = providerConfig.data?.defaultModelOverride ?? null;
  // Contract defaults, then the override on the contract's chat-model dial list, then
  // the session's overrides — the engine's own resolution order (contextSettingsDisplay.ts).
  const resolvedContextSettings = useMemo(() => resolveDisplayedContextSettings(session.contextOverrides, defaultModelOverride), [session.contextOverrides, defaultModelOverride]);
  const localSearchNeedle = localSearchQuery.trim().toLocaleLowerCase();
  // The user message is persisted server-side as soon as the stream request lands,
  // so any session-detail refetch mid-stream (window-focus refetch, scene-validation
  // invalidation, the response.completed refetch) pulls the real copy in while the
  // optimistic one is still rendered. Skip the optimistic copy once the persisted
  // duplicate exists anywhere newer than the pre-send tail — NOT only when it is
  // the LAST message, which stopped being true the moment the reply landed.
  const pendingAlreadyPersisted = isPendingPromptPersisted(messages, streamState.pendingPrompt, streamState.pendingAfterSortOrder);

  const renderedMessages: ChatMessage[] = useMemo(() => [
    ...messages,
    ...(streamState.pendingPrompt && !pendingAlreadyPersisted ? [{
      id: "pending-user",
      sessionId: session.id,
      role: "user" as const,
      content: streamState.pendingPrompt,
      thinking: null,
      modelId: null,
      usage: null,
      stopReason: null,
      stopDetails: null,
      fastMode: false,
      rollOverride: false,
      servedModel: null,
      directiveKind: streamState.pendingPrompt.startsWith(SPOTLIGHT_PENDING_PREFIX) ? "gm_spotlight" as const : null,
      sceneData: null,
      sceneValidator: null,
      sceneResolution: null,
      overhead: null,
      variantGroupId: null, variantIndex: 0, variantCount: 1, variantSiblingIds: [],
      sortOrder: Number.MAX_SAFE_INTEGER - 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attachments: streamState.pendingAttachments.map((attachment, index) => ({
        id: `pending-${index}`,
        messageId: "pending-user",
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        contentMode: attachment.contentMode,
        content: attachment.content,
        createdAt: new Date().toISOString(),
      })),
      generatedImages: [],
    }] : []),
    ...(streamState.streamingText || streamState.streamingThinking ? [{
      id: "pending-assistant",
      sessionId: session.id,
      role: "assistant" as const,
      content: streamState.streamingText,
      thinking: streamState.streamingThinking || null,
      modelId: session.modelId,
      usage: null,
      stopReason: null,
      stopDetails: null,
      fastMode: false,
      rollOverride: false,
      servedModel: null,
      directiveKind: null,
      sceneData: null,
      sceneValidator: null,
      sceneResolution: null,
      overhead: null,
      variantGroupId: null, variantIndex: 0, variantCount: 1, variantSiblingIds: [],
      sortOrder: Number.MAX_SAFE_INTEGER,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attachments: [],
      generatedImages: [],
    }] : []),
  ], [messages, streamState.pendingPrompt, streamState.pendingAttachments, streamState.streamingText, streamState.streamingThinking, pendingAlreadyPersisted, session.id, session.modelId]);
  // Scene-bearing messages were excluded from match count/navigation while
  // the highlight class still applied to them — so highlight, count, and next/prev
  // disagreed. Search every message's content like any other.
  const localSearchMatches = useMemo(() => localSearchNeedle
    ? renderedMessages
      .filter((message) => message.content.toLocaleLowerCase().includes(localSearchNeedle))
      .map((message) => message.id)
    : [], [renderedMessages, localSearchNeedle]);
  const activeSearchMessageId = localSearchMatches.length ? localSearchMatches[activeSearchIndex] ?? localSearchMatches[0] ?? null : null;
  const wizardReady = isWizardSession && (
    messages.some((message) => message.role === "assistant" && message.content.includes("[WIZARD_READY]"))
    || (streamState.streamingText?.includes("[WIZARD_READY]") ?? false)
  );
  const wizardRun = isWizardSession
    ? activeWizardRuns.data?.runs.find((run) => run.review.wizardSessionId === session.id && !run.approvedAt) ?? null
    : null;
  const campaignsQuery = useCampaigns();
  const [linkingCampaign, setLinkingCampaign] = useState(false);
  const linkCampaignMutation = useMutation({
    mutationFn: (campaignId: string) => updateSession(session.id, { campaignId }),
    onSuccess: () => {
      setLinkingCampaign(false);
      // ["workspace-state"] is the sidebar/session query key (useWorkspaceState);
      // ["workspace"] matched nothing, so the linked campaignId only reached the
      // `session` prop via the detail refetch + reconciliation effect.
      void queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      void queryClient.invalidateQueries({ queryKey: ["session-detail", session.id] });
    },
  });
  // (The pipeline-queue poll that used to live here fed only an unread boolean;
  // PipelineQueuePill in the header runs its own query.)
  // Story-so-far recap: manual-trigger pipeline kind. Poll while a
  // run is in flight so the completed markdown lands in the Campaign popover.
  const recapQuery = useQuery({
    queryKey: ["recap-status", session.campaignId, session.id],
    queryFn: () => getRecapStatus(session.campaignId!, session.id),
    enabled: !!session.campaignId && !isWizardSession && campaignPopoverOpen,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 3000 : false;
    },
  });
  const recapMutation = useMutation({
    mutationFn: () => enqueueRecap(session.campaignId!, session.id),
    onSuccess: () => {
      emitGlobalToast(RECAP_QUEUED_TOAST, "info");
      void queryClient.invalidateQueries({ queryKey: ["recap-status", session.campaignId, session.id] });
    },
    onError: (e) => emitGlobalToast(e instanceof Error ? e.message : "recap enqueue failed", "error"),
  });
  const recapBusy = recapMutation.isPending || recapQuery.data?.status === "queued" || recapQuery.data?.status === "running";
  const threadsQuery = useQuery({
    queryKey: ["lorebook-threads", session.campaignId],
    queryFn: () => getThreadIndexEntries(session.campaignId!),
    enabled: !!session.campaignId && !isWizardSession,
    refetchInterval: 60000,
  });
  const threadData = useMemo(() => parseThreadTracker(threadsQuery.data?.entries ?? []), [threadsQuery.data]);
  // A first read that failed marks the chip instead of counting 0 threads.
  const threadsUnread = threadsQuery.isError && !threadsQuery.data;
  // Context Preview: the live stream's context when this page
  // holds one, otherwise the newest reply's stored snapshot (after a reload); a reply card's
  // Context action opens the same view for that reply. Snapshots come from the server
  // (GET …/messages/:messageId/context) for replies flagged `hasContextSnapshot`.
  const chipSource = useMemo(() => chipContextSource(streamState, messages), [streamState, messages]);
  const liveContext = chipSource.kind === "live";
  const newestSnapshot = chipSource.kind === "snapshot" ? chipSource.reply : null;
  const newestSnapshotQuery = useQuery({
    queryKey: ["message-context", session.id, newestSnapshot?.messageId ?? null],
    queryFn: () => getMessageContextSnapshot(session.id, newestSnapshot!.messageId),
    enabled: Boolean(newestSnapshot) && !isWizardSession,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [contextReply, setContextReply] = useState<ContextReply | null>(null);
  const contextReplyAnchorRef = useRef<HTMLElement | null>(null);
  const contextReplyQuery = useQuery({
    queryKey: ["message-context", session.id, contextReply?.messageId ?? null],
    queryFn: () => getMessageContextSnapshot(session.id, contextReply!.messageId),
    enabled: Boolean(contextReply),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const chipContextView: ContextPreviewView | null = liveContext
    ? liveContextView(streamState)
    : newestSnapshot && newestSnapshotQuery.data ? snapshotContextView(newestSnapshotQuery.data.snapshot, newestSnapshot) : null;
  const replyContextView: ContextPreviewView | null = contextReply && contextReplyQuery.data ? snapshotContextView(contextReplyQuery.data.snapshot, contextReply) : null;
  // Audit findings queue: the ⚖ chip glows while any
  // flagged finding awaits a ruling; fast poll only while an executor runs.
  const auditFindingsQuery = useQuery({
    queryKey: ["audit-findings", session.campaignId],
    queryFn: () => getAuditFindings(session.campaignId!),
    enabled: !!session.campaignId && !isWizardSession,
    // Background polling on: a max-effort ruling run (~15+ min) can finish
    // while the tab is backgrounded; without this the shared cache stays stale
    // and the ⚖ chip (and the dialog reading the same cache) mislead.
    refetchInterval: (query) => (query.state.data?.processing ? 4000 : 60000),
    refetchIntervalInBackground: true,
  });
  const findingsOpenCount = auditFindingsQuery.data?.openCount ?? 0;
  const findingsProcessing = auditFindingsQuery.data?.processing ?? false;
  // Living World — Cast chip: drive sheets for the current campaign, shown for the
  // characters present in the latest scene (agenda visibility without scrolling).
  const drivesQuery = useQuery({
    queryKey: ["drives", session.campaignId],
    queryFn: () => getDrives(session.campaignId!),
    enabled: !!session.campaignId && !isWizardSession,
    refetchInterval: 60000,
  });
  const presentInScene = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const raw = messages[i]?.sceneData;
      if (!raw) continue;
      try {
        const s = JSON.parse(raw) as { present?: string[]; presentUnaware?: string[] };
        const present = (s.present ?? []).filter(Boolean);
        const unaware = (s.presentUnaware ?? []).filter((n) => n && !present.includes(n));
        return { present, unaware };
      } catch { /* keep scanning older scenes */ }
    }
    return { present: [] as string[], unaware: [] as string[] };
  }, [messages]);
  // Living World: world clock + scheduled beats for the campaign.
  const worldStatusQuery = useQuery({
    queryKey: ["world-status", session.campaignId],
    queryFn: () => getWorldStatus(session.campaignId!),
    enabled: !!session.campaignId && !isWizardSession,
    refetchInterval: 60000,
  });
  const dueBeats = useMemo(() => (worldStatusQuery.data?.beats ?? []).filter((b) => b.due), [worldStatusQuery.data]);
  // A first read that failed keeps its chip, marked, so the failure and its Retry can be seen (no false empty claim).
  const castUnread = drivesQuery.isError && !drivesQuery.data;
  const beatsUnread = worldStatusQuery.isError && !worldStatusQuery.data;
  const castCards = useMemo(() => {
    const byName = new Map((drivesQuery.data?.drives ?? []).map((d) => [d.characterName, d]));
    const rows: Array<{ name: string; unaware: boolean; rec: NonNullable<ReturnType<typeof byName.get>> }> = [];
    for (const name of [...presentInScene.present, ...presentInScene.unaware]) {
      const rec = byName.get(name);
      if (rec) rows.push({ name, unaware: presentInScene.unaware.includes(name), rec });
    }
    return rows;
  }, [drivesQuery.data, presentInScene]);
  // Spotlight targets (🎭): present characters first, then every other sheet-
  // holder. Computed in the body (not inside the popover) so the composer
  // button can drop a stale stored choice when it opens the popover, and so
  // the select and "Hand the scene" read ONE derived value.
  const spotlightPresentNames = [...presentInScene.present, ...presentInScene.unaware];
  const spotlightSheetNames = (drivesQuery.data?.drives ?? []).map((d) => d.characterName);
  const spotlightOptions = Array.from(new Set([...spotlightPresentNames, ...spotlightSheetNames]));
  const spotlightChoice = resolveSpotlightChoice(spotlightChar, spotlightPresentNames, spotlightOptions);
  // Scene/date outline — fetched lazily when the popover opens; the
  // payload is independent of the transcript window so it covers ALL scenes.
  const sceneOutlineQuery = useQuery({
    queryKey: ["scene-outline", session.id],
    queryFn: () => getSceneOutline(session.id),
    enabled: scenesPopoverOpen && !isWizardSession,
  });
  // Group consecutive same-date scene breaks so the popover reads as a dated
  // outline; the search box filters on location/date/time before grouping so
  // empty dates drop out naturally.
  const sceneGroups = useMemo(() => {
    const needle = sceneSearch.trim().toLowerCase();
    const groups: Array<{ date: string | null; entries: SceneOutlineEntry[] }> = [];
    for (const entry of sceneOutlineQuery.data?.entries ?? []) {
      if (needle && ![entry.location, entry.date ?? "", entry.time ?? ""].some((v) => v.toLowerCase().includes(needle))) continue;
      const last = groups[groups.length - 1];
      if (last && last.date === entry.date) last.entries.push(entry);
      else groups.push({ date: entry.date, entries: [entry] });
    }
    return groups;
  }, [sceneOutlineQuery.data, sceneSearch]);
  const rollingDiffOverhead = detail.data?.rollingDiffOverhead ?? [];
  // Stats prefer the server's whole-session sessionStats aggregate —
  // a local fold over the now-windowed messages array would silently shrink to
  // the loaded window. The fold remains as a fallback for older servers.
  const usageTotals = useMemo(() => sessionStats ? {
    inputTokens: sessionStats.inputTokens,
    outputTokens: sessionStats.outputTokens,
    totalTokens: sessionStats.totalTokens,
    cacheReadTokens: sessionStats.cacheReadTokens,
    cacheWriteTokens: sessionStats.cacheWriteTokens,
    reasoningTokens: sessionStats.reasoningTokens,
  } : sumMessageUsage(messages), [sessionStats, messages]);
  const overheadCost = useMemo(() => sessionOverheadCost(sessionStats, messages, rollingDiffOverhead), [sessionStats, messages, rollingDiffOverhead]);
  const estimatedCost = useMemo(() => addCosts(sessionStats ? sessionStats.messageCost : sumMessageCost(messages, session.cacheTtl), overheadCost), [sessionStats, messages, session.cacheTtl, overheadCost]);
  const cacheHitRate = useMemo(() => calculateCacheHitRate(usageTotals), [usageTotals]);
  const cacheSavings = useMemo(() => sessionStats ? sessionStats.cacheSavings : calculateCacheSavings(messages, session.cacheTtl), [sessionStats, messages, session.cacheTtl]);
  const estimatedContextTokens = useMemo(() => estimateSessionContextTokens(messages, campaign, campaign ? resolvedContextSettings.contextBudgetTokens : undefined, sessionStats, hasOlder), [messages, campaign, resolvedContextSettings.contextBudgetTokens, sessionStats, hasOlder]);
  const contextWarning = useMemo(() => buildContextLimitWarning(selectedModel, estimatedContextTokens), [selectedModel, estimatedContextTokens]);
  const contextMetrics = useMemo(() => computeContextMetrics(messages, campaign, sessionStats), [messages, campaign, sessionStats]);
  const chatModelGroups = useMemo(() => buildChatModelGroups(availableChatModels), [availableChatModels]);
  // Capability + thinking-MODE gate (temperatureGate.ts): a dial the runtime
  // would ignore is never shown; Google effort models show it only while
  // thinking is Off, the one mode in which their runtime forwards it.
  const showTemperatureControl = showTemperatureControlFor(selectedModel, session.thinkingMode);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (modelMenuRef.current && target instanceof Node && !modelMenuRef.current.contains(target)) {
        setModelMenuOpen(false);
        setModelMenuProvider(null);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("touchstart", onPointerDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("touchstart", onPointerDown);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        // A modal owns its own Ctrl/⌘F (the Engine dialog focuses its settings search); focus is
        // trapped inside the card while one is open, so the target tells us (2026-09-24).
        if ((event.target as HTMLElement | null)?.closest?.(".dialog-card")) return;
        event.preventDefault();
        setLocalSearchOpen(true);
        return;
      }
      if (event.key === "Escape" && localSearchOpen) {
        event.preventDefault();
        setLocalSearchOpen(false);
        setLocalSearchQuery("");
        setActiveSearchIndex(0);
        return;
      }
      if (event.key === "Enter" && localSearchOpen && localSearchMatches.length) {
        // Only cycle matches from the search box (or a non-editable focus).
        // The composer's own Enter-to-send handler runs first, and this window
        // listener used to ALSO advance the match and scroll the transcript
        // away from the send — preventDefault doesn't stop propagation.
        const target = event.target;
        if (target instanceof HTMLTextAreaElement) return;
        if (target instanceof HTMLInputElement && target !== searchInputRef.current) return;
        event.preventDefault();
        setActiveSearchIndex((current) => {
          if (event.shiftKey) return current <= 0 ? localSearchMatches.length - 1 : current - 1;
          return current >= localSearchMatches.length - 1 ? 0 : current + 1;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [localSearchMatches.length, localSearchOpen]);

  useEffect(() => {
    if (!localSearchOpen) return;
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [localSearchOpen]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [localSearchQuery]);

  useEffect(() => {
    if (!localSearchMatches.length) return;
    if (activeSearchIndex < localSearchMatches.length) return;
    setActiveSearchIndex(0);
  }, [activeSearchIndex, localSearchMatches.length]);

  useEffect(() => {
    if (!activeSearchMessageId) return;
    messageRefs.current[activeSearchMessageId]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeSearchMessageId]);

  useEffect(() => {
    const detailSession = detail.data?.session;
    if (!detailSession) return;
    if (
      detailSession.messageCount === session.messageCount &&
      detailSession.updatedAt === session.updatedAt &&
      detailSession.lastMessageAt === session.lastMessageAt
    ) return;
    void queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
  }, [detail.data?.session, queryClient, session.lastMessageAt, session.messageCount, session.updatedAt]);

  // Track whether the user has scrolled away from the bottom. While they're
  // reading older messages mid-stream, we should NOT yank them back to the
  // latest delta — autoscroll only applies when they're already near the
  // bottom (matches the ClaudeCode timeline's behavior).
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    const NEAR_THRESHOLD_PX = 80;
    const update = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setNearBottom(distanceFromBottom <= NEAR_THRESHOLD_PX);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, []);

  // Fetch the previous window (everything strictly older than the oldest loaded
  // message) and PREPEND it to the local buffer. Scroll position is preserved by
  // capturing scrollHeight before the state update and compensating scrollTop in
  // the layout effect below, so the viewport doesn't jump as content prepends.
  const loadOlder = async () => {
    if (loadingOlder || !hasOlder) return;
    const before = messages[0]?.sortOrder;
    if (before == null) return;
    setLoadingOlder(true);
    setSendError("");
    const el = messageListRef.current;
    const snapshot = { prevScrollHeight: el?.scrollHeight ?? 0, prevScrollTop: el?.scrollTop ?? 0 };
    const epoch = olderEpochRef.current;
    try {
      const page = await getSessionDetail(session.id, { before });
      // The older buffer was dropped meanwhile (a failed gap fill, a reload): this page would sit above the newest window.
      if (epoch !== olderEpochRef.current) return;
      setOlderHasMore(page.pagination.hasOlder);
      scrollAdjustRef.current = snapshot;
      setOlderPages((current) => {
        const have = new Set(current.map((m) => m.id));
        const fresh = page.messages.filter((m) => !have.has(m.id));
        return fresh.length ? [...fresh, ...current] : current;
      });
    } catch (error) {
      scrollAdjustRef.current = null;
      setSendError(error instanceof Error ? error.message : "loading older messages failed");
    } finally {
      setLoadingOlder(false);
    }
  };

  // Apply the scroll compensation synchronously after the prepended DOM commits
  // (live "Load older" AND the historical view's older prepends share the ref).
  useLayoutEffect(() => {
    const adjust = scrollAdjustRef.current;
    if (!adjust) return;
    scrollAdjustRef.current = null;
    const el = messageListRef.current;
    if (!el) return;
    el.scrollTop = adjust.prevScrollTop + (el.scrollHeight - adjust.prevScrollHeight);
  }, [olderPages, historicalView]);

  // A gap fill that landed (or failed) changed the rows around the reader; put the row they were reading back
  // where it was.
  useLayoutEffect(() => {
    const anchor = readingAnchorRef.current;
    if (!anchor) return;
    readingAnchorRef.current = null;
    const list = messageListRef.current;
    const node = messageRefs.current[anchor.id];
    if (!list || !node?.isConnected) return;
    list.scrollTop += node.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
  }, [olderPages]);

  // Fill the open gaps from the server. The previous window is already carried, so the transcript shows a loading
  // row at each gap meanwhile. A newer detail read replaces `gapFill` (this run is cancelled and a new one starts with
  // the gaps that still matter); unmounting, which a session switch does, cancels it. On failure the older pages and
  // the held Load older answer go, so the transcript is the newest window alone and Load older works from it.
  useEffect(() => {
    if (!gapFill) return;
    let cancelled = false;
    const fill = gapFill;
    void (async () => {
      try {
        const fetched: ChatMessage[] = [];
        for (const gap of fill.gaps) fetched.push(...await collectGapRows(gap, (cursor) => getSessionDetail(session.id, cursor)));
        if (cancelled) return;
        readingAnchorRef.current = readingAnchor(messageListRef.current, messageRefs.current);
        setOlderPages((current) => mergeWindowGap(current, [], fetched));
      } catch {
        if (cancelled) return;
        readingAnchorRef.current = readingAnchor(messageListRef.current, messageRefs.current);
        olderEpochRef.current += 1;
        setOlderPages([]);
        setOlderHasMore(null);
        setSendError(GAP_FILL_FAILED_TEXT);
      }
      setGapFill((current) => (current === fill ? null : current));
    })();
    return () => { cancelled = true; };
  }, [gapFill, session.id]);

  useEffect(() => {
    if (!session.autoScroll) return;
    if (historicalView) return; // viewing a past scene — the live tail isn't rendered
    if (!nearBottom) return; // user has scrolled away — don't yank them back
    const targetId = renderedMessages[renderedMessages.length - 1]?.id;
    if (!targetId) return;
    const timer = window.setTimeout(() => {
      messageRefs.current[targetId]?.scrollIntoView({ block: "end", behavior: streamState.streamingText ? "auto" : "smooth" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [renderedMessages, session.autoScroll, streamState.streamingText, nearBottom, historicalView]);

  const refreshLoadedHistory = async (generation: number) => {
    const buffers = historyBuffersRef.current;
    const navigation = historyNavigationRef.current;
    const [refreshedOlder, refreshedHistory] = await Promise.all([
      refreshMessageRange(session.id, buffers.olderPages),
      refreshMessageRange(session.id, buffers.historicalView?.pages ?? []),
    ]);
    if (mountedRef.current && generation === messageMutationGenerationRef.current) {
      setOlderPages((current) => reconcileMessageRange(current, buffers.olderPages, refreshedOlder));
      const previous = buffers.historicalView;
      if (previous) setHistoricalView((current) => {
        if (!current || navigation !== historyNavigationRef.current) return current;
        return { ...current, pages: reconcileMessageRange(current.pages, previous.pages, refreshedHistory) };
      });
    }
  };

  const syncDetail = async (sessionId: string, next: Awaited<ReturnType<typeof updateChatMessage>>, generation: number) => {
    if (generation !== messageMutationGenerationRef.current) return;
    queryClient.setQueryData(["session-detail", sessionId], next);
    await refreshLoadedHistory(generation);
    await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
  };

  const reconcileCompletedMessage = (message: ChatMessage) => {
    if (!mountedRef.current) return;
    // Regenerating a loaded old reply replaces its slot outside the newest
    // detail window. Completion includes the persisted row and its real order.
    const replace = (rows: ChatMessage[]) => rows.some((row) => row.sortOrder === message.sortOrder)
      ? rows.map((row) => row.sortOrder === message.sortOrder ? message : row) : rows;
    setOlderPages(replace);
    setHistoricalView((current) => {
      if (!current) return current;
      const pages = replace(current.pages);
      return pages === current.pages ? current : { ...current, pages };
    });
  };

  const refreshSceneValidation = () => {
    void queryClient.invalidateQueries({ queryKey: ["session-detail", session.id] });
    const generation = messageMutationGenerationRef.current;
    void refreshLoadedHistory(generation).catch((error) => {
      if (mountedRef.current && generation === messageMutationGenerationRef.current) {
        setSendError(error instanceof Error ? error.message : "Unable to refresh historical scene validation");
      }
    });
  };

  // Append attachments under the contract's per-message cap and SAY when the
  // cap trims (the old eight-item slice dropped a ninth file silently).
  const addAttachments = (incoming: ComposerAttachmentInput[]) => {
    if (!incoming.length) return;
    const preview = mergeAttachments(attachmentsRef.current, incoming);
    attachmentsRef.current = preview.attachments;
    setAttachments((current) => mergeAttachments(current, incoming).attachments);
    if (preview.dropped > 0) emitGlobalToast(describeDroppedAttachments(preview.dropped), "info");
  };

  // Hand a failed send's text back to the composer — this instance when it is
  // still mounted, the module stash for the session's next mount otherwise.
  // Never overwrites text the user has typed since the send cleared it.
  // A spotlight hand-off goes back to the popover the same way.
  const restoreComposer = (sessionId: string, sent: FailedSendRestore) => {
    const restore = failedSendRestore(sent);
    if (!restore) return;
    if (mountedRef.current) {
      setDraft((current) => (current ? current : restore.draft));
      setAttachments((current) => (current.length > 0 ? current : restore.attachments));
      if (restore.spotlight) {
        const fields = spotlightFieldsAfterRestore(spotlightFieldsRef.current, restore.spotlight);
        setSpotlightChar(fields.characterName);
        setSpotlightSteer(fields.steer);
      }
      return;
    }
    composerRestoreStash.set(sessionId, restore);
  };

  // Did the server persist the user turn before the stream failed? The server
  // creates the user message BEFORE context assembly (chatService — before any
  // response.context/started event), so a failure after any of those events is
  // a persisted turn; for a failure before them (HTTP-level rejection, a
  // pre-persist HttpError riding response.error with a status) the freshly
  // fetched transcript decides. A restored draft on a persisted turn is how
  // Send produced a second identical user message.
  const userTurnPersisted = async (sessionId: string, prompt: string, afterSortOrder: number | null) => {
    try {
      const next = await getSessionDetail(sessionId);
      queryClient.setQueryData(["session-detail", sessionId], next);
      return isPendingPromptPersisted(next.messages, prompt, afterSortOrder);
    } catch {
      // Can't tell (network down) — err toward giving the text back: losing it
      // is the failure the restore exists to prevent.
      return false;
    }
  };

  const patchSessionStream = (sessionId: string, requestId: string, patch: Partial<SessionStreamState>) => {
    updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, ...patch } : current);
  };

  // Guarded: a finishing stream may only reset state it still owns — once the
  // composer unlocks on response.completed, the user can start a NEW stream
  // while the old one drains (validator), and the old finally must not wipe it.
  const resetSessionStreamIfOwner = (sessionId: string, requestId: string, error = "") => {
    updateSessionStream(sessionId, (current) => {
      if (current.requestId !== requestId) return current;
      return { ...createEmptySessionStreamState(), error, contextPreview: current.contextPreview, contextDebug: current.contextDebug, contextBudgetTokens: current.contextBudgetTokens, contextNotes: current.contextNotes, contextInfoNotes: current.contextInfoNotes };
    });
  };

  // A guarded truncate refused because the chat changed since it was loaded: reload the chat as reopening it
  // would. The open gaps and the older pages go, and the newest window is read again; Load older works from it.
  const reloadChat = () => {
    olderEpochRef.current += 1;
    setGapFill(null);
    setOlderPages([]);
    setOlderHasMore(null);
    void queryClient.invalidateQueries({ queryKey: ["session-detail", session.id] });
  };

  // Stop is purely server-side: stopSessionResponse makes the server persist
  // the partial turn and END the stream with a normal response.completed, and
  // streamChatSse carries no AbortSignal — so there is no client-side abort to
  // special-case in the catch blocks below (the old stopRequestsRef/isAbortError
  // bookkeeping could never fire).

  const sendMessage = async (opts?: { spotlight?: { characterName: string; steer?: string } }) => {
    const sessionId = session.id;
    const spotlight = opts?.spotlight;
    const prompt = spotlight ? "" : draft.trim();
    if ((!prompt && !attachments.length && !spotlight) || sending) return;
    // A new turn always lands at the live tail — leave the historical view first.
    if (historicalView) exitHistoricalView();
    const requestId = buildRequestId();
    const rollArmOwner = rollOverride ? getRollArmOwner() : undefined;
    setSendError("");
    // Snapshot what we're about to send so we can restore the composer on failure.
    const sentDraft = draft;
    const sentAttachments = attachments;
    const pendingPrompt = spotlight ? buildSpotlightPendingLabel(spotlight.characterName, spotlight.steer) : (prompt || "See attached files.");
    const pendingAfterSortOrder = messages[messages.length - 1]?.sortOrder ?? -1;
    updateSessionStream(sessionId, {
      ...createEmptySessionStreamState(),
      sending: true,
      requestId,
      stopRequested: false,
      responseStarted: false,
      pendingPrompt,
      pendingAttachments: spotlight ? [] : attachments,
      pendingAfterSortOrder,
      streamingText: "",
      streamingThinking: "",
      error: "",
      contextPreview: [],
      contextDebug: null,
      contextNotes: [],
      contextInfoNotes: [],
      contextBudgetTokens: 0,
    });
    if (!spotlight) { setDraft(""); setAttachments([]); }
    let finalError = "";
    // Any non-error event proves the server got past persisting the user turn.
    let sawTurnEvent = false;
    try {
      await streamSessionResponse(sessionId, requestId, {
        prompt,
        modelId: session.modelId,
        attachments: spotlight ? [] : attachments,
        ...(rollOverride ? { rollOverride: true } : {}),
        ...(spotlight ? { spotlight } : {}),
      }, (event) => {
        if (event.type !== "response.error") sawTurnEvent = true;
        if (event.type === "response.started") patchSessionStream(sessionId, requestId, { responseStarted: true });
        if (event.type === "response.context") patchSessionStream(sessionId, requestId, { contextPreview: event.preview, contextDebug: event.debug, contextBudgetTokens: event.budgetTokens, contextNotes: event.notes, contextInfoNotes: event.infoNotes });
        if (event.type === "response.scene_validation") refreshSceneValidation();
        if (event.type === "response.completed") { reconcileCompletedMessage(event.message); consumeRollOverride(rollArmOwner); patchSessionStream(sessionId, requestId, { completed: true, completedMessageId: event.message.id }); void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] }); notifyTurnComplete(session.name); }
        if (event.type === "response.delta") updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, streamingText: current.streamingText + event.delta } : current);
        if (event.type === "response.thinking.delta") updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, streamingThinking: current.streamingThinking + event.delta } : current);
        if (event.type === "response.error") {
          finalError = event.error;
          patchSessionStream(sessionId, requestId, { error: event.error });
        }
      });
    } catch (error) {
      finalError = error instanceof Error ? error.message : "chat request failed";
      patchSessionStream(sessionId, requestId, { error: finalError });
    } finally {
      if (finalError) {
        // Restore the draft + attachments ONLY when the user turn was never
        // persisted — otherwise the transcript already holds it (plus the
        // partial/interrupted reply) and a refilled composer invites a duplicate.
        const persisted = sawTurnEvent || await userTurnPersisted(sessionId, pendingPrompt, pendingAfterSortOrder);
        // A hand-off's steer was cleared from the popover before the send.
        if (!persisted) restoreComposer(sessionId, { draft: sentDraft, attachments: sentAttachments, ...(spotlight ? { spotlight } : {}) });
      }
      await queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      resetSessionStreamIfOwner(sessionId, requestId, finalError);
    }
  };

  const startEdit = (message: ChatMessage) => {
    editDraftRef.current = message.content;
    // The editor takes the exact footprint of the prose it replaces
    // (2026-09-23): measure the rendered body now, before the card re-renders, and
    // the textarea mounts at that height. The drag handle still resizes it.
    const body = messageRefs.current[message.id]?.querySelector<HTMLElement>(".msg-body");
    editInitialHeightRef.current = body ? Math.round(body.getBoundingClientRect().height) : null;
    setEditingMessageId(message.id);
    setSendError("");
  };

  const cancelEdit = () => {
    editDraftRef.current = "";
    setEditingMessageId(null);
  };

  const saveEdit = async (message: ChatMessage) => {
    const sessionId = session.id;
    const content = editDraftRef.current.trim();
    if (!content || mutatingMessageId) return;
    const mutationGeneration = ++messageMutationGenerationRef.current;
    setMutatingMessageId(message.id);
    setSendError("");
    try {
      const next = await updateChatMessage(sessionId, message.id, { content });
      await syncDetail(sessionId, next, mutationGeneration);
      cancelEdit();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "message update failed");
    } finally {
      setMutatingMessageId(null);
    }
  };

  const deleteMessage = async (messageId: string) => {
    const sessionId = session.id;
    if (mutatingMessageId) return;
    const mutationGeneration = ++messageMutationGenerationRef.current;
    setMutatingMessageId(messageId);
    setSendError("");
    try {
      const next = await deleteChatMessage(sessionId, messageId);
      await syncDetail(sessionId, next, mutationGeneration);
      if (editingMessageId === messageId) cancelEdit();
      setConfirmingAction(null);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "message delete failed");
    } finally {
      setMutatingMessageId(null);
    }
  };

  const truncateAfter = async (messageId: string) => {
    const sessionId = session.id;
    if (mutatingMessageId) return;
    const mutationGeneration = ++messageMutationGenerationRef.current;
    setMutatingMessageId(messageId);
    setSendError("");
    // The confirmation named the count; the server checks it and the last message this page has. A message
    // outside the loaded transcript sends no count, and a cut of more than two is then refused.
    const index = messages.findIndex((message) => message.id === messageId);
    const plan = cutPlan(messages, index + 1);
    try {
      const next = await truncateChatMessages(sessionId, messageId, { expectLastMessageId: plan.lastId, ...(index >= 0 ? { confirmDeleteCount: plan.removed } : {}) });
      await syncDetail(sessionId, next, mutationGeneration);
      if (editingMessageId && !next.messages.some((message) => message.id === editingMessageId)) cancelEdit();
      setConfirmingAction(null);
    } catch (error) {
      if (isChatChangedRefusal(error)) {
        setConfirmingAction(null);
        reloadChat();
      }
      setSendError(error instanceof Error ? error.message : "message truncate failed");
    } finally {
      setMutatingMessageId(null);
    }
  };

  const confirmRemoval = (count: number, action: string) => new Promise<boolean>((resolve) => {
    removalAnswerRef.current = resolve;
    setConfirmingRemoval({ count, action });
  });
  const answerRemoval = (confirmed: boolean) => {
    removalAnswerRef.current?.(confirmed);
    removalAnswerRef.current = null;
    setConfirmingRemoval(null);
  };

  const resendFrom = async (messageIndex: number) => {
    const sessionId = session.id;
    const message = messages[messageIndex];
    if (!message || message.role !== "user" || sending || mutatingMessageId) return;
    // What the cut removes (the first loaded row is cut after; any other is cut with the row before it), the
    // person's confirmation when that is more than two, and the last message this page has for the server to check.
    const plan = cutPlan(messages, messageIndex === 0 ? 1 : messageIndex);
    const laterCount = messageIndex === 0 ? plan.removed : plan.removed - 1;
    if (plan.needsConfirmation && !(await confirmRemoval(laterCount, "Resending this message"))) return;
    const requestId = buildRequestId();
    const rollArmOwner = rollOverride ? getRollArmOwner() : undefined;
    const replayPrompt = message.content;
    const replayAttachments = message.attachments.map(mapStoredAttachmentToInput);
    // The replayed turn re-persists right after the message we truncate to.
    let pendingAfterSortOrder = messages[messageIndex - 1]?.sortOrder ?? -1;
    const mutationGeneration = ++messageMutationGenerationRef.current;
    setMutatingMessageId(message.id);
    setSendError("");
    updateSessionStream(sessionId, {
      ...createEmptySessionStreamState(),
      sending: true,
      requestId,
      stopRequested: false,
      responseStarted: false,
      pendingPrompt: replayPrompt || "See attached files.",
      pendingAttachments: replayAttachments,
      pendingAfterSortOrder,
      streamingText: "",
      streamingThinking: "",
      error: "",
      contextPreview: [],
      contextDebug: null,
      contextNotes: [],
      contextInfoNotes: [],
      contextBudgetTokens: 0,
    });
    let finalError = "";
    let sawTurnEvent = false;
    let chatChanged = false;
    // Whether the call that removes the replayed turn answered (the delete of a first row, else the truncate after its
    // predecessor), and what stopped the replay: a failure before that answer may have left the turn in place.
    let removed = false;
    let failure: unknown = null;
    try {
      if (messageIndex === 0) {
        const next = await truncateChatMessages(sessionId, message.id, { expectLastMessageId: plan.lastId, confirmDeleteCount: plan.removed });
        await syncDetail(sessionId, next, mutationGeneration);
        const afterDelete = await deleteChatMessage(sessionId, message.id);
        removed = true;
        // No loaded predecessor: the tail after the delete is the floor, not -1.
        pendingAfterSortOrder = replayFloorAfterRemoval(afterDelete.messages);
        patchSessionStream(sessionId, requestId, { pendingAfterSortOrder });
        await syncDetail(sessionId, afterDelete, mutationGeneration);
      } else {
        // Name the row this replaces. The server refuses (409) when another row sits between, which is how a
        // transcript holding rows it never loaded used to delete them here.
        const next = await truncateChatMessages(sessionId, messages[messageIndex - 1]!.id, { expectNextMessageId: message.id, expectLastMessageId: plan.lastId, confirmDeleteCount: plan.removed });
        removed = true;
        await syncDetail(sessionId, next, mutationGeneration);
      }
      await streamSessionResponse(sessionId, requestId, {
        prompt: replayPrompt,
        modelId: session.modelId,
        attachments: replayAttachments,
        // Resend is a fresh user message (new id → new contest seed), so an ARMED
        // 🎲 must ride it exactly like a composer send — this path missing the
        // flag is how an armed override silently did nothing on 2026-08-02.
        ...(rollOverride ? { rollOverride: true } : {}),
      }, (event) => {
        if (event.type !== "response.error") sawTurnEvent = true;
        if (event.type === "response.started") patchSessionStream(sessionId, requestId, { responseStarted: true });
        if (event.type === "response.context") patchSessionStream(sessionId, requestId, { contextPreview: event.preview, contextDebug: event.debug, contextBudgetTokens: event.budgetTokens, contextNotes: event.notes, contextInfoNotes: event.infoNotes });
        if (event.type === "response.scene_validation") refreshSceneValidation();
        if (event.type === "response.completed") { reconcileCompletedMessage(event.message); consumeRollOverride(rollArmOwner); patchSessionStream(sessionId, requestId, { completed: true, completedMessageId: event.message.id }); void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] }); notifyTurnComplete(session.name); }
        if (event.type === "response.delta") updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, streamingText: current.streamingText + event.delta } : current);
        if (event.type === "response.thinking.delta") updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, streamingThinking: current.streamingThinking + event.delta } : current);
        if (event.type === "response.error") {
          finalError = event.error;
          patchSessionStream(sessionId, requestId, { error: event.error });
        }
      });
    } catch (error) {
      failure = error;
      finalError = error instanceof Error ? error.message : "message replay failed";
      chatChanged = isChatChangedRefusal(error);
      patchSessionStream(sessionId, requestId, { error: finalError });
    } finally {
      setMutatingMessageId(null);
      // resendFrom truncates the persisted turn BEFORE streaming, so a failed
      // stream-START leaves the user's prompt+attachments deleted with nothing to
      // recover from — restore them into the composer. A failure AFTER the server
      // re-persisted the turn must NOT restore (the transcript has it).
      // A refused truncate deleted nothing: the turn is still there, and the chat reloads.
      if (chatChanged) reloadChat();
      else if (finalError) {
        const lost = await replayTextLost({
          removal: removalAfterFailure(removed, failure),
          originalStillThere: () => rowStillThere(sessionId, message),
          replayPersisted: async () => sawTurnEvent || await userTurnPersisted(sessionId, replayPrompt || "See attached files.", pendingAfterSortOrder),
        });
        if (lost) restoreComposer(sessionId, { draft: replayPrompt, attachments: replayAttachments });
      }
      await queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      resetSessionStreamIfOwner(sessionId, requestId, finalError);
    }
  };

  const stopStreaming = async () => {
    const requestId = streamState.requestId;
    if (!requestId || !sending || stopping) return;
    patchSessionStream(session.id, requestId, { stopRequested: true, error: "" });
    setSendError("");
    try {
      const result = await stopSessionResponse(session.id, requestId);
      if (!result.stopped) {
        patchSessionStream(session.id, requestId, { stopRequested: false });
        setSendError("chat stream is no longer active");
        return;
      }
    } catch (error) {
      patchSessionStream(session.id, requestId, { stopRequested: false });
      setSendError(error instanceof Error ? error.message : "chat stop failed");
    }
  };

  // Regenerate streams a NEW sibling variant at the same slot — the
  // prior reply is preserved and swipeable, not destroyed (the old path truncated
  // the transcript and resent, deleting the rejected variant forever).
  const regenerateFrom = async (messageIndex: number) => {
    if (sending || mutatingMessageId) return;
    const target = messages[messageIndex];
    if (!target || target.role !== "assistant") return;
    const sessionId = session.id;
    const requestId = buildRequestId();
    const rollArmOwner = rollOverride ? getRollArmOwner() : undefined;
    updateSessionStream(sessionId, {
      ...createEmptySessionStreamState(),
      sending: true,
      requestId,
      stopRequested: false,
      responseStarted: false,
      pendingPrompt: "",
      pendingAttachments: [],
      pendingAfterSortOrder: null,
      streamingText: "",
      streamingThinking: "",
      error: "",
      contextPreview: [],
      contextDebug: null,
      contextNotes: [],
      contextInfoNotes: [],
      contextBudgetTokens: 0,
    });
    let finalError = "";
    try {
      // response.completed carries the NEW sibling (its id lands in
      // completedMessageId, and the pending-assistant card yields to the
      // persisted row once the refetch shows that id); a response.error may
      // carry the HTTP status the failure would have had — the message is what
      // the composer error slot shows either way.
      await regenerateMessageStream(sessionId, target.id, requestId, { modelId: session.modelId ?? undefined, ...(rollOverride ? { rollOverride: true } : {}) }, (event) => {
        if (event.type === "response.started") patchSessionStream(sessionId, requestId, { responseStarted: true });
        if (event.type === "response.context") patchSessionStream(sessionId, requestId, { contextPreview: event.preview, contextDebug: event.debug, contextBudgetTokens: event.budgetTokens, contextNotes: event.notes, contextInfoNotes: event.infoNotes });
        if (event.type === "response.scene_validation") refreshSceneValidation();
        if (event.type === "response.completed") { reconcileCompletedMessage(event.message); consumeRollOverride(rollArmOwner); patchSessionStream(sessionId, requestId, { completed: true, completedMessageId: event.message.id }); void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] }); notifyTurnComplete(session.name); }
        if (event.type === "response.delta") updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, streamingText: current.streamingText + event.delta } : current);
        if (event.type === "response.thinking.delta") updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, streamingThinking: current.streamingThinking + event.delta } : current);
        if (event.type === "response.error") {
          finalError = event.error;
          patchSessionStream(sessionId, requestId, { error: event.error });
        }
      });
    } catch (error) {
      finalError = error instanceof Error ? error.message : "regenerate failed";
      patchSessionStream(sessionId, requestId, { error: finalError });
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
      resetSessionStreamIfOwner(sessionId, requestId, finalError);
    }
  };

  // Swipe between sibling variants: flip the active sibling server-side (which
  // also recomputes session scene state from the new active tail) and sync.
  const switchVariant = async (message: ChatMessage, direction: -1 | 1) => {
    if (sending || mutatingMessageId) return;
    const siblings = message.variantSiblingIds;
    if (siblings.length < 2) return;
    const currentIdx = siblings.indexOf(message.id);
    if (currentIdx < 0) return;
    const nextId = siblings[(currentIdx + direction + siblings.length) % siblings.length]!;
    if (nextId === message.id) return;
    const mutationGeneration = ++messageMutationGenerationRef.current;
    setMutatingMessageId(message.id);
    setSendError("");
    try {
      const next = await switchMessageVariant(session.id, nextId);
      await syncDetail(session.id, next, mutationGeneration);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "variant switch failed");
    } finally {
      setMutatingMessageId(null);
    }
  };

  // Scene outline jump: scroll to the message when it's currently rendered;
  // otherwise fetch an after-cursor window opening AT the scene (the target is
  // the window's first message) and swap into the historical view.
  const jumpToScene = async (entry: SceneOutlineEntry) => {
    const node = messageRefs.current[entry.messageId];
    if (node) {
      setScenesPopoverOpen(false);
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (historicalLoading) return;
    const navigation = ++historyNavigationRef.current;
    setHistoricalLoading("jump");
    setSendError("");
    try {
      const page = await getSessionDetail(session.id, { after: entry.sortOrder - 1 });
      if (navigation !== historyNavigationRef.current || !mountedRef.current) return;
      setHistoricalView({
        pages: page.messages,
        anchorId: entry.messageId,
        hasNewer: page.pagination.hasNewer,
        newestSortOrder: page.pagination.newestSortOrder,
        hasOlder: page.pagination.hasOlder,
        oldestSortOrder: page.pagination.oldestSortOrder,
      });
      setScenesPopoverOpen(false);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "scene jump failed");
    } finally {
      setHistoricalLoading(null);
    }
  };

  // Scroll the jump target into view once the historical window has rendered.
  useEffect(() => {
    const anchorId = historicalView?.anchorId;
    if (!anchorId) return;
    const timer = window.setTimeout(() => {
      messageRefs.current[anchorId]?.scrollIntoView({ block: "start" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [historicalView?.anchorId]);

  // Exit the historical view back to the live transcript tail.
  const exitHistoricalView = () => {
    historyNavigationRef.current += 1;
    setHistoricalView(null);
    window.setTimeout(() => {
      const el = messageListRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight });
    }, 0);
  };

  // Page the historical view backward — prepend with the same scroll-preservation
  // snapshot the live loadOlder uses (shared scrollAdjustRef + layout effect).
  const loadHistoricalOlder = async () => {
    if (!historicalView || historicalLoading || !historicalView.hasOlder || historicalView.oldestSortOrder == null) return;
    const navigation = historyNavigationRef.current;
    setHistoricalLoading("older");
    setSendError("");
    const el = messageListRef.current;
    const snapshot = { prevScrollHeight: el?.scrollHeight ?? 0, prevScrollTop: el?.scrollTop ?? 0 };
    try {
      const page = await getSessionDetail(session.id, { before: historicalView.oldestSortOrder });
      if (navigation !== historyNavigationRef.current || !mountedRef.current) return;
      scrollAdjustRef.current = snapshot;
      setHistoricalView((current) => {
        if (!current || navigation !== historyNavigationRef.current) return current;
        const have = new Set(current.pages.map((m) => m.id));
        const fresh = page.messages.filter((m) => !have.has(m.id));
        return {
          ...current,
          pages: fresh.length ? [...fresh, ...current.pages] : current.pages,
          hasOlder: page.pagination.hasOlder,
          oldestSortOrder: page.pagination.oldestSortOrder ?? current.oldestSortOrder,
        };
      });
    } catch (error) {
      scrollAdjustRef.current = null;
      setSendError(error instanceof Error ? error.message : "loading older messages failed");
    } finally {
      setHistoricalLoading(null);
    }
  };

  // Page the historical view forward (append). If the appended window overlaps
  // the live loaded window we simply keep appending — ↓ Back to latest is the
  // exit; no merge into the live buffers is attempted.
  const loadHistoricalNewer = async () => {
    if (!historicalView || historicalLoading || !historicalView.hasNewer || historicalView.newestSortOrder == null) return;
    const navigation = historyNavigationRef.current;
    setHistoricalLoading("newer");
    setSendError("");
    try {
      const page = await getSessionDetail(session.id, { after: historicalView.newestSortOrder });
      if (navigation !== historyNavigationRef.current || !mountedRef.current) return;
      setHistoricalView((current) => {
        if (!current || navigation !== historyNavigationRef.current) return current;
        const have = new Set(current.pages.map((m) => m.id));
        const fresh = page.messages.filter((m) => !have.has(m.id));
        return {
          ...current,
          pages: fresh.length ? [...current.pages, ...fresh] : current.pages,
          hasNewer: page.pagination.hasNewer,
          newestSortOrder: page.pagination.newestSortOrder ?? current.newestSortOrder,
        };
      });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "loading newer messages failed");
    } finally {
      setHistoricalLoading(null);
    }
  };

  // The Edit-scene form closes only on a saved edit; a refusal goes back to the form, which stays open with the typed
  // fields and shows it. A saved edit whose refresh then fails closes the form and reports in the chat's line.
  const saveSceneEdit = async (messageId: string, edits: SceneEditPayload): Promise<SceneEditResult> => {
    if (sending || mutatingMessageId) return { ok: false, error: "Another change is still saving. Save again when it finishes." };
    const sessionId = session.id;
    const mutationGeneration = ++messageMutationGenerationRef.current;
    setMutatingMessageId(messageId);
    setSendError("");
    try {
      const next = await editSceneMetadata(sessionId, messageId, edits);
      await syncDetail(sessionId, next, mutationGeneration).catch((error: unknown) => {
        setSendError(error instanceof Error ? error.message : "scene edit refresh failed");
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "scene edit failed" };
    } finally {
      setMutatingMessageId(null);
    }
  };

  const resolveScene = async (
    messageId: string,
    choice: "main" | "validator" | "user",
    userPresent?: string,
    userPresentUnaware?: string,
  ) => {
    if (sending || mutatingMessageId) return;
    const sessionId = session.id;
    const mutationGeneration = ++messageMutationGenerationRef.current;
    setMutatingMessageId(messageId);
    setSendError("");
    try {
      const result = await resolveSceneValidation(sessionId, messageId, { choice, userPresent, userPresentUnaware });
      await syncDetail(sessionId, result.detail, mutationGeneration);
      if (choice === "main" || !resolvedContextSettings.sceneValidatorAutoRegen) return;
      // Auto-regenerate the reply with the corrected scene as a one-shot
      // constraint — ONLY when it is the live tail. The replay below truncates
      // to before the reply's user turn (a server-side hard delete of every
      // later row), so for an older reply the resolution stays applied and the
      // user is told that Cut is the deliberate route.
      const target = resolveAutoRegenTarget(result.detail, messageId);
      if (target.kind !== "regen") {
        emitGlobalToast(describeSkippedAutoRegen(target), "info");
        return;
      }
      const { userMessage, truncateToId } = target;
      let { pendingAfterSortOrder } = target;
      // A spotlight marker replays through the spotlight request, so the server re-persists
      // it as a marker (its kind and divider kept) rather than a player turn.
      const replay = autoRegenReplay(userMessage);
      if (replay.kind === "unreadable-spotlight") {
        emitGlobalToast(describeUnreadableSpotlightReplay(), "info");
        return;
      }
      const requestId = buildRequestId();
      const rollArmOwner = rollOverride ? getRollArmOwner() : undefined;
      const replayPrompt = replay.kind === "prompt" ? replay.prompt : "";
      const replayAttachments = replay.kind === "prompt" ? replay.attachments : [];
      // The replay is a FRESH user message (new id → new contest seed), so the
      // override must ride it when the composer is armed OR the original turn
      // carried it — the truncate below deletes the stamped original, and this
      // path dropping the flag lost the 🎲 OVERRIDE badge on every "Agree with
      // Validator & regenerate" (resendFrom got the same fix 2026-08-02).
      const replayRollOverride = rollOverride || userMessage.rollOverride;
      setMutatingMessageId(userMessage.id);
      updateSessionStream(sessionId, {
        ...createEmptySessionStreamState(),
        sending: true,
        requestId,
        stopRequested: false,
        responseStarted: false,
        pendingPrompt: replay.pendingPrompt,
        pendingAttachments: replayAttachments,
        pendingAfterSortOrder,
        streamingText: "",
        streamingThinking: "",
        error: "",
        contextPreview: [],
        contextDebug: null,
        contextNotes: [],
        contextInfoNotes: [],
        contextBudgetTokens: 0,
      });
      let finalError = "";
      let sawTurnEvent = false;
      let chatChanged = false;
      // As in resendFrom: whether the call that removes the replayed turn answered, and what stopped the replay.
      let removed = false;
      let failure: unknown = null;
      try {
        // Truncate to BEFORE the user message — the stream re-persists the user
        // turn, so truncating AT it left the original in place and every
        // auto-regen produced two identical consecutive user messages.
        if (truncateToId === null) {
          const truncResult = await truncateChatMessages(sessionId, userMessage.id, { expectLastMessageId: cutPlan(result.detail.messages, 0).lastId });
          await syncDetail(sessionId, truncResult, mutationGeneration);
          const afterDelete = await deleteChatMessage(sessionId, userMessage.id);
          removed = true;
          // No loaded predecessor: the tail after the delete is the floor, not -1.
          pendingAfterSortOrder = replayFloorAfterRemoval(afterDelete.messages);
          patchSessionStream(sessionId, requestId, { pendingAfterSortOrder });
          await syncDetail(sessionId, afterDelete, mutationGeneration);
        } else {
          // Name the turn this replaces; the server refuses (409) if the chat changed in between.
          const truncResult = await truncateChatMessages(sessionId, truncateToId, { expectNextMessageId: userMessage.id, expectLastMessageId: cutPlan(result.detail.messages, 0).lastId });
          removed = true;
          await syncDetail(sessionId, truncResult, mutationGeneration);
        }
        await streamSessionResponse(sessionId, requestId, {
          prompt: replayPrompt,
          modelId: session.modelId,
          attachments: replayAttachments,
          sceneConstraintOverride: result.correctedScene,
          ...(replay.kind === "spotlight" ? { spotlight: replay.spotlight } : {}),
          ...(replayRollOverride ? { rollOverride: true } : {}),
        }, (event) => {
          if (event.type !== "response.error") sawTurnEvent = true;
          if (event.type === "response.started") patchSessionStream(sessionId, requestId, { responseStarted: true });
          if (event.type === "response.context") patchSessionStream(sessionId, requestId, { contextPreview: event.preview, contextDebug: event.debug, contextBudgetTokens: event.budgetTokens, contextNotes: event.notes, contextInfoNotes: event.infoNotes });
          if (event.type === "response.scene_validation") refreshSceneValidation();
          if (event.type === "response.completed") { reconcileCompletedMessage(event.message); consumeRollOverride(rollArmOwner); patchSessionStream(sessionId, requestId, { completed: true, completedMessageId: event.message.id }); void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] }); notifyTurnComplete(session.name); }
          if (event.type === "response.delta") updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, streamingText: current.streamingText + event.delta } : current);
          if (event.type === "response.thinking.delta") updateSessionStream(sessionId, (current) => current.requestId === requestId ? { ...current, streamingThinking: current.streamingThinking + event.delta } : current);
          if (event.type === "response.error") {
            finalError = event.error;
            patchSessionStream(sessionId, requestId, { error: event.error });
          }
        });
      } catch (error) {
        failure = error;
        finalError = error instanceof Error ? error.message : "scene regen failed";
        chatChanged = isChatChangedRefusal(error);
        patchSessionStream(sessionId, requestId, { error: finalError });
      } finally {
        setMutatingMessageId(null);
        // The auto-regen path truncated the persisted user turn before
        // streaming, so a failed stream-START would otherwise lose the prompt +
        // attachments entirely — restore them into the composer. Never when the
        // server already re-persisted the turn.
        // A refused truncate deleted nothing: the turn is still there, and the chat reloads.
        if (chatChanged) reloadChat();
        else if (finalError) {
          const lost = await replayTextLost({
            removal: removalAfterFailure(removed, failure),
            originalStillThere: () => rowStillThere(sessionId, userMessage),
            replayPersisted: async () => sawTurnEvent || await userTurnPersisted(sessionId, replay.pendingPrompt, pendingAfterSortOrder),
          });
          // A hand-off goes back to the spotlight popover, never into the composer: sent
          // from there, the marker text would persist as a player turn. After a
          // switch away it waits in the stash like composer text.
          if (lost) restoreComposer(sessionId, { draft: replayPrompt, attachments: replayAttachments, ...(replay.kind === "spotlight" ? { spotlight: replay.spotlight } : {}) });
        }
        await queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
        await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
        resetSessionStreamIfOwner(sessionId, requestId, finalError);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "scene resolution failed");
    } finally {
      setMutatingMessageId(null);
    }
  };

  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1500);
    } catch {
      setSendError("clipboard write failed");
    }
  };

  const generateImage = async () => {
    const prompt = draft.trim();
    if (!prompt || generatingImage) return;
    // The composer text is the prompt; one over the contract's cap is named and stays in the composer.
    const tooLong = imagePromptProblem(prompt);
    if (tooLong) { setSendError(tooLong); return; }
    const submittedDraft = draft;
    setDraft("");
    setGeneratingImage(true);
    setSendError("");
    try {
      await generateSessionImage(session.id, {
        prompt,
        modelId: imageModelId,
      });
      await queryClient.invalidateQueries({ queryKey: ["session-detail", session.id] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
    } catch (error) {
      restoreComposer(session.id, { draft: submittedDraft, attachments: [] });
      setSendError(error instanceof Error ? error.message : "image request failed");
    } finally {
      setGeneratingImage(false);
    }
  };

  const exportConversation = async () => {
    if (exporting) return;
    setExporting(true);
    setSendError("");
    try {
      const exported = await exportSessionMarkdown(session.id);
      downloadTextFile(exported.filename, exported.content, exported.mimeType);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "export request failed");
    } finally {
      setExporting(false);
    }
  };

  const generateCampaignFromWizard = async () => {
    if (!isWizardSession || !wizardReady || startingWizardRun || wizardRun) return;
    setStartingWizardRun(true);
    setSendError("");
    try {
      await enqueueWizardRun({
        campaignName: "",
        modelId: session.modelId,
        wizardSessionId: session.id,
      });
      await queryClient.invalidateQueries({ queryKey: ["wizard-runs"] });
      await queryClient.invalidateQueries({ queryKey: ["wizard-active"] });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "wizard run request failed");
    } finally {
      setStartingWizardRun(false);
    }
  };

  const saveSessionSettings = async (payload: Record<string, unknown>) => {
    setSavingSessionSettings(true);
    setSendError("");
    try {
      await updateSession(session.id, payload);
      await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      await queryClient.invalidateQueries({ queryKey: ["session-detail", session.id] });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "session update failed");
    } finally {
      setSavingSessionSettings(false);
    }
  };

  const openTemplateDialog = () => {
    setShowTemplateDialog(true);
    setTemplateError("");
    setEditingTemplateId(null);
    setTemplateNameDraft("");
    setTemplateContentDraft("");
  };

  const resetTemplateEditor = () => {
    setEditingTemplateId(null);
    setTemplateNameDraft("");
    setTemplateContentDraft("");
    setTemplateError("");
  };

  const startTemplateEdit = (template: PromptTemplate) => {
    setEditingTemplateId(template.id);
    setTemplateNameDraft(template.name);
    setTemplateContentDraft(template.content);
    setTemplateError("");
  };

  const saveTemplate = async () => {
    const name = templateNameDraft.trim();
    const content = templateContentDraft.trim();
    if (!name || !content || savingTemplate) return;
    setSavingTemplate(true);
    setTemplateError("");
    try {
      if (editingTemplateId) await updatePromptTemplate(editingTemplateId, { name, content });
      else await createPromptTemplate({ name, content });
      await queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
      resetTemplateEditor();
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : "template save failed");
    } finally {
      setSavingTemplate(false);
    }
  };

  const removeTemplate = async (template: PromptTemplate) => {
    if (savingTemplate) return;
    setSavingTemplate(true);
    setTemplateError("");
    try {
      await deletePromptTemplate(template.id);
      await queryClient.invalidateQueries({ queryKey: ["prompt-templates"] });
      if (editingTemplateId === template.id) resetTemplateEditor();
      setConfirmingTemplateDelete(null);
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : "template delete failed");
    } finally {
      setSavingTemplate(false);
    }
  };

  const attachTemplate = (template: PromptTemplate) => {
    const next = {
      filename: toTemplateFilename(template.name),
      mimeType: "text/markdown",
      contentMode: "text" as const,
      content: template.content,
    };
    const duplicate = attachmentsRef.current.some((attachment) => attachment.filename === next.filename && attachment.content === next.content);
    if (!duplicate) addAttachments([next]);
    setShowTemplateDialog(false);
  };

  // A reply card's Context action opens that reply's stored snapshot, anchored at the
  // button; a second press on the same card's button closes it.
  const openContext = (m: ChatMessage, anchor: HTMLElement) => {
    if (contextReply?.messageId === m.id) { setContextReply(null); return; }
    contextReplyAnchorRef.current = anchor;
    setContextReply({ messageId: m.id, createdAt: m.createdAt, newest: m.id === newestReplyId(messages) });
  };

  messageActionsRef.current = { copyMessage, startEdit, resendFrom, regenerateFrom, switchVariant, saveEdit, cancelEdit, resolveScene, saveSceneEdit, openContext };

  const renderMessage = (message: ChatMessage, index: number) => {
    if (message.role === "cold-start") {
      return (
        <div key={message.id} ref={(node) => { messageRefs.current[message.id] = node; }} className="message-card role-cold-start">
          <div className="message-heading"><p className="message-role" style={{ color: "var(--accent)" }}>Cold Start</p></div>
          <div className="message-body" style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
        </div>
      );
    }
    // Living World — a GM-spotlight marker renders as a slim divider, never a user bubble.
    if (message.directiveKind === "gm_spotlight") {
      const m = /^\[GM SPOTLIGHT [—-] ([^:\]]+?)(?::\s*([\s\S]+?))?\]$/.exec(message.content.trim());
      const label = m
        ? <><Icon name="masks" size={14} /> Scene handed to {m[1]!.trim()}{m[2]?.trim() ? <span className="spotlight-divider-steer"> — “{m[2]!.trim()}”</span> : null}</>
        : <>{message.content}</>; // optimistic label ("🎭 Scene handed to …")
      return (
        <div key={message.id} ref={(node) => { messageRefs.current[message.id] = node; }} className="spotlight-divider" title="Scene handed to an NPC">
          <span>{label}</span>
        </div>
      );
    }
    const isPersistedMessage = !message.id.startsWith("pending-");
    // No edit-lock: the watermark mechanism was retired with the campaign-audit
    // sunset (0071) — every persisted message is editable.
    const isEditing = editingMessageId === message.id;
    const isLongMessage = (message.content || "").split("\n").length > 20;
    const messageCost = calculateMessageCost(message, session.cacheTtl);
    const turnHitRate = calculateTurnCacheHitRate(message);
    // Long turns (> 20 lines) render the bar twice: a floating one at the top and a
    // static one under the text; short turns render the floating one only. The
    // placement class keeps both visible (an earlier version pinned every bar to the
    // top, so the bottom bar of a long turn vanished under the top one).
    const renderActionBar = (placement: "float" | "bottom") => isPersistedMessage ? (
      <div className={`message-actions message-actions-${placement}`}>
        <button type="button" className="ghost-button" onClick={() => messageActionsRef.current.copyMessage(message)}>
          <Icon name={copiedMessageId === message.id ? "check" : "copy"} size={13} /> {copiedMessageId === message.id ? "Copied" : "Copy"}
        </button>
        {message.role === "assistant" && message.hasContextSnapshot ? (
          <button type="button" className="ghost-button" onClick={(event) => messageActionsRef.current.openContext(message, event.currentTarget)} title="The lorebook context the engine delivered for this reply">
            <Icon name="book-open" size={13} /> Context
          </button>
        ) : null}
        {!sending && !generatingImage ? (
          <>
            <button type="button" className="ghost-button" onClick={() => messageActionsRef.current.startEdit(message)} disabled={Boolean(mutatingMessageId)}>
              <Icon name="pencil" size={13} /> Edit
            </button>
            {message.role === "user" ? (
              // index === -1 marks a historical-view render: resend/regen/cut
              // index into the LIVE messages array, so they're gated off there.
              index >= 0 ? (
                <button type="button" className="ghost-button" onClick={() => messageActionsRef.current.resendFrom(index)} disabled={Boolean(mutatingMessageId)}>
                  <Icon name="rotate-ccw" size={13} /> Resend
                </button>
              ) : null
            ) : (
              <>
                {index >= 0 ? (
                  <button type="button" className="ghost-button" onClick={() => messageActionsRef.current.regenerateFrom(index)} disabled={Boolean(mutatingMessageId)}>
                    <Icon name="refresh" size={13} /> Regen
                  </button>
                ) : null}
                {message.variantCount > 1 ? (
                  // ‹ n/m › swipe chrome — flips the active sibling of this slot.
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                    <button type="button" className="ghost-button" title="Previous variant" onClick={() => messageActionsRef.current.switchVariant(message, -1)} disabled={Boolean(mutatingMessageId)}>
                      <Icon name="chevron-left" size={14} />
                    </button>
                    <span className="muted small-copy" style={{ minWidth: 32, textAlign: "center" }}>{message.variantIndex + 1}/{message.variantCount}</span>
                    <button type="button" className="ghost-button" title="Next variant" onClick={() => messageActionsRef.current.switchVariant(message, 1)} disabled={Boolean(mutatingMessageId)}>
                      <Icon name="chevron-right" size={14} />
                    </button>
                  </span>
                ) : null}
              </>
            )}
            {index >= 0 && index < messages.length - 1 ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => setConfirmingAction({ type: "truncate", messageId: message.id, label: message.role === "user" ? "this turn" : "this response" })}
                disabled={Boolean(mutatingMessageId)}
              >
                <Icon name="scissors" size={13} /> Cut
              </button>
            ) : null}
            <button
              type="button"
              className="ghost-button danger-copy"
              onClick={() => setConfirmingAction({ type: "delete", messageId: message.id, label: message.role === "user" ? "this user message" : "this assistant message" })}
              disabled={Boolean(mutatingMessageId)}
            >
              <Icon name="trash" size={13} /> Delete
            </button>
          </>
        ) : null}
      </div>
    ) : null;
    const sceneInfo = message.sceneData ? (() => { try { return JSON.parse(message.sceneData!) as { location: string; present: string[]; presentUnaware?: string[]; notPresent?: string[]; reason?: string | null; date?: string | null; time?: string | null }; } catch { return null; } })() : null;
    const isPendingMessage = message.id.startsWith("pending-");
    const editableMessage = message.role === "assistant" && !isPendingMessage;
    return (
    <div key={message.id}>
    {sceneInfo ? <SceneDivider
      location={sceneInfo.location}
      present={sceneInfo.present}
      presentUnaware={sceneInfo.presentUnaware ?? []}
      notPresent={sceneInfo.notPresent ?? []}
      reason={sceneInfo.reason ?? null}
      date={sceneInfo.date ?? null}
      time={sceneInfo.time ?? null}
      validator={message.sceneValidator ?? null}
      resolution={message.sceneResolution ?? null}
      onResolve={editableMessage ? (choice, p, pu) => messageActionsRef.current.resolveScene(message.id, choice, p, pu) : null}
      onEditSave={editableMessage ? (edits) => messageActionsRef.current.saveSceneEdit(message.id, edits) : null}
      autoRegen={resolvedContextSettings.sceneValidatorAutoRegen}
      // Only the live tail may auto-regenerate; historical renders
      // pass index -1 and are never the tail. resolveScene re-checks against the
      // server's post-resolution detail before anything is truncated.
      isLiveTail={index >= 0 && index === messages.length - 1}
      disabled={Boolean(mutatingMessageId) || sending}
      campaignId={session.campaignId ?? null}
      attireEnabled={resolvedContextSettings.attireTrackingEnabled}
      nextTurn={nextTurn}
    /> : null}
    <article
      ref={(node) => {
        messageRefs.current[message.id] = node;
      }}
      className={`message-card role-${message.role}${localSearchNeedle && message.content.toLocaleLowerCase().includes(localSearchNeedle) ? " search-hit" : ""}${activeSearchMessageId === message.id ? " active-match" : ""}${message.stopReason === "refusal" ? " is-refusal" : ""}`}
    >
      <div className="message-heading">
        <p className="message-role">{message.role === "user" ? "You" : "Assistant"}</p>
        {message.modelId ? <span className="muted small-copy">{findChatModel(availableChatModels, message.modelId)?.label ?? getChatModel(message.modelId)?.label ?? message.modelId}</span> : null}
        {message.fastMode ? <span className="msg-fast-badge" title={describeFastTurn(message.modelId ? getChatModel(message.modelId) : null)}><Icon name="zap" size={12} /> FAST</span> : null}
        {message.rollOverride && message.role === "user" ? <span className="msg-roll-override-badge" title="Owner roll override — this turn's contested rolls resolved in your favor (regenerates honor it too)"><Icon name="dice" size={12} /> OVERRIDE</span> : null}
        {(() => {
          // Serving-model transparency: badge any assistant turn the upstream reports
          // as produced by a different model than the one requested (e.g. a Fable 5
          // safeguard fallback served from Opus 4.8). Compare against the wire ID —
          // wireChatModelId owns catalog→wire semantics (bridge suffix strips + the
          // Western-hosted overrides like kimi-k2.6-fireworks → accounts/fireworks/
          // models/kimi-k2p6), so a provider echoing its own wire form never badges.
          const served = message.servedModel;
          if (!served || message.role !== "assistant" || !message.modelId) return null;
          const requestedWireId = wireChatModelId(message.modelId);
          // Bidirectional prefix match, case-insensitive: providers report snapshot
          // ids (gpt-5.4 -> gpt-5.4-2026-03-05), base ids for dated requests, or
          // repo-basename echoes (XiaomiMiMo/MiMo-V2.5-Pro -> mimo-v2.5-pro) —
          // none of those are substitutions. Real substitutions still badge.
          const s = served.toLowerCase();
          const candidates = [message.modelId, requestedWireId, requestedWireId.split("/").pop() ?? requestedWireId].map((v) => v.toLowerCase());
          if (candidates.some((c) => s === c || s.startsWith(c) || c.startsWith(s))) return null;
          const servedLabel = getChatModel(served)?.label ?? served;
          return <span className="msg-served-badge" title={`Requested ${requestedWireId} but the response was produced by ${served} (provider-side substitution or fallback).`}><Icon name="alert" size={12} /> SERVED BY {servedLabel.toUpperCase()}</span>;
        })()}
        {message.usage ? <span className="message-usage">↓{formatUsageValue(message.usage.inputTokens)} ↑{formatUsageValue(message.usage.outputTokens)}{(message.usage.reasoningTokens ?? 0) > 0 ? <> <Icon name="brain" size={12} />{formatUsageValue(message.usage.reasoningTokens)}</> : ""} Σ{formatUsageValue(message.usage.totalTokens)}{(message.usage.cacheReadTokens ?? 0) > 0 ? <> <Icon name="zap" size={12} />{formatUsageValue(message.usage.cacheReadTokens)}</> : ""}{(message.usage.cacheWriteTokens ?? 0) > 0 ? <> <Icon name="pen-line" size={12} />{formatUsageValue(message.usage.cacheWriteTokens)}</> : ""}{turnHitRate != null ? <span className={`turn-hit-rate ${turnHitRate > 0 ? "hit" : "miss"}`}> {formatPercent(turnHitRate)}</span> : null}{messageCost != null ? <span title={describeMessageCostBasis(message.modelId ? getChatModel(message.modelId) : null, session.cacheTtl)}>{` · ~${formatCostValue(messageCost)}`}</span> : null}</span> : null}
      </div>
      {message.stopReason === "refusal" ? (() => {
        const details = message.stopDetails;
        const rawCategory = details?.category;
        const categoryLabel = rawCategory === "reasoning_extraction" ? "REASONING" : (rawCategory ? String(rawCategory) : "policy").toUpperCase();
        // Known hard-block categories: cyber + bio + frontier_llm. reasoning_extraction (Fable 5)
        // means the prompt asked the model to reproduce its internal reasoning in the
        // response. Anything else (incl. null) reads as generic safety policy.
        const isHardBlock = rawCategory === "cyber" || rawCategory === "bio" || rawCategory === "frontier_llm";
        const hint = isHardBlock
          ? "Hard policy block — same prompt will refuse again. Try a different framing or switch model."
          : rawCategory === "reasoning_extraction"
          ? "The prompt asks the model to expose its internal reasoning — Fable 5 refuses this. Remove 'show your reasoning'-style instructions; the thinking block above already carries it."
          : "Safety policy refusal — rephrasing may help. Try Edit + Regen, or switch model (Haiku has different restrictions).";
        return (
          <div className="msg-refusal-card">
            <div className="msg-refusal-header">
              <span className="msg-refusal-tag">REFUSAL</span>
              <span className="msg-refusal-category">{categoryLabel}</span>
              <span className="msg-refusal-hint">{hint}</span>
            </div>
            {details?.explanation ? (
              <div className="msg-refusal-explanation">
                <span className="msg-refusal-explanation-label">From Anthropic (wording not stable):</span>
                <span className="msg-refusal-explanation-text">{details.explanation}</span>
              </div>
            ) : null}
          </div>
        );
      })() : null}
      {isLongMessage ? renderActionBar("float") : null}
      {isEditing ? (
        <div className="message-edit-stack">
          <div className="textarea-grow-wrap">
            <textarea
              aria-label="Edit message"
              className="message-edit-input"
              maxLength={MESSAGE_EDIT_MAX}
              defaultValue={editDraftRef.current}
              onChange={(event) => { editDraftRef.current = event.target.value; }}
              disabled={mutatingMessageId === message.id}
              // Same box as the prose it replaces (measured in startEdit); the handle below resizes it.
              style={editInitialHeightRef.current ? { height: editInitialHeightRef.current } : undefined}
              autoFocus
            />
            <div className="textarea-grow-handle at-bottom" onMouseDown={startTextareaResize} title="Drag to resize" />
          </div>
          <div className="row gap-sm">
            <button type="button" onClick={() => messageActionsRef.current.saveEdit(message)} disabled={mutatingMessageId === message.id}>
              {mutatingMessageId === message.id ? "Saving..." : "Save"}
            </button>
            <button type="button" className="secondary-button" onClick={() => messageActionsRef.current.cancelEdit()} disabled={mutatingMessageId === message.id}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {message.thinking ? <ThinkingBlock text={message.thinking} streaming={message.id === "pending-assistant"} /> : null}
          <div className="msg-body" ref={(node) => { if (node) attachCodeBlockCopyHandlers(node); }} dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
        </>
      )}
      {message.attachments.length ? (
        <div className="attachment-list">
          {message.attachments.map((attachment) => (
            <div key={attachment.id} className="attachment-stack">
              <div className="attachment-chip">
                <strong>{attachment.filename}</strong>
                <span className="muted small-copy">{attachment.mimeType}</span>
              </div>
              {isImageAttachment(attachment) ? <img src={attachmentDataUrl(attachment)} alt={attachment.filename} className="attachment-preview" /> : null}
              {isPdfAttachment(attachment) ? <p className="muted small-copy attachment-note">PDF attachment stored with the message.</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      {message.generatedImages.length ? (
        <div className="generated-image-list">
          {message.generatedImages.map((image) => (
            <figure key={image.id} className="generated-image-card">
              <img src={image.url} alt={image.prompt} className="generated-image" />
              <figcaption className="muted small-copy">{image.prompt}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {!isEditing && !isLongMessage ? renderActionBar("float") : null}
      {!isEditing && isLongMessage ? renderActionBar("bottom") : null}
    </article>
    </div>
  );};

  const historicalElements = useMemo(
    () => messages.map((m, i) => renderMessage(m, i)),
    // resolvedContextSettings + campaignId were missing: toggling Attire or
    // Auto-regen in the Engine popover didn't re-render existing scene
    // dividers (react-query structural sharing keeps the messages reference).
    // session.modelId was missing: renderMessage closes over resolveScene/
    // saveSceneEdit which capture session.modelId; without it in the deps, switching
    // the model and then using "Agree with validator & regenerate" streamed on the
    // STALE model captured at the last memo computation.
    [messages, editingMessageId, mutatingMessageId, copiedMessageId, localSearchNeedle, activeSearchMessageId, sending, generatingImage, session.cacheTtl, session.campaignId, session.modelId, availableChatModels, resolvedContextSettings.sceneValidatorAutoRegen, resolvedContextSettings.attireTrackingEnabled, nextTurn],
  );

  // Historical (scene jump) renders pass index = -1: the live-array-indexed
  // actions (Resend/Regen/Cut) are gated off inside renderMessage, while the
  // object/id-based ones (Copy/Edit/Delete/variant swipe) stay available.
  const historicalViewElements = useMemo(
    () => (historicalView ? historicalView.pages.map((m) => renderMessage(m, -1)) : null),
    // Same dep rationale as historicalElements above (renderMessage closures).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historicalView, editingMessageId, mutatingMessageId, copiedMessageId, localSearchNeedle, activeSearchMessageId, sending, generatingImage, session.cacheTtl, session.campaignId, session.modelId, availableChatModels, resolvedContextSettings.sceneValidatorAutoRegen, resolvedContextSettings.attireTrackingEnabled, nextTurn],
  );

  const pendingElements = useMemo(() => {
    const out: React.ReactNode[] = [];
    let i = messages.length;
    if (streamState.pendingPrompt && !pendingAlreadyPersisted) {
      out.push(renderMessage({
        id: "pending-user", sessionId: session.id, role: "user", content: streamState.pendingPrompt,
        thinking: null, modelId: null, usage: null, stopReason: null, stopDetails: null, fastMode: false, rollOverride: false, servedModel: null, directiveKind: streamState.pendingPrompt.startsWith(SPOTLIGHT_PENDING_PREFIX) ? "gm_spotlight" : null,
        sceneData: null, sceneValidator: null, sceneResolution: null, overhead: null,
        variantGroupId: null, variantIndex: 0, variantCount: 1, variantSiblingIds: [],
        sortOrder: Number.MAX_SAFE_INTEGER - 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        attachments: streamState.pendingAttachments.map((attachment, idx) => ({
          id: `pending-${idx}`, messageId: "pending-user",
          filename: attachment.filename, mimeType: attachment.mimeType,
          contentMode: attachment.contentMode, content: attachment.content,
          createdAt: new Date().toISOString(),
        })),
        generatedImages: [],
      }, i++));
    }
    if (streamState.sending && !streamState.completed && !streamState.streamingText && !streamState.streamingThinking) {
      // Nothing has streamed yet — show what the server is doing instead of dead air.
      // Context assembly (retrieval/researcher/HyDE) runs before response.started;
      // after it, large campaigns can sit in model ingestion for a minute. Gated
      // on `completed` too: an empty-text reply (refusal card, thinking-only
      // turn) streams no deltas, and `sending` alone stays true for the whole
      // validator phase — the card lingered under the persisted reply.
      const waitingModelLabel = session.modelId
        ? (findChatModel(availableChatModels, session.modelId)?.label ?? getChatModel(session.modelId)?.label ?? session.modelId)
        : "the model";
      out.push(
        <article key="pending-wait" className="message-card role-assistant msg-waiting-card">
          <div className="message-heading">
            <p className="message-role">Assistant</p>
            <span className="muted small-copy">{waitingModelLabel}</span>
          </div>
          <div className="msg-waiting-row">
            <img className="msg-waiting-motif" src="/brand/thinking-motif.webp" alt="" width="720" height="720" aria-hidden="true" /><span className="msg-waiting-dots" aria-hidden="true"><span /><span /><span /></span>
            <span>{streamState.responseStarted
              ? `Waiting for ${waitingModelLabel} — large campaigns can take a minute before the first tokens arrive`
              : "Assembling context — retrieval, researcher, and scene state"}</span>
            <ElapsedTimer />
          </div>
        </article>,
      );
    }
    const assistantPersisted = Boolean(
      streamState.completedMessageId && messages.some((m) => m.id === streamState.completedMessageId),
    );
    if ((streamState.streamingText || streamState.streamingThinking) && !assistantPersisted) {
      out.push(renderMessage({
        id: "pending-assistant", sessionId: session.id, role: "assistant",
        content: streamState.streamingText, thinking: streamState.streamingThinking || null,
        modelId: session.modelId, usage: null, stopReason: null, stopDetails: null, fastMode: false, rollOverride: false, servedModel: null, directiveKind: null,
        sceneData: null, sceneValidator: null, sceneResolution: null, overhead: null,
        variantGroupId: null, variantIndex: 0, variantCount: 1, variantSiblingIds: [],
        sortOrder: Number.MAX_SAFE_INTEGER,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        attachments: [], generatedImages: [],
      }, i++));
    }
    return out;
  }, [streamState.pendingPrompt, streamState.pendingAttachments, streamState.streamingText, streamState.streamingThinking, streamState.sending, streamState.responseStarted, streamState.completedMessageId, pendingAlreadyPersisted, messages, session.id, session.modelId, availableChatModels]);

  return (
    <section className="detail-panel conversation-shell">
      <div className="detail-head">
        <h3>{session.name}</h3>
        <div className="row gap-sm">
          <div className="model-picker" ref={modelMenuRef}>
            <button
              type="button"
              aria-label="Chat model"
              className="model-picker-btn"
              disabled={savingModel || sending || generatingImage}
              onClick={() => {
                setModelMenuOpen((open) => !open);
                setModelMenuProvider((current) => current ?? selectedModel?.provider ?? chatModelGroups[0]?.provider ?? null);
              }}
            >
              <span>{selectedModel?.label ?? session.modelId ?? "Select model"}{modelUnavailable ? " (unavailable)" : ""}</span>
              <span className="chevron"><Icon name={modelMenuOpen ? "chevron-up" : "chevron-down"} size={14} /></span>
            </button>
            {modelMenuOpen ? (
              <div className="model-menu">
                {modelUnavailable ? <button type="button" className="model-menu-item active" disabled>{selectedModel?.label ?? session.modelId} — configure its provider key or choose another model</button> : null}
                {chatModelGroups.map((group) => (
                  <div key={group.provider}>
                    <button
                      type="button"
                      className={`model-menu-provider ${modelMenuProvider === group.provider ? "open" : ""}`}
                      onClick={() => setModelMenuProvider((current) => current === group.provider ? null : group.provider)}
                    >
                      <span>{group.label}</span>
                      <span className="chevron"><Icon name={modelMenuProvider === group.provider ? "chevron-down" : "chevron-right"} size={14} /></span>
                    </button>
                    {modelMenuProvider === group.provider ? (
                      <div className="model-menu-items">
                        {group.models.map((model) => {
                          const overCurrentContext = isModelOverCurrentContext(model, estimatedContextTokens);
                          return (
                            <button
                              key={model.id}
                              type="button"
                              className={`model-menu-item ${model.id === session.modelId ? "active" : ""}`}
                              disabled={savingModel}
                              onClick={async () => {
                                if (model.id === session.modelId) {
                                  setModelMenuOpen(false);
                                  setModelMenuProvider(null);
                                  return;
                                }
                                setSavingModel(true);
                                setSendError("");
                                try {
                                  await updateSession(session.id, { modelId: model.id });
                                  await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
                                  setModelMenuOpen(false);
                                  setModelMenuProvider(null);
                                } catch (error) {
                                  setSendError(error instanceof Error ? error.message : "model update failed");
                                } finally {
                                  setSavingModel(false);
                                }
                              }}
                            >
                              <span>{model.label}</span>
                              {overCurrentContext ? (
                                <span className="model-menu-overlimit">
                                  Over current context · ~{estimatedContextTokens.toLocaleString()} / {model.ctx?.toLocaleString()} ctx
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {!isWizardSession ? (
            <>
              {session.campaignId ? (
                <>
                  <button
                    type="button"
                    className="tb-btn"
                    onClick={() => setAuditDialogOpen(true)}
                    disabled={sending}
                    title="Campaign Audit — reconcile the lorebook against the whole story (quick or full); fixes auto-apply behind an adversarial check"
                  >
                    Campaign Audit
                  </button>
                  <PipelineQueuePill campaignId={session.campaignId} />
                </>
              ) : linkingCampaign ? (
                <>
                  <select
                    aria-label="Link to campaign"
                    className="tb-btn"
                    defaultValue=""
                    onChange={(event) => {
                      if (event.target.value) linkCampaignMutation.mutate(event.target.value);
                    }}
                    disabled={linkCampaignMutation.isPending || !campaignsQuery.data?.campaigns.length}
                    autoFocus
                  >
                    <option value="" disabled>Select campaign...</option>
                    {campaignsQuery.data?.campaigns.map((campaign) => (
                      <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
                    ))}
                  </select>
                  <button type="button" className="tb-btn" onClick={() => setLinkingCampaign(false)} disabled={linkCampaignMutation.isPending}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => setLinkingCampaign(true)}
                  disabled={sending || !campaignsQuery.data?.campaigns.length}
                  title={campaignsQuery.data?.campaigns.length ? "Link this session to an existing campaign" : "No campaigns available — create one first"}
                >
                  <Icon name="link" size={13} /> Link to Campaign
                </button>
              )}
              <select aria-label="Image model" className="tb-btn" value={imageModelId} onChange={(event) => setImageModelId(event.target.value)} disabled={generatingImage || sending} style={{ cursor: "pointer" }}>
                {IMAGE_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
              <button type="button" className="tb-btn" onClick={exportConversation} disabled={exporting || sending || generatingImage}>
                {exporting ? "…" : <><Icon name="download" size={13} /> Export</>}
              </button>
            </>
          ) : null}
        </div>
        {contextWarning ? <p className="context-warning small-copy">{contextWarning}</p> : null}
      </div>

      {/* Compact status strip: chips that open popovers. Replaces 4 stacked control bars. */}
      {(!isWizardSession || campaign) ? (
        <div className="chat-status-strip">
          {!isWizardSession ? (
            <button
              ref={sessionChipRef}
              type="button"
              className={`chat-status-chip${sessionPopoverOpen ? " active" : ""}`}
              onClick={() => setSessionPopoverOpen((o) => !o)}
              disabled={savingSessionSettings}
            >
              <span>Session</span>
              <span className="chat-status-chip-divider">·</span>
              <span>{session.autoScroll ? "Auto" : "Manual"}</span>
              {sessionEffortOnWire ? (
                <>
                  <span className="chat-status-chip-divider">·</span>
                  <span>{effortLabel(sessionEffortOnWire)}</span>
                </>
              ) : null}
            </button>
          ) : null}
          {campaign ? (
            <>
              <button
                ref={engineChipRef}
                type="button"
                className={`chat-status-chip${enginePopoverOpen ? " active" : ""}`}
                onClick={() => setEnginePopoverOpen((o) => !o)}
                disabled={savingSessionSettings}
                /* 2026-09-24: first "R:… · L:…/4" read as a code, then the words made the
                   chip "huge" — the label is just the name now; the researcher model lives in the
                   tooltip and every model on the dialog's pages. Catalog labels, not id-splitting.
                   The rolling-diff clause went with its switch and cadence. */
                title={`Context Engine settings\nResearcher: ${resolvedContextSettings.researcherEnabled ? chatModelLabel(availableChatModels, resolvedContextSettings.researcherModel) : "off"}`}
              >
                <Icon name="sliders" size={12} /><span>Context Engine</span>
              </button>
              {(() => {
                // Live stream state first, else the newest reply's stored snapshot.
                const view = chipContextView;
                const usedTokens = view?.debug?.totalTokens ?? 0;
                const budget = view?.budgetTokens || 1;
                const ratio = Math.min(1, usedTokens / budget);
                const included = view ? view.preview.filter((e) => e.included).length : 0;
                const hasData = Boolean(view && view.preview.length > 0);
                const degraded = Boolean(view && view.notes.length > 0);
                return (
                  <button
                    ref={previewChipRef}
                    type="button"
                    className={`chat-status-chip${previewPopoverOpen ? " active" : ""}${degraded ? " degraded" : ""}`}
                    onClick={() => setPreviewPopoverOpen((o) => !o)}
                    title={degraded ? view!.notes.join("\n") : view?.reply ? contextPreviewTitle(view) : undefined}
                  >
                    <span>{degraded ? <><Icon name="alert" size={12} /> Preview</> : "Preview"}</span>
                    <span className="chat-status-chip-divider">·</span>
                    {hasData ? (
                      <>
                        <span>{included}e</span>
                        <span className="chat-status-chip-divider">·</span>
                        <span>{usedTokens.toLocaleString()} / {budget.toLocaleString()} tok</span>
                        <span className="chat-status-chip-bar" aria-hidden="true">
                          <span className="chat-status-chip-bar-fill" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
                        </span>
                      </>
                    ) : (
                      <span>No data</span>
                    )}
                  </button>
                );
              })()}
              <button
                ref={threadsChipRef}
                type="button"
                className={`chat-status-chip${threadsPopoverOpen ? " active" : ""}${threadsUnread ? " degraded" : ""}`}
                onClick={() => setThreadsPopoverOpen((o) => !o)}
                title={threadsUnread ? "The thread tracker could not be read" : "Pending narrative threads"}
              >
                <span>Threads</span>
                <span className="chat-status-chip-divider">·</span>
                <span>{threadsUnread ? <Icon name="alert" size={12} /> : threadData.active}</span>
              </button>
              {(findingsOpenCount > 0 || findingsProcessing) && (
                <button
                  type="button"
                  className={`chat-status-chip audit-findings-chip${findingsOpenCount > 0 ? " glow" : ""}${findingsDialogOpen ? " active" : ""}`}
                  onClick={() => setFindingsDialogOpen(true)}
                  title={findingsProcessing && findingsOpenCount === 0
                    ? "Your rulings are being executed"
                    : "The campaign audit flagged findings it couldn't settle — your ruling needed"}
                >
                  <span><Icon name="scale" size={13} /> Findings</span>
                  <span className="chat-status-chip-divider">·</span>
                  <span>{findingsProcessing && findingsOpenCount === 0 ? "…" : findingsOpenCount}</span>
                </button>
              )}
              {(castCards.length > 0 || castUnread) && (
                <button
                  ref={castChipRef}
                  type="button"
                  className={`chat-status-chip cast-chip${castPopoverOpen ? " active" : ""}${castUnread ? " degraded" : ""}`}
                  onClick={() => setCastPopoverOpen((o) => !o)}
                  title={castUnread ? "The drive sheets could not be read" : "Present characters' agendas"}
                >
                  <span><Icon name="masks" size={13} /> Cast</span>
                  <span className="chat-status-chip-divider">·</span>
                  <span>{castUnread ? <Icon name="alert" size={12} /> : castCards.length}</span>
                </button>
              )}
              {((worldStatusQuery.data?.beats.length ?? 0) > 0 || beatsUnread) && (
                <button
                  ref={beatsChipRef}
                  type="button"
                  className={`chat-status-chip${beatsPopoverOpen ? " active" : ""}${dueBeats.length > 0 || beatsUnread ? " degraded" : ""}`}
                  onClick={() => setBeatsPopoverOpen((o) => !o)}
                  title={beatsUnread ? "The scheduled beats could not be read" : "Scheduled world beats"}
                >
                  <span>⏱ Beats</span>
                  <span className="chat-status-chip-divider">·</span>
                  <span>{beatsUnread ? <Icon name="alert" size={12} /> : dueBeats.length > 0 ? `${dueBeats.length} due` : worldStatusQuery.data?.beats.length ?? 0}</span>
                </button>
              )}
              <button
                ref={scenesChipRef}
                type="button"
                className={`chat-status-chip${scenesPopoverOpen ? " active" : ""}`}
                onClick={() => setScenesPopoverOpen((o) => !o)}
                title="Scene outline — jump to a scene break"
              >
                <span>Scenes</span>
                {sceneOutlineQuery.data ? (
                  <>
                    <span className="chat-status-chip-divider">·</span>
                    <span>{sceneOutlineQuery.data.entries.length}</span>
                  </>
                ) : null}
              </button>
              <button
                ref={campaignChipRef}
                type="button"
                className={`chat-status-chip${campaignPopoverOpen ? " active" : ""}`}
                onClick={() => setCampaignPopoverOpen((o) => !o)}
              >
                <span>{campaign.name}</span>
                <span className="chat-status-chip-divider">·</span>
                <span>v{campaign.version}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {!isWizardSession ? (
        <Popover
          open={sessionPopoverOpen}
          anchorRef={sessionChipRef}
          onClose={() => setSessionPopoverOpen(false)}
          title={`Session · ${selectedModel?.label ?? "Unknown"}`}
          width={420}
        >
          <div className="ctrl-bar">
            <button
              type="button"
              className={`toggle-pill ${session.autoScroll ? "active" : ""}`}
              onClick={() => saveSessionSettings({ autoScroll: !session.autoScroll })}
              disabled={savingSessionSettings || sending || generatingImage}
            >
              ⇩ Auto-scroll
            </button>
            <button
              type="button"
              className={`toggle-pill ${notifyEnabled ? "active" : ""}`}
              title="When this tab is in the background, flash the title and send a browser notification when a response finishes"
              onClick={async () => {
                const next = !notifyEnabled;
                // The pill shows the EFFECTIVE state the notifier returns — a
                // dismissed prompt used to leave it lit with nothing able to
                // fire. Enabling waits for the permission prompt.
                const effective = await setNotifyOnCompleteEnabled(next);
                setNotifyEnabled(effective);
                if (next && !effective) emitGlobalToast(describeNotifyUnavailable(), "info");
              }}
            >
              <Icon name="bell" size={13} /> Notify
            </button>
            {selectedModel?.supportsCacheTtl ? (
              <>
                <div className="ctrl-divider" />
                <div className="ctrl-group">
                  <span className="lbl">Cache</span>
                  <select
                    aria-label="Cache TTL"
                    value={session.cacheTtl}
                    disabled={savingSessionSettings || sending || generatingImage}
                    onChange={(event) => saveSessionSettings({ cacheTtl: event.target.value })}
                  >
                    <option value="off">Off</option>
                    <option value="5m">5 min</option>
                    <option value="1h">1 hr</option>
                  </select>
                </div>
              </>
            ) : null}
            {selectedCatalogModel?.thinkingAlwaysOn ? (() => {
              // Worded per catalog flags: "Adaptive" only where the entry
              // supports adaptive thinking; GLM-5.3 / K3 run at the Effort
              // dial, 2.5 Pro / GLM-5.3-flash at their own depth.
              const alwaysOn = describeAlwaysOnThinking(selectedCatalogModel);
              return (
                <>
                  <div className="ctrl-divider" />
                  <div className="ctrl-group">
                    <span className="lbl">Thinking</span>
                    <select
                      aria-label="Thinking mode (always on for this model)"
                      value="always-on"
                      disabled
                      title={alwaysOn.title}
                    >
                      <option value="always-on">{alwaysOn.label}</option>
                    </select>
                  </div>
                </>
              );
            })() : selectedModel?.supportsThinkingBudget ? (
              <>
                <div className="ctrl-divider" />
                <div className="ctrl-group">
                  <span className="lbl">Thinking</span>
                  <select
                    aria-label="Thinking mode"
                    value={session.thinkingMode}
                    disabled={savingSessionSettings || sending || generatingImage}
                    onChange={(event) => saveSessionSettings({ thinkingMode: event.target.value })}
                  >
                    <option value="off">Off</option>
                    <option value="enabled">Budget</option>
                    {selectedModel.supportsAdaptiveThinking ? <option value="adaptive">Adaptive</option> : null}
                  </select>
                </div>
                {session.thinkingMode !== "off" && session.thinkingMode !== "adaptive" ? (() => {
                  const budget = thinkingBudgetBounds(selectedModel);
                  return (
                    <div className="ctrl-group">
                      <span className="lbl">Budget</span>
                      <NumericInput
                        aria-label="Thinking budget"
                        min={budget.min}
                        max={budget.max}
                        value={effectiveThinkingBudget(selectedModel, session.thinkingBudget)}
                        disabled={savingSessionSettings || sending || generatingImage}
                        onChange={(v) => saveSessionSettings({ thinkingBudget: v })}
                      />
                    </div>
                  );
                })() : null}
              </>
            ) : selectedModel?.supportsAdaptiveThinking ? (
              <>
                <div className="ctrl-divider" />
                <div className="ctrl-group">
                  <span className="lbl">Thinking</span>
                  <select
                    aria-label="Thinking mode"
                    value={session.thinkingMode === "off" ? "off" : "adaptive"}
                    disabled={savingSessionSettings || sending || generatingImage}
                    onChange={(event) => saveSessionSettings({ thinkingMode: event.target.value })}
                  >
                    <option value="off">Off</option>
                    <option value="adaptive">Adaptive</option>
                  </select>
                </div>
              </>
            ) : selectedModel?.supportsToggleThinking ? (
              <>
                <div className="ctrl-divider" />
                <div className="ctrl-group">
                  <span className="lbl">Thinking</span>
                  <select
                    aria-label="Thinking mode"
                    value={session.thinkingMode === "off" ? "off" : "enabled"}
                    disabled={savingSessionSettings || sending || generatingImage}
                    onChange={(event) => saveSessionSettings({ thinkingMode: event.target.value })}
                  >
                    <option value="off">Off</option>
                    <option value="enabled">On</option>
                  </select>
                </div>
              </>
            ) : null}
            {selectedModel?.supportsEffort && !(selectedModel.supportsToggleThinking && session.thinkingMode === "off") ? (
              <>
                <div className="ctrl-divider" />
                <div className="ctrl-group">
                  <span className="lbl">{selectedModel.provider === "google" ? "Thinking" : "Effort"}</span>
                  {/* Shows the effort the turn sends (a null or stale session value, the Opus 5 cap
                      while thinking is off), never a rung the server does not run. Every
                      effort model is a catalog entry; custom endpoints carry no effort ladder. */}
                  {selectedCatalogModel ? (
                    <EffortSelect
                      model={selectedCatalogModel}
                      saved={session.effort}
                      thinkingMode={session.thinkingMode}
                      ariaLabel={selectedModel.provider === "google" ? "Thinking level" : "Reasoning effort"}
                      disabled={savingSessionSettings || sending || generatingImage}
                      onChange={(settings) => saveSessionSettings(settings)}
                    />
                  ) : null}
                </div>
              </>
            ) : null}
            {(() => {
              // Capability-driven, ONE switch per provider family (2026-09-09):
              // direct Anthropic fast pricing toggles `fastModeEnabled`; every
              // supported OpenAI model (direct Astra, tiered CodexBridge) toggles
              // the Engine panel's `openaiFastModeEnabled`, which also governs the
              // helpers and workers. Claude bridges stay out by design.
              // The server only resolves per-session context settings for
              // CAMPAIGN sessions (chatService's isCampaignSession guard) — on a
              // plain session the toggle lit up, persisted, and did nothing.
              const openaiFast = Boolean(selectedModel && supportsOpenAIFastMode(selectedCatalogModel) && Boolean(session.campaignId));
              const anthropicFast = Boolean(selectedModel
                && selectedModel.provider === "anthropic"
                && selectedCatalogModel?.fastModeInputCostPerMillionTokens != null
                && Boolean(session.campaignId));
              if (!openaiFast && !anthropicFast) return null;
              const dialKey = openaiFast ? "openaiFastModeEnabled" : "fastModeEnabled";
              const isOn = Boolean(resolvedContextSettings[dialKey]);
              const isBridge = selectedModel?.provider === "codex-bridge";
              return (
                <>
                  <div className="ctrl-divider" />
                  <div className="ctrl-group">
                    <button
                      type="button"
                      className={`fast-mode-toggle${isOn ? " is-on" : ""}`}
                      title={(() => {
                        const std = selectedCatalogModel?.inputCostPerMillionTokens;
                        const fast = selectedCatalogModel?.fastModeInputCostPerMillionTokens;
                        const cost = isBridge ? "no extra charge, but faster subscription-usage burn" : `${std && fast ? `~${Math.round(fast / std)}×` : "higher"} cost`;
                        const scope = openaiFast ? " Same switch as the Engine panel's 'Use Fast Mode for Supported OpenAI Models' — it also governs the helpers and pipeline workers." : "";
                        return isOn
                          ? `Fast mode ON — faster output at ${cost}. Click to disable.${selectedModel?.provider === "anthropic" ? " Toggling invalidates prompt cache." : ""}${scope}`
                          : `Fast mode OFF — toggle on for fast inference (${cost}).${selectedModel?.provider === "anthropic" ? " Requires account approval." : ""}${scope}`;
                      })()}
                      disabled={savingSessionSettings || sending || generatingImage}
                      onClick={() => saveSessionSettings({ contextOverrides: { [dialKey]: !isOn } })}
                    >
                      <span className="bolt"><Icon name="zap" size={13} /></span> Fast
                    </button>
                  </div>
                </>
              );
            })()}
            {showTemperatureControl ? (
              <>
                <div className="ctrl-divider" />
                <div className="ctrl-group">
                  <span className="lbl">Temp</span>
                  <NumericInput
                    aria-label="Temperature"
                    min={0}
                    max={2}
                    step={0.05}
                    value={session.temperature}
                    disabled={savingSessionSettings || sending || generatingImage}
                    onChange={(v) => saveSessionSettings({ temperature: v })}
                  />
                </div>
              </>
            ) : null}
          </div>
        </Popover>
      ) : null}

      {/* A reply card's Context action: the same content, for that reply's stored snapshot. */}
      <Popover
        open={Boolean(contextReply)}
        anchorRef={contextReplyAnchorRef}
        onClose={() => setContextReply(null)}
        align="end"
        title={contextPreviewTitle(replyContextView, contextReply)}
        width={520}
      >
        <ContextPreviewContent
          view={replyContextView}
          emptyText={contextReplyQuery.isError ? "This reply's stored context could not be loaded."
            : replyContextView ? "No lorebook entries were scored for this reply."
            : "Loading this reply's stored context…"}
          composerLabel={replyContextView?.reply ? chatModelLabel(availableChatModels, replyContextView.reply.modelId) : undefined}
        />
      </Popover>

      {campaign ? (
        <>
          <EngineSettingsDialog
            open={enginePopoverOpen}
            onClose={() => setEnginePopoverOpen(false)}
            settings={resolvedContextSettings}
            save={saveSessionSettings}
            disabled={savingSessionSettings || sending}
            models={availableChatModels}
            config={providerConfig.data}
            hasCampaign={Boolean(session.campaignId)}
            onAdvanceWorld={() => { setEnginePopoverOpen(false); setWorldDialogOpen(true); }}
            sessionId={session.id}
            modelId={session.modelId ?? null}
            onOpenDrives={session.campaignId && onOpenDrives ? () => { setEnginePopoverOpen(false); onOpenDrives(session.campaignId!); } : undefined}
            isAdmin={isAdmin}
          />

          <Popover
            open={previewPopoverOpen}
            anchorRef={previewChipRef}
            onClose={() => setPreviewPopoverOpen(false)}
            title={contextPreviewTitle(chipContextView)}
            width={520}
          >
            <ContextPreviewContent
              view={chipContextView}
              emptyText={chipContextEmptyText(chipSource, streamState, { isError: newestSnapshotQuery.isError, loaded: chipContextView != null })}
              composerLabel={chipContextView?.reply ? chatModelLabel(availableChatModels, chipContextView.reply.modelId) : undefined}
            />
          </Popover>

          <Popover
            open={campaignPopoverOpen}
            anchorRef={campaignChipRef}
            onClose={() => setCampaignPopoverOpen(false)}
            title={`Campaign · ${campaign.name} · v${campaign.version}`}
            width={520}
          >
            <div className="popover-section">
              <div className="popover-section-title">System Prompt</div>
              <textarea className="popover-syslimit-textarea" readOnly value={campaign.systemPrompt || "No system prompt."} />
            </div>
            <div className="popover-section">
              <div className="popover-section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1 }}><Icon name="globe" size={13} /> World (Living World)</span>
                <button
                  type="button"
                  className="ghost-button"
                  style={{ fontSize: 11 }}
                  onClick={() => { setCampaignPopoverOpen(false); setWorldDialogOpen(true); }}
                  title="Simulate what the NPCs did offscreen — proposals are reviewed before anything becomes canon"
                >
                  Advance the world…
                </button>
              </div>
              <WorldClockLine query={worldStatusQuery} />
            </div>
            <StorySoFarSection query={recapQuery} busy={recapBusy} onRecap={() => recapMutation.mutate()} />
          </Popover>

          <Popover
            open={threadsPopoverOpen}
            anchorRef={threadsChipRef}
            onClose={() => setThreadsPopoverOpen(false)}
            title={threadsQuery.data ? `Threads · ${threadData.active} active` : "Threads"}
            width={520}
          >
            <ThreadsContent query={threadsQuery} />
          </Popover>

          <Popover
            open={castPopoverOpen}
            anchorRef={castChipRef}
            onClose={() => setCastPopoverOpen(false)}
            title={drivesQuery.data ? `Cast · ${castCards.length} present` : "Cast"}
            width={360}
          >
            <CastCardsContent
              query={drivesQuery}
              cards={castCards}
              presentAware={presentInScene.present}
              onEditSheet={(name) => { setCastPopoverOpen(false); onOpenDrives?.(session.campaignId!, name); }}
            />
          </Popover>

          <Popover
            open={beatsPopoverOpen}
            anchorRef={beatsChipRef}
            onClose={() => setBeatsPopoverOpen(false)}
            title={worldStatusQuery.data ? `Scheduled beats · ${dueBeats.length} due` : "Scheduled beats"}
            width={400}
          >
            <ScheduledBeatsList campaignId={session.campaignId!} query={worldStatusQuery} />
          </Popover>

          <Popover
            open={spotlightMenuOpen}
            anchorRef={spotlightBtnRef}
            onClose={() => setSpotlightMenuOpen(false)}
            title="Hand the scene to an NPC"
            width={340}
          >
            {(() => {
              const presentNames = spotlightPresentNames;
              const sheetNames = spotlightSheetNames;
              const options = spotlightOptions;
              // Always a member of `options` (or the typed name when there are
              // none), so the select shows exactly what "Hand the scene" sends —
              // a stored name that had left the scene used to be sent while the
              // select displayed the first present character.
              const chosen = spotlightChoice;
              const handInScene = () => {
                const name = chosen.trim();
                if (!name || sending) return;
                setSpotlightMenuOpen(false);
                const steer = spotlightSteer.trim();
                setSpotlightSteer("");
                void sendMessage({ spotlight: { characterName: name, ...(steer ? { steer } : {}) } });
              };
              return (
                <div className="cast-popover-card">
                  <p className="muted small-copy" style={{ margin: 0 }}>The next beat will be driven by this character's agenda. Your character stays hands-off.</p>
                  <label className="lbl">Character</label>
                  {options.length > 0 ? (
                    <select value={chosen} onChange={(e) => setSpotlightChar(e.target.value)}>
                      {presentNames.length > 0 && <optgroup label="Present in scene">{presentNames.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>}
                      {sheetNames.filter((n) => !presentNames.includes(n)).length > 0 && (
                        <optgroup label="Other sheet-holders">{sheetNames.filter((n) => !presentNames.includes(n)).map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>
                      )}
                    </select>
                  ) : (
                    <input placeholder="character name…" value={spotlightChar} onChange={(e) => setSpotlightChar(e.target.value)} />
                  )}
                  <label className="lbl">Steer (optional)</label>
                  <input placeholder="e.g. lean toward the Council subplot" value={spotlightSteer} onChange={(e) => setSpotlightSteer(e.target.value)} onKeyDown={(e) => { if (isEnterKey(e)) handInScene(); }} />
                  <button type="button" className="primary-button" disabled={!chosen.trim() || sending} onClick={handInScene}><Icon name="masks" size={14} /> Hand the scene</button>
                </div>
              );
            })()}
          </Popover>

          <Popover
            open={scenesPopoverOpen}
            anchorRef={scenesChipRef}
            onClose={() => { setScenesPopoverOpen(false); setSceneSearch(""); }}
            title={`Scenes${sceneOutlineQuery.data ? ` · ${sceneOutlineQuery.data.entries.length} breaks` : ""}`}
            width={420}
          >
            <SceneOutlineContent
              query={sceneOutlineQuery}
              groups={sceneGroups}
              search={sceneSearch}
              onSearch={setSceneSearch}
              onJump={(entry) => void jumpToScene(entry)}
              jumpBusy={historicalLoading === "jump"}
            />
          </Popover>
        </>
      ) : null}

      {isWizardSession ? (
        <div className="inline-panel stack stack-tight wizard-status-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Wizard Flow</p>
              <h3>Conversation-Driven Campaign Setup</h3>
            </div>
            <span className="muted small-copy">{wizardReady ? "Ready to generate" : "Still collecting details"}</span>
          </div>
          <p className="muted small-copy">
            This session uses the dedicated campaign wizard prompt and your saved example templates. Keep chatting until the assistant emits `[WIZARD_READY]`, then launch document generation from this session.
          </p>
          {wizardRun ? (
            <p className="muted small-copy">Wizard run status: {wizardRun.status}. Open the dedicated wizard review from the shell activity panel once the run is ready.</p>
          ) : null}
        </div>
      ) : null}

      <div className="conversation-panel">
        {localSearchOpen ? (
          <div className="message-search-panel">
            <div className="row gap-sm">
              <input
                ref={searchInputRef}
                aria-label="Search current session"
                placeholder="Find in this session"
                value={localSearchQuery}
                onChange={(event) => setLocalSearchQuery(event.target.value)}
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => setActiveSearchIndex((current) => current <= 0 ? localSearchMatches.length - 1 : current - 1)}
                disabled={!localSearchMatches.length}
              >
                Previous
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setActiveSearchIndex((current) => current >= localSearchMatches.length - 1 ? 0 : current + 1)}
                disabled={!localSearchMatches.length}
              >
                Next
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setLocalSearchOpen(false);
                  setLocalSearchQuery("");
                  setActiveSearchIndex(0);
                }}
              >
                Close
              </button>
            </div>
            <p className="muted small-copy">
              {localSearchMatches.length ? `${activeSearchIndex + 1} / ${localSearchMatches.length} matches` : "No matches in this session."}
              {hasOlder ? " · searching loaded messages — load older to search further back" : ""}
            </p>
          </div>
        ) : null}
        <div className="message-list" ref={messageListRef}>
          {detail.isLoading ? <p className="muted">Loading conversation...</p> : null}
          {historicalView ? (
            // Scene-jump historical view — replaces the live transcript until the
            // user exits back to latest. Pages both directions from the jump cursor.
            <>
              <div style={{ position: "sticky", top: 0, zIndex: 4, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 12px", marginBottom: 8, background: "var(--surface)", border: "1px solid var(--surface-border)", borderRadius: 8 }}>
                <span className="muted small-copy">Viewing past scene</span>
                <button type="button" className="secondary-button" onClick={exitHistoricalView}>
                  ↓ Back to latest
                </button>
              </div>
              {historicalView.hasOlder ? (
                <div style={{ display: "flex", justifyContent: "center", padding: "4px 0 12px" }}>
                  <button type="button" className="secondary-button" onClick={() => void loadHistoricalOlder()} disabled={historicalLoading != null}>
                    {historicalLoading === "older" ? "Loading older..." : "Load older"}
                  </button>
                </div>
              ) : null}
              {historicalViewElements}
              {historicalView.hasNewer ? (
                <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 4px" }}>
                  <button type="button" className="secondary-button" onClick={() => void loadHistoricalNewer()} disabled={historicalLoading != null}>
                    {historicalLoading === "newer" ? "Loading newer..." : "Load newer (more below)"}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {!detail.isLoading && hasOlder ? (
                <div style={{ display: "flex", justifyContent: "center", padding: "4px 0 12px" }}>
                  <button type="button" className="secondary-button" onClick={loadOlder} disabled={loadingOlder}>
                    {loadOlderLabel(loadingOlder, olderRemaining, gapFill != null)}
                  </button>
                </div>
              ) : null}
              {!detail.isLoading && renderedMessages.length === 0 ? <div className="conversation-empty"><img className="conversation-empty-art" src="/brand/thinking-motif.webp" alt="" width="720" height="720" loading="lazy" /><p className="muted">{isWizardSession ? "The wizard will guide campaign setup through chat." : "Send the first message to start the session."}</p></div> : null}
              {gapFill ? withGapMarkers(historicalElements, messages, gapMarkerIndexes(messages, gapFill.gaps)) : historicalElements}
              {pendingElements}
            </>
          )}
        </div>
        {!nearBottom || historicalView ? (
          // Floating jump-to-latest — visible whenever the user has scrolled away
          // from the bottom (same nearBottom signal that gates autoscroll). In the
          // historical view it's always shown and exits the view entirely.
          <div style={{ position: "relative", height: 0 }}>
            <button
              type="button"
              // .jump-latest-btn carries the floating shadow in base.css (CSS
              // owns literal colors; the inline rgba it replaced did not).
              className="secondary-button jump-latest-btn"
              style={{ position: "absolute", bottom: 12, right: 24, zIndex: 5, borderRadius: 999, padding: "6px 14px" }}
              onClick={() => {
                if (historicalView) {
                  exitHistoricalView();
                  return;
                }
                const el = messageListRef.current;
                if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              }}
            >
              ↓ Latest
            </button>
          </div>
        ) : null}

        <div className="input-area">
          {attachments.length ? (
            <div className="file-chips">
              {attachments.map((attachment, index) => (
                // Keyed by position: the same file attached twice produced two
                // chips with one key. Removal is by identity, unaffected.
                <span key={`${index}-${attachment.filename}`} className={`file-chip ${isImageAttachment(attachment) ? "image" : isPdfAttachment(attachment) ? "pdf" : "text"}`}>
                  <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.filename}</span>
                  <button type="button" className="file-chip-x" onClick={() => setAttachments((current) => current.filter((item) => item !== attachment))}>×</button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="input-wrap">
            <div className="textarea-grow-wrap">
              <div className="textarea-grow-handle at-top" onMouseDown={startTextareaResize} title="Drag to resize" />
              <textarea
                aria-label="Message prompt"
                placeholder={isWizardSession ? "Answer the wizard..." : "Send a message..."}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={sending}
                onKeyDown={(event) => {
                  // Composition-safe: an IME's Enter (candidate confirmation)
                  // must not send the half-composed text.
                  if (isEnterKey(event) && !event.shiftKey && draft.trim()) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                onPaste={async (event) => {
                  const items = Array.from(event.clipboardData?.items ?? []);
                  const imageItems = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
                  if (!imageItems.length) return;
                  event.preventDefault();
                  // Materialize ALL files synchronously first — the
                  // DataTransferItemList is neutered once the handler yields,
                  // so getAsFile() returned null for every image after the
                  // first await and multi-image pastes silently lost items.
                  const files = imageItems.map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
                  const next: typeof attachments = [];
                  for (const file of files) {
                    try {
                      next.push(await readAttachmentFile(file));
                    } catch (error) {
                      emitGlobalToast(error instanceof Error ? error.message : "attachment could not be read", "error");
                    }
                  }
                  addAttachments(next);
                }}
              />
            </div>
            {/* Composer action bar: input utilities left, scene/generation actions
                + Send right — one equal-sized icon-button grid (Send accented). */}
            <div className="composer-actions">
              <div className="composer-actions-group">
                {!isWizardSession ? (
                  <button type="button" className="composer-btn" onClick={openTemplateDialog} disabled={sending || generatingImage} title="Prompt templates">
                    <Icon name="clipboard" size={18} />
                  </button>
                ) : null}
                <label className="composer-btn" title="Attach files">
                  <Icon name="paperclip" size={18} />
                  <input
                    type="file"
                    accept=".txt,.md,.json,.csv,.pdf,text/plain,text/markdown,application/json,text/csv,application/pdf,image/*"
                    hidden
                    onChange={async (event) => {
                      // Capture the element BEFORE awaiting — React nulls
                      // currentTarget after the sync dispatch, so the old reset
                      // line threw and the same file couldn't be picked twice.
                      const input = event.currentTarget;
                      const files = Array.from(input.files ?? []);
                      const next: ComposerAttachmentInput[] = [];
                      for (const file of files) {
                        try {
                          next.push(await readAttachmentFile(file));
                        } catch (error) {
                          emitGlobalToast(error instanceof Error ? error.message : "attachment could not be read", "error");
                        }
                      }
                      addAttachments(next);
                      input.value = "";
                    }}
                  />
                </label>
              </div>
              <div className="composer-actions-group">
                {!isWizardSession ? (
                  <button type="button" className="composer-btn" onClick={generateImage} disabled={!draft.trim() || generatingImage || sending} title="Generate image from the prompt">
                    <Icon name="image" size={18} />
                  </button>
                ) : null}
                {!isWizardSession && session.campaignId ? (
                  <button
                    ref={spotlightBtnRef}
                    type="button"
                    className="composer-btn"
                    onClick={() => {
                      // Reset a stored choice that is no longer an option (the NPC
                      // left the scene and holds no sheet) so it cannot silently
                      // re-apply when that name returns.
                      setSpotlightChar((current) => spotlightOptions.length > 0 && !spotlightOptions.includes(current) ? "" : current);
                      setSpotlightMenuOpen((o) => !o);
                    }}
                    disabled={sending}
                    title="Hand the scene to an NPC"
                  >
                    <Icon name="masks" size={18} />
                  </button>
                ) : null}
                {!isWizardSession && session.campaignId ? (
                  <button type="button" className="composer-btn" onClick={() => { setSpotlightMenuOpen(false); setWorldDialogOpen(true); }} disabled={sending} title="Advance the world — simulate offscreen events">
                    <Icon name="globe" size={18} />
                  </button>
                ) : null}
                {!isWizardSession && session.campaignId ? (
                  <button
                    type="button"
                    className={`composer-btn is-roll-override${rollOverride ? " is-armed" : ""}`}
                    aria-pressed={rollOverride}
                    onClick={() => setRollOverride(!rollOverride)}
                    disabled={sending}
                    title={rollOverride
                      ? "Roll override ARMED — the next send or regenerate resolves contested rolls in your favor (one action, then disarms; survives page reloads)"
                      : "Roll override — arm to resolve the next send's or regenerate's contested rolls in your favor"}
                  >
                    <Icon name="dice" size={18} />
                  </button>
                ) : null}
                {isWizardSession ? (
                  <button
                    type="button"
                    className={`wizard-ready-btn${wizardReady && !startingWizardRun && !wizardRun && !sending ? " is-ready" : ""}`}
                    onClick={generateCampaignFromWizard}
                    disabled={!wizardReady || startingWizardRun || Boolean(wizardRun) || sending}
                    title={
                      wizardRun
                        ? "Wizard pipeline already running — open the review from the activity panel"
                        : wizardReady
                          ? "The wizard has enough context — click to generate campaign documents"
                          : "Keep chatting until the assistant emits [WIZARD_READY]"
                    }
                  >
                    {startingWizardRun ? "Starting..." : <><Icon name="sparkles" size={14} /> Generate Campaign</>}
                  </button>
                ) : null}
                {sending ? (
                  <button type="button" className="composer-btn is-send is-stop" onClick={stopStreaming} disabled={stopping} title="Stop"><Icon name="stop" size={16} /></button>
                ) : (
                  <button type="button" className="composer-btn is-send" onClick={() => sendMessage()} disabled={!draft.trim() && !attachments.length} title="Send"><Icon name="arrow-up" size={18} /></button>
                )}
              </div>
            </div>
          </div>
          {visibleError ? <p className="error" style={{ maxWidth: 900, margin: "8px auto 0", fontSize: 12 }}>{visibleError}</p> : null}
        </div>

        <div className="status-bar">
          <button type="button" className="status-bar-toggle" onClick={() => setStatusBarOpen((current) => !current)}>
            <Icon name={statusBarOpen ? "chevron-down" : "chevron-right"} size={13} /> Stats{!statusBarOpen ? ` · ${formatEstimateValue(estimatedCost)}${selectedModel?.supportsCacheTtl && cacheHitRate != null ? ` · Hit ${formatPercent(cacheHitRate)}` : ""}` : ""}
          </button>
          {statusBarOpen ? (
            <div className="status-bar-content">
              <div className="status-stat">
                <span className="label">Messages</span>
                <span className="value">{session.messageCount}</span>
              </div>
              <div className="status-stat">
                <span className="label">Tokens</span>
                <span className="value">{usageTotals.totalTokens.toLocaleString()}</span>
              </div>
              <div className="status-stat">
                <span className="label">In / Out</span>
                <span className="value">{usageTotals.inputTokens.toLocaleString()} / {usageTotals.outputTokens.toLocaleString()}</span>
              </div>
              <div className="status-stat" title={describeSessionCostBasis(Boolean(selectedModel?.supportsCacheTtl), session.cacheTtl)}>
                <span className="label">Session</span>
                <span className="value">{formatEstimateValue(estimatedCost)}</span>
              </div>
              <div className="status-stat">
                <span className="label">Context</span>
                <span className="value">{contextMetrics.chars.toLocaleString()}</span>
              </div>
              <div className="status-stat">
                <span className="label">Lines</span>
                <span className="value">{contextMetrics.lines.toLocaleString()}</span>
              </div>
              {selectedModel?.supportsCacheTtl ? (
                <>
                  <div className="status-stat">
                    <span className="label">Read</span>
                    <span className="value">{usageTotals.cacheReadTokens.toLocaleString()}</span>
                  </div>
                  <div className="status-stat">
                    <span className="label">Write</span>
                    <span className="value">{usageTotals.cacheWriteTokens.toLocaleString()}</span>
                  </div>
                  <div className="status-stat">
                    <span className="label">Hit%</span>
                    <span className="value">{formatPercent(cacheHitRate)}</span>
                  </div>
                  {cacheSavings != null && cacheSavings > 0 ? (
                    <div className="status-stat">
                      <span className="label">Saved</span>
                      <span className="value">{formatCostValue(cacheSavings)}</span>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {showTemplateDialog ? (
        <Dialog open onClose={() => setShowTemplateDialog(false)} label="Prompt templates" eyebrow="Prompt Templates" title={editingTemplateId ? "Edit Template" : "Create Template"} icon="clipboard" size="wide" className="template-dialog" closeDisabled={savingTemplate}>
            <div className="stack stack-tight">
              <p className="muted small-copy">Use a saved template as a text attachment so it lands in the message exactly like `v1`.</p>
              <div className="template-dialog-grid">
                <div className="template-list-pane stack stack-tight">
                  <div className="section-head">
                    <div>
                      <p className="eyebrow">Saved</p>
                      <h3>Templates</h3>
                    </div>
                    <button type="button" className="secondary-button" onClick={resetTemplateEditor} disabled={savingTemplate}>
                      New
                    </button>
                  </div>
                  {promptTemplates.isLoading ? <p className="muted small-copy">Loading templates...</p> : null}
                  {promptTemplates.isError ? <p className="error">prompt template request failed</p> : null}
                  {!promptTemplates.isLoading && !promptTemplates.data?.templates.length ? <p className="muted small-copy">No prompt templates saved yet.</p> : null}
                  {promptTemplates.data?.templates.map((template) => (
                    <article key={template.id} className={`template-card${editingTemplateId === template.id ? " is-active" : ""}`}>
                      <div className="template-card-head">
                        <strong>{template.name}</strong>
                        <span className="muted small-copy">{new Date(template.updatedAt).toLocaleString()}</span>
                      </div>
                      <p className="template-preview">{template.content}</p>
                      <div className="row gap-sm wrap-row">
                        <button type="button" className="secondary-button" onClick={() => attachTemplate(template)} disabled={savingTemplate}>
                          Use
                        </button>
                        <button type="button" className="ghost-button" onClick={() => startTemplateEdit(template)} disabled={savingTemplate}>
                          Edit
                        </button>
                        <button type="button" className="ghost-button danger-copy" onClick={() => setConfirmingTemplateDelete(template)} disabled={savingTemplate}>
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="stack stack-tight">
                  <label className="stack stack-tight">
                    <span className="muted small-copy">Template Name</span>
                    <input aria-label="Prompt template name" maxLength={PROMPT_TEMPLATE_NAME_MAX} value={templateNameDraft} onChange={(event) => setTemplateNameDraft(event.target.value)} disabled={savingTemplate} />
                  </label>
                  <label className="stack stack-tight">
                    <span className="muted small-copy">Template Content</span>
                    <textarea
                      aria-label="Prompt template content"
                      className="message-edit-input template-editor"
                      maxLength={PROMPT_TEMPLATE_CONTENT_MAX}
                      value={templateContentDraft}
                      onChange={(event) => setTemplateContentDraft(event.target.value)}
                      disabled={savingTemplate}
                    />
                  </label>
                  {templateError ? <p className="error">{templateError}</p> : null}
                  <div className="row gap-sm end">
                    {editingTemplateId ? (
                      <button type="button" className="secondary-button" onClick={resetTemplateEditor} disabled={savingTemplate}>
                        Cancel
                      </button>
                    ) : null}
                    <button type="button" onClick={saveTemplate} disabled={!templateNameDraft.trim() || !templateContentDraft.trim() || savingTemplate}>
                      {savingTemplate ? "Saving..." : editingTemplateId ? "Save Template" : "Create Template"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
        </Dialog>
      ) : null}

      {confirmingRemoval ? (
        <Dialog open onClose={() => answerRemoval(false)} label="Confirm removing later messages" eyebrow="Message Action" title="Remove Later Messages" icon="alert" size="sm">
          <div className="stack stack-tight">
            <p className="muted">{confirmingRemoval.action} removes {messagesPhrase(confirmingRemoval.count)} after it. They cannot be brought back.</p>
            <div className="row end gap-sm">
              <button type="button" className="secondary-button" onClick={() => answerRemoval(false)}>Cancel</button>
              <button type="button" className="danger-button" onClick={() => answerRemoval(true)}>Remove {confirmingRemoval.count === 1 ? "1 message" : `${confirmingRemoval.count} messages`}</button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {confirmingAction ? (
        <Dialog open onClose={() => setConfirmingAction(null)} label="Confirm message action" eyebrow="Message Action" title={confirmingAction.type === "truncate" ? "Cut After Message" : "Delete Message"} icon={confirmingAction.type === "truncate" ? "scissors" : "trash"} size="sm">
            <div className="stack stack-tight">
              <p className="muted">
                {confirmingAction.type === "truncate"
                  ? (() => {
                      const index = messages.findIndex((message) => message.id === confirmingAction.messageId);
                      if (index < 0) return `Delete everything after ${confirmingAction.label}?`;
                      return `Delete ${messagesPhrase(cutPlan(messages, index + 1).removed)} after ${confirmingAction.label}? They cannot be brought back.`;
                    })()
                  : `Delete ${confirmingAction.label}?`}
              </p>
              {(() => {
                // Deleting the ACTIVE sibling of a ‹n/m› slot: the server promotes
                // the newest remaining sibling, and the returned detail
                // re-renders the swipe chrome — say so instead of leaving the user
                // to guess whether the other variants survive.
                if (confirmingAction.type !== "delete") return null;
                const target = messages.find((m) => m.id === confirmingAction.messageId)
                  ?? historicalView?.pages.find((m) => m.id === confirmingAction.messageId);
                if (!target || target.variantCount <= 1) return null;
                return <p className="muted small-copy">This is variant {target.variantIndex + 1} of {target.variantCount} — the newest remaining variant takes its place in the transcript.</p>;
              })()}
              <div className="row end gap-sm">
                <button type="button" className="secondary-button" onClick={() => setConfirmingAction(null)} disabled={Boolean(mutatingMessageId)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => confirmingAction.type === "truncate" ? truncateAfter(confirmingAction.messageId) : deleteMessage(confirmingAction.messageId)}
                  disabled={Boolean(mutatingMessageId)}
                >
                  {mutatingMessageId === confirmingAction.messageId
                    ? confirmingAction.type === "truncate" ? "Cutting..." : "Deleting..."
                    : confirmingAction.type === "truncate" ? "Cut" : "Delete"}
                </button>
              </div>
            </div>
        </Dialog>
      ) : null}

      {confirmingTemplateDelete ? (
        <Dialog open onClose={() => setConfirmingTemplateDelete(null)} label={`Delete ${confirmingTemplateDelete.name}`} eyebrow="Prompt Templates" title={<>Delete {confirmingTemplateDelete.name}?</>} icon="trash" size="sm">
            <div className="stack stack-tight">
              <p className="muted">Deleting a prompt template removes it from your per-user template library, but does not affect messages that already used it as an attachment.</p>
              <div className="row end gap-sm">
                <button type="button" className="secondary-button" onClick={() => setConfirmingTemplateDelete(null)} disabled={savingTemplate}>
                  Cancel
                </button>
                <button type="button" className="danger-button" onClick={() => removeTemplate(confirmingTemplateDelete)} disabled={savingTemplate}>
                  {savingTemplate ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
        </Dialog>
      ) : null}
      {campaign && session.campaignId ? (
        <WorldTickDialog
          open={worldDialogOpen}
          onClose={() => setWorldDialogOpen(false)}
          campaignId={session.campaignId}
          campaignName={campaign.name}
          sessionId={session.id}
        />
      ) : null}
      {campaign && session.campaignId ? (
        <CampaignAuditDialog
          open={auditDialogOpen}
          onClose={() => setAuditDialogOpen(false)}
          campaignId={session.campaignId}
          campaignName={campaign.name}
          sessionId={session.id}
          defaultModelId={resolvedContextSettings.auditModel}
          availableModels={availableChatModels}
          config={providerConfig.data}
        />
      ) : null}
      {campaign && session.campaignId ? (
        <AuditFindingsDialog
          open={findingsDialogOpen}
          onClose={() => setFindingsDialogOpen(false)}
          campaignId={session.campaignId}
          sessionId={session.id}
        />
      ) : null}
    </section>
  );
}

/** The message at the top of the list's viewport and its offset from the list's top edge. */
function readingAnchor(list: HTMLElement | null, nodes: Record<string, HTMLElement | null>): { id: string; offset: number } | null {
  if (!list) return null;
  const top = list.getBoundingClientRect().top;
  let anchor: { id: string; offset: number } | null = null;
  for (const [id, node] of Object.entries(nodes)) {
    if (!node?.isConnected) continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    if (!anchor || rect.top - top < anchor.offset) anchor = { id, offset: rect.top - top };
  }
  return anchor;
}

/** The transcript's elements with the muted "Loading the messages in between…" row before each listed index. */
function withGapMarkers(elements: React.ReactNode[], messages: readonly ChatMessage[], indexes: readonly number[]): React.ReactNode[] {
  if (!indexes.length) return elements;
  return elements.flatMap((element, index) => indexes.includes(index)
    ? [<p key={`gap-before-${messages[index]?.id ?? index}`} className="muted small-copy" role="status" style={{ textAlign: "center", margin: "8px 0 12px" }}>{GAP_LOADING_TEXT}</p>, element]
    : [element]);
}

// Ticks once per second while the waiting indicator is mounted. Self-contained
// so the per-second re-render stays inside this tiny component.
function ElapsedTimer() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="msg-waiting-elapsed">{seconds}s</span>;
}

function isImageAttachment(attachment: { mimeType: string; contentMode: string }) {
  return attachment.contentMode === "base64" && attachment.mimeType.startsWith("image/");
}

function isPdfAttachment(attachment: { mimeType: string; contentMode: string }) {
  return attachment.contentMode === "base64" && attachment.mimeType === "application/pdf";
}

function attachmentDataUrl(attachment: { mimeType: string; contentMode: string; content: string }) {
  if (attachment.contentMode !== "base64") return "";
  return `data:${attachment.mimeType};base64,${attachment.content}`;
}

function startTextareaResize(event: React.MouseEvent<HTMLDivElement>) {
  event.preventDefault();
  const handle = event.currentTarget;
  const textarea = handle.parentElement?.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!textarea) return;
  const isBottom = handle.classList.contains("at-bottom");
  const startY = event.clientY;
  const startHeight = textarea.offsetHeight;
  handle.classList.add("is-dragging");
  document.body.style.cursor = "row-resize";
  const onMove = (moveEvent: MouseEvent) => {
    const delta = isBottom ? moveEvent.clientY - startY : startY - moveEvent.clientY;
    const next = Math.max(48, Math.min(Math.max(window.innerHeight * 0.6, startHeight), startHeight + delta));
    textarea.style.height = `${next}px`;
  };
  const onUp = () => {
    handle.classList.remove("is-dragging");
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

const IMAGE_MAX_DIM = 1920;

function resizeImageIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return Promise.resolve(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const { naturalWidth: w, naturalHeight: h } = img;
      if (w <= IMAGE_MAX_DIM && h <= IMAGE_MAX_DIM) { resolve(file); return; }
      const scale = IMAGE_MAX_DIM / Math.max(w, h);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
      canvas.toBlob((blob) => {
        resolve(blob ? new File([blob], file.name, { type: outputType }) : file);
      }, outputType, 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(file); };
    img.src = URL.createObjectURL(file);
  });
}

// Throws (with a user-facing message) when the encoded content is empty or exceeds
// the contract cap (attachmentContentProblem), instead of the
// server's validation string failing the whole send.
async function readAttachmentFile(file: File): Promise<ComposerAttachmentInput> {
  const mimeType = file.type || inferMimeType(file.name);
  const attachment: ComposerAttachmentInput = isTextMimeType(mimeType, file.name)
    ? {
      filename: file.name,
      mimeType,
      contentMode: "text",
      content: await file.text(),
    }
    : await (async () => {
      const processed = mimeType.startsWith("image/") ? await resizeImageIfNeeded(file) : file;
      return {
        filename: processed.name,
        mimeType: processed.type || mimeType,
        contentMode: "base64" as const,
        content: arrayBufferToBase64(await processed.arrayBuffer()),
      };
    })();
  const problem = attachmentContentProblem(file.name, attachment.content);
  if (problem) throw new Error(problem);
  return attachment;
}

function isTextMimeType(mimeType: string, filename: string) {
  if (mimeType.startsWith("text/")) return true;
  return /\.(txt|md|json|csv)$/i.test(filename);
}

function inferMimeType(filename: string) {
  if (/\.pdf$/i.test(filename)) return "application/pdf";
  if (/\.json$/i.test(filename)) return "application/json";
  if (/\.csv$/i.test(filename)) return "text/csv";
  if (/\.md$/i.test(filename)) return "text/markdown";
  if (/\.(png)$/i.test(filename)) return "image/png";
  if (/\.(jpe?g)$/i.test(filename)) return "image/jpeg";
  if (/\.(gif)$/i.test(filename)) return "image/gif";
  if (/\.(webp)$/i.test(filename)) return "image/webp";
  return "text/plain";
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="thinking-block">
      <button type="button" className="thinking-toggle" onClick={() => setOpen((current) => !current)}>
        <span>Thinking{streaming ? "..." : ""}</span>
        {!streaming ? <span className="thinking-len">{text.length > 500 ? `${(text.length / 1000).toFixed(1)}K` : `${text.length} chars`}</span> : null}
        <span className="chevron"><Icon name={open ? "chevron-down" : "chevron-right"} size={14} /></span>
      </button>
      {open ? <div className="thinking-content">{text}</div> : null}
    </div>
  );
}

function sumMessageUsage(messages: ChatMessage[]) {
  return messages.reduce((totals, message) => ({
    inputTokens: totals.inputTokens + (message.usage?.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (message.usage?.outputTokens ?? 0),
    totalTokens: totals.totalTokens + (message.usage?.totalTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (message.usage?.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (message.usage?.cacheWriteTokens ?? 0),
    reasoningTokens: totals.reasoningTokens + (message.usage?.reasoningTokens ?? 0),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
}

function computeContextMetrics(messages: ChatMessage[], campaign: SessionDetailResponse["campaign"], stats?: SessionStats | null) {
  let chars = 0;
  let lines = 0;
  if (campaign) {
    chars += (campaign.systemPrompt || "").length;
    lines += countLines(campaign.systemPrompt || "");
  }
  // Server aggregate covers ALL active messages — the local fold only sees the
  // loaded window (the fallback for older servers).
  if (stats) return { chars: chars + stats.contentChars, lines: lines + stats.contentLines };
  for (const m of messages) {
    chars += m.content.length;
    lines += countLines(m.content);
  }
  return { chars, lines };
}

function countLines(s: string) { return s ? s.split("\n").length : 0; }

function estimateSessionContextTokens(messages: ChatMessage[], campaign: SessionDetailResponse["campaign"], contextBudgetTokens?: number, stats?: SessionStats | null, hasOlder?: boolean) {
  const syspromptChars = campaign ? campaign.systemPrompt.length + 32 : 0;
  if (!contextBudgetTokens) {
    // Server aggregate spans ALL active messages incl. attachment estimates —
    // exact even when only the newest window is loaded.
    if (stats) {
      const chars = syspromptChars + stats.estimatedContextChars;
      return chars ? Math.ceil(chars / 4) : 0;
    }
    let chars = syspromptChars;
    for (const message of messages) {
      chars += message.content.length + 24;
      for (const attachment of message.attachments) chars += estimateAttachmentContextChars(attachment);
    }
    return chars ? Math.ceil(chars / 4) : 0;
  }
  const overhead = Math.ceil(syspromptChars / 4);
  let remaining = contextBudgetTokens - overhead;
  if (remaining <= 0) return overhead;
  let tokens = overhead;
  let stoppedAtBudget = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if ((m as { role: string }).role === "cold-start") continue;
    let msgChars = m.content.length + 24;
    for (const a of m.attachments) msgChars += estimateAttachmentContextChars(a);
    const msgTokens = Math.ceil(msgChars / 4);
    if (msgTokens > remaining) { stoppedAtBudget = true; break; }
    remaining -= msgTokens;
    tokens += msgTokens;
  }
  // The newest-first budget walk ran off the LOADED window with budget to spare —
  // unloaded older messages would keep filling it. Approximate with the server's
  // whole-session char total, capped at the budget headroom (upper bound off by
  // less than one message; fine for an "Approx." warning estimate).
  if (!stoppedAtBudget && hasOlder && stats) {
    const fullTotal = overhead + Math.ceil(stats.estimatedContextChars / 4);
    return Math.min(fullTotal, tokens + remaining);
  }
  return tokens;
}

function estimateAttachmentContextChars(attachment: ChatMessage["attachments"][number]) {
  if (attachment.contentMode === "text") return attachment.content.length + attachment.filename.length + attachment.mimeType.length + 32;
  if (attachment.mimeType === "application/pdf") return 8_192;
  if (attachment.mimeType.startsWith("image/")) return 2_048;
  return 1_024;
}

function buildContextLimitWarning(model: ReturnType<typeof buildAvailableChatModels>[number] | null, estimatedContextTokens: number) {
  if (!model?.ctx || !estimatedContextTokens || estimatedContextTokens <= model.ctx) return null;
  return `Approx. existing session context may exceed ${model.label}'s limit (${estimatedContextTokens.toLocaleString()} est. vs ${model.ctx.toLocaleString()} max). You can still switch, but the next send may fail until the transcript is trimmed.`;
}

function isModelOverCurrentContext(model: ReturnType<typeof buildAvailableChatModels>[number], estimatedContextTokens: number) {
  return Boolean(model.ctx && estimatedContextTokens > model.ctx);
}

function sumMessageCost(messages: ChatMessage[], cacheTtl: "off" | "5m" | "1h") {
  let total = 0;
  let found = false;
  for (const message of messages) {
    const cost = calculateMessageCost(message, cacheTtl);
    if (cost == null) continue;
    total += cost;
    found = true;
  }
  return found ? total : null;
}

// Per-message cost via the catalog's shared estimator (the API's
// computeSessionStats uses the same one). The local rate table this
// replaced keyed the cache-WRITE charge on the session TTL, so an OpenAI
// session (cacheTtl forced "off" while the runtime bills 1.25× writes) showed
// no write cost at all; the estimator charges whenever cacheWriteTokens were
// captured and only uses the TTL to pick the 5m/1h Anthropic rate.
function calculateMessageCost(message: ChatMessage, cacheTtl: "off" | "5m" | "1h") {
  if (!message.usage) return null;
  return estimateUsageCostUsd(message.modelId ? getChatModel(message.modelId) : null, message.usage, { cacheTtl, fastMode: message.fastMode === true });
}

function calculateCacheHitRate(usage: ReturnType<typeof sumMessageUsage>) {
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (!totalInput) return null;
  return usage.cacheReadTokens / totalInput;
}

function calculateTurnCacheHitRate(message: ChatMessage): number | null {
  if (!message.usage) return null;
  const read = message.usage.cacheReadTokens ?? 0;
  const write = message.usage.cacheWriteTokens ?? 0;
  if (read === 0 && write === 0) return null;
  const total = (message.usage.inputTokens ?? 0) + read + write;
  if (!total) return null;
  return read / total;
}

function calculateCacheSavings(messages: ChatMessage[], cacheTtl: "off" | "5m" | "1h"): number | null {
  // cacheTtl arg retained for signature stability; per-message rates derived from
  // the message's recorded fastMode flag, so savings reflect what was actually billed.
  void cacheTtl;
  let savings = 0;
  let found = false;
  for (const message of messages) {
    if (!message.usage) continue;
    const saved = estimateCacheSavingsUsd(message.modelId ? getChatModel(message.modelId) : null, message.usage, message.fastMode === true);
    if (saved == null) continue;
    found = true;
    savings += saved;
  }
  return found ? savings : null;
}

function buildRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function findChatModel(models: ReturnType<typeof buildAvailableChatModels>, modelId: string) {
  return models.find((model) => model.id === modelId) ?? null;
}

// Display label for any model id: the keyed picker list first (custom endpoints
// live only there), then the full catalog (a model whose provider key was
// removed), then the raw id.
function chatModelLabel(models: ReturnType<typeof buildAvailableChatModels>, modelId: string) {
  return findChatModel(models, modelId)?.label ?? getChatModel(modelId)?.label ?? modelId;
}

function formatUsageValue(value: number | null) {
  return value == null ? "-" : value.toLocaleString();
}

function formatCostValue(value: number | null) {
  if (value == null) return "N/A";
  if (value === 0) return "$0.00";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

// The session figure is an estimate on two approximations (see costEstimates.ts);
// the "~" says so, as the per-message figure always has.
function formatEstimateValue(value: number | null) {
  return value == null ? "N/A" : `~${formatCostValue(value)}`;
}

function formatPercent(value: number | null) {
  return value == null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function toTemplateFilename(name: string) {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prompt-template";
  return `${stem}.md`;
}

type SceneValidatorPayload = {
  agreement: "agree" | "disagree";
  main: { present: string[]; presentUnaware: string[] };
  validator: { present: string[]; presentUnaware: string[] };
  rationale: string;
  modelId: string;
};

function CharacterAttireChip({ campaignId, name, attireEnabled, nextTurn }: { campaignId: string | null | undefined; name: string; attireEnabled: boolean; nextTurn: number }) {
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<{ attireDescription: string; lastUpdatedTurn: number; source: string; updatedAt: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !campaignId || !attireEnabled) return;
    let canceled = false;
    setLoading(true);
    setError(null);
    getCharacterAttire(campaignId, name)
      .then((r) => { if (!canceled) { setRecord(r); setDraft(r.attireDescription); } })
      .catch((err: unknown) => {
        if (canceled) return;
        // apiFetch throws ApiError with the HTTP status; the message is the
        // server's body text ("no attire recorded for character"), which never
        // contained "404" — the old substring check never matched.
        if (err instanceof ApiError && err.status === 404) {
          setRecord(null);
          setError(ATTIRE_NONE_TEXT);
        } else {
          setError(err instanceof Error ? err.message : "Failed to load attire");
        }
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [open, campaignId, name, attireEnabled]);

  const save = async () => {
    if (!campaignId) return;
    setSaving(true);
    try {
      // `turn`: stamp the manual edit at the loaded tail + 1 (the composer
      // knows its transcript; the server resolves the campaign's current turn
      // only when the field is absent).
      const updated = await updateCharacterAttire(campaignId, name, { attireDescription: draft.trim(), reason: "manual edit", turn: nextTurn });
      setRecord(updated);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="character-chip"
        onClick={() => setOpen((v) => !v)}
        title={attireEnabled ? `View ${name}'s attire` : "Attire tracking disabled"}
      >
        {name}
      </button>
      <Popover open={open} anchorRef={chipRef} onClose={() => { setOpen(false); setEditing(false); }} title={name} width={360}>
        {!attireEnabled ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Attire tracking is disabled for this session. Enable it in the Scene Validator section of the Engine popover.</div>
        ) : !campaignId ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Attire tracking requires a campaign session.</div>
        ) : loading ? (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Loading…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {error && !record ? <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>{error}</div> : null}
            {record ? (
              <>
                {editing ? (
                  <>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      maxLength={ATTIRE_DESCRIPTION_MAX}
                      rows={4}
                      style={{ width: "100%", fontSize: 12, padding: 6, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--surface-border)", borderRadius: 4, resize: "vertical" }}
                      disabled={saving}
                    />
                    {error ? <div style={{ fontSize: 11, color: "var(--danger)" }}>{error}</div> : null}
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button type="button" className="ghost-button" onClick={() => { setEditing(false); setDraft(record.attireDescription); setError(null); }} disabled={saving}>Cancel</button>
                      <button type="button" className="primary-button" onClick={save} disabled={saving || !draft.trim() || draft.trim() === record.attireDescription}>{saving ? "Saving…" : "Save"}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, lineHeight: 1.4 }}>{record.attireDescription}</div>
                    <div style={{ fontSize: 10, color: "var(--muted)" }}>
                      Source: {record.source} · Last updated turn {record.lastUpdatedTurn} · {new Date(record.updatedAt).toLocaleString()}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button type="button" className="ghost-button" onClick={() => { setEditing(true); setDraft(record.attireDescription); }}>Edit</button>
                    </div>
                  </>
                )}
              </>
            ) : null}
          </div>
        )}
      </Popover>
    </>
  );
}

function CharacterAttireChipList({ campaignId, names, attireEnabled, nextTurn }: { campaignId: string | null | undefined; names: string[]; attireEnabled: boolean; nextTurn: number }) {
  if (names.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {names.map((n, i) => (
        <span key={n + i}>
          <CharacterAttireChip campaignId={campaignId} name={n} attireEnabled={attireEnabled} nextTurn={nextTurn} />
          {i < names.length - 1 ? <span style={{ color: "var(--muted)" }}>,&nbsp;</span> : null}
        </span>
      ))}
    </span>
  );
}

function SceneDivider({ location, present, presentUnaware, notPresent, reason, date, time, validator, resolution, onResolve, onEditSave, autoRegen, isLiveTail, disabled, campaignId, attireEnabled, nextTurn }: {
  location: string;
  present: string[];
  presentUnaware: string[];
  notPresent: string[];
  reason: string | null;
  date: string | null;
  time: string | null;
  validator: SceneValidatorPayload | null;
  resolution: "main" | "validator" | "user" | null;
  onResolve: ((choice: "main" | "validator" | "user", userPresent?: string, userPresentUnaware?: string) => Promise<void>) | null;
  onEditSave: ((edits: SceneEditPayload) => Promise<SceneEditResult>) | null;
  autoRegen: boolean;
  // True only for the newest reply of the live transcript: the auto-regen
  // replay is offered (and worded) solely there — older replies resolve
  // metadata only.
  isLiveTail: boolean;
  disabled: boolean;
  campaignId: string | null;
  attireEnabled: boolean;
  // Turn a manual attire edit from this divider is stamped at (live tail + 1).
  nextTurn: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<"idle" | "manual" | "edit">("idle");
  const [manualPresent, setManualPresent] = useState("");
  const [manualUnaware, setManualUnaware] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flashResolved, setFlashResolved] = useState(false);
  const [editFields, setEditFields] = useState<SceneEditFields>(() => sceneEditFields({ location, present, presentUnaware, reason, date, time }));
  // A refused save's message, shown inside the form.
  const [editError, setEditError] = useState("");
  const lastResolutionRef = useRef<typeof resolution>(resolution);
  useEffect(() => {
    if (lastResolutionRef.current === null && resolution !== null) {
      setExpanded(true);
      setMode("idle");
      setFlashResolved(true);
      const t = window.setTimeout(() => setFlashResolved(false), 2400);
      return () => window.clearTimeout(t);
    }
    lastResolutionRef.current = resolution;
  }, [resolution]);
  const disagreement = validator && validator.agreement === "disagree" && resolution === null;
  const classes = ["scene-divider"];
  if (disagreement) classes.push("scene-divider-pulse");
  if (resolution) classes.push(`scene-divider-resolved-${resolution}`);

  const submit = async (choice: "main" | "validator" | "user") => {
    if (!onResolve || submitting) return;
    setSubmitting(true);
    try {
      if (choice === "user") {
        await onResolve("user", manualPresent, manualUnaware);
      } else {
        await onResolve(choice);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openManual = () => {
    setMode("manual");
    setManualPresent(validator?.main.present.join(", ") || present.join(", "));
    setManualUnaware(validator?.main.presentUnaware.join(", ") || presentUnaware.join(", "));
    setExpanded(true);
  };

  const openEdit = () => {
    setMode("edit");
    setEditFields(sceneEditFields({ location, present, presentUnaware, reason, date, time }));
    setEditError("");
    setExpanded(true);
  };

  const editPayload = sceneEditPayload(editFields, { location, present, presentUnaware, reason, date, time });
  // What the contract would refuse is named in the form and Save waits.
  const editProblem = mode === "edit" ? sceneEditProblem(editPayload) : null;
  const saveEdit = async () => {
    if (!onEditSave || submitting || editProblem) return;
    setSubmitting(true);
    try {
      const outcome = sceneEditAfterSave(await onEditSave(editPayload));
      setMode(outcome.mode);
      setEditError(outcome.error);
    } finally {
      setSubmitting(false);
    }
  };

  const dateTimeChip = date || time ? ` · ${[date, time].filter(Boolean).join(" ")}` : "";
  const headerLabel = disagreement
    ? <>— {location} · <Icon name="alert" size={12} /> presence disagreement{dateTimeChip} —</>
    : resolution === "validator"
      ? `— ${location} · ${present.length} present · validator-corrected${dateTimeChip} —`
      : resolution === "user"
        ? `— ${location} · ${present.length} present · user-corrected${dateTimeChip} —`
        : `— ${location} · ${present.length} present${dateTimeChip} —`;

  return (
    <div className={classes.join(" ")}>
      <div className="scene-divider-line" onClick={() => setExpanded((v) => !v)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setExpanded((v) => !v); }}>
        <span className="scene-divider-label">{headerLabel}</span>
      </div>
      {expanded ? (
        <div className="scene-divider-detail">
          {mode !== "edit" && onEditSave ? (
            <button type="button" className="scene-divider-edit-btn" onClick={openEdit} disabled={disabled} title="Edit scene metadata" aria-label="Edit scene metadata"><Icon name="pencil" size={13} /></button>
          ) : null}
          {(date || time) ? <div className="scene-divider-when"><strong>When:</strong> {[date, time].filter(Boolean).join(" — ")}</div> : null}
          <div><strong>Present:</strong> <CharacterAttireChipList campaignId={campaignId} names={present} attireEnabled={attireEnabled} nextTurn={nextTurn} /></div>
          {presentUnaware.length > 0 ? <div><strong>Present (unaware):</strong> <CharacterAttireChipList campaignId={campaignId} names={presentUnaware} attireEnabled={attireEnabled} nextTurn={nextTurn} /></div> : null}
          {notPresent.length > 0 ? <div><strong>Not present:</strong> {notPresent.join(", ")}</div> : null}
          {reason ? <div className="scene-divider-reason">{reason}</div> : null}
          {mode === "edit" ? (
            <SceneEditForm
              fields={editFields}
              onField={(key, value) => setEditFields((current) => ({ ...current, [key]: value }))}
              error={editError}
              problem={editProblem}
              submitting={submitting}
              disabled={disabled}
              onCancel={() => { setMode("idle"); setEditError(""); }}
              onSave={() => void saveEdit()}
            />
          ) : null}
          {validator && validator.agreement === "disagree" ? (
            <div className={`scene-divider-validator${flashResolved ? " scene-divider-validator-flash" : ""}`}>
              <div className="scene-divider-validator-head">
                <strong>{resolution ? "Resolution applied" : "Validator disagrees"}</strong>
                <span className="scene-divider-validator-model">{validator.modelId}</span>
              </div>
              {resolution ? (
                <div className="scene-divider-resolution-banner">
                  <Icon name="check" size={13} /> {resolution === "main"
                    ? "Kept Main LLM's scene metadata. No regen."
                    : resolution === "validator"
                      ? "Applied Validator's lists to this message's scene metadata."
                      : "Applied your manual correction to this message's scene metadata."}
                </div>
              ) : null}
              <div className="scene-divider-validator-cols">
                <div className={resolution === "main" ? "scene-divider-validator-col-chosen" : resolution ? "scene-divider-validator-col-rejected" : ""}>
                  <div className="scene-divider-validator-col-head">Main {resolution === "main" ? <Icon name="check" size={12} /> : ""}</div>
                  <div><span className="lbl">Present:</span> {validator.main.present.join(", ") || "—"}</div>
                  {validator.main.presentUnaware.length ? <div><span className="lbl">Unaware:</span> {validator.main.presentUnaware.join(", ")}</div> : null}
                </div>
                <div className={resolution === "validator" ? "scene-divider-validator-col-chosen" : resolution ? "scene-divider-validator-col-rejected" : ""}>
                  <div className="scene-divider-validator-col-head">Validator {resolution === "validator" ? <Icon name="check" size={12} /> : ""}</div>
                  <div><span className="lbl">Present:</span> {validator.validator.present.join(", ") || "—"}</div>
                  {validator.validator.presentUnaware.length ? <div><span className="lbl">Unaware:</span> {validator.validator.presentUnaware.join(", ")}</div> : null}
                </div>
              </div>
              {resolution === "user" ? (
                <div className="scene-divider-validator-applied">
                  <div className="scene-divider-validator-col-head">Applied (user) <Icon name="check" size={12} /></div>
                  <div><span className="lbl">Present:</span> {present.join(", ") || "—"}</div>
                  {presentUnaware.length ? <div><span className="lbl">Unaware:</span> {presentUnaware.join(", ")}</div> : null}
                </div>
              ) : null}
              {validator.rationale ? <div className="scene-divider-validator-rationale">{validator.rationale}</div> : null}
              {resolution === null && onResolve ? (
                <>
                {autoRegen && !isLiveTail ? (
                  <div className="muted small-copy">{AUTO_REGEN_OLDER_REPLY_HINT}</div>
                ) : null}
                {mode === "manual" ? (
                  <div className="scene-divider-manual">
                    <label className="scene-divider-manual-row">
                      <span className="lbl">Present (comma-separated)</span>
                      <input type="text" value={manualPresent} onChange={(e) => setManualPresent(e.target.value)} disabled={submitting || disabled} />
                    </label>
                    <label className="scene-divider-manual-row">
                      <span className="lbl">Present unaware (comma-separated)</span>
                      <input type="text" value={manualUnaware} onChange={(e) => setManualUnaware(e.target.value)} disabled={submitting || disabled} />
                    </label>
                    <div className="scene-divider-actions">
                      <button type="button" className="ghost-button" onClick={() => setMode("idle")} disabled={submitting || disabled}>Cancel</button>
                      <button type="button" className="primary-button" onClick={() => submit("user")} disabled={submitting || disabled || (!manualPresent.trim() && !manualUnaware.trim())}>
                        {submitting ? "Saving…" : autoRegen && isLiveTail ? "Save & regenerate" : "Save correction"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="scene-divider-actions">
                    <button type="button" className="ghost-button" onClick={() => submit("main")} disabled={submitting || disabled}>Agree with Main LLM</button>
                    <button type="button" className="primary-button" onClick={() => submit("validator")} disabled={submitting || disabled}>
                      {autoRegen && isLiveTail ? "Agree with Validator & regenerate" : "Agree with Validator"}
                    </button>
                    <button type="button" className="ghost-button" onClick={openManual} disabled={submitting || disabled}>Both wrong</button>
                  </div>
                )}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
