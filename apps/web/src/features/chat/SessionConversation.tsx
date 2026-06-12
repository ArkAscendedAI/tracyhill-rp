import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ChatMessage, PromptTemplate, SessionDetailResponse, SessionSummary } from "@tracyhill-rp/contracts";
import { IMAGE_MODELS, EMBEDDING_MODELS, getChatModel } from "@tracyhill-rp/model-catalog";

import { renderMarkdown, attachCodeBlockCopyHandlers } from "../../shared/markdown/renderMarkdown";
import { NumericInput } from "../../shared/ui/NumericInput";
import { Popover } from "../../shared/ui/Popover";

import {
  deleteChatMessage,
  editSceneMetadata,
  exportSessionMarkdown,
  generateSessionImage,
  resolveSceneValidation,
  stopSessionResponse,
  streamSessionResponse,
  truncateChatMessages,
  updateChatMessage,
} from "./chatApi";
import { createEmptySessionStreamState, type ComposerAttachmentInput, type SessionStreamState } from "./sessionStreamState";
import {
  createPromptTemplate,
  deletePromptTemplate,
  getPromptTemplates,
  updatePromptTemplate,
} from "../templates/templateApi";
import { buildAvailableChatModels, getProviderKeys } from "../auth/providerKeyApi";
import { enqueueWizardRun, getActiveWizardRuns } from "../wizard/wizardApi";
import { updateSession } from "../workspace/workspaceApi";
import { useCampaigns } from "../campaigns/useCampaigns";
import { enqueuePipelineRun, getPipelineQueueStatus } from "../pipeline/pipelineApi";
import { PipelineQueuePill } from "../pipeline/PipelineQueuePill";
import { getLorebookEntries } from "../lorebook/lorebookApi";
import { useSessionDetail } from "./useSessionDetail";
import { getCharacterAttire, updateCharacterAttire } from "./characterAttireApi";

type SessionConversationProps = {
  session: SessionSummary;
  streamState: SessionStreamState;
  updateSessionStream: (sessionId: string, updater: SessionStreamState | ((current: SessionStreamState) => SessionStreamState)) => void;
};

// --- Thread tracker (read-only render of the "threads"-tagged lorebook entries) ---
type UiThread = {
  id: string; title: string; headline: string; status: string;
  summary: string; nextBeat: string; pendingDates: string;
  involved: string[]; log: string[]; openedDate: string; lastUpdatedDate: string;
};
const THREAD_PENDING = new Set(["OPEN", "ACTIVE", "STALLED"]);
/** Parse the canonical thread JSON from the constant Thread Index entry's `comment` field. */
function parseThreadTracker(entries: Array<{ name: string; isConstant: boolean; comment: string | null }>): { threads: UiThread[]; active: number } {
  const index = entries.find(e => e.name === "Campaign Thread Tracker" && e.isConstant);
  if (!index?.comment) return { threads: [], active: 0 };
  try {
    const parsed = JSON.parse(index.comment);
    const raw = Array.isArray(parsed?.threads) ? parsed.threads : [];
    const threads: UiThread[] = raw.filter((t: any) => t && typeof t.id === "string").map((t: any) => ({
      id: String(t.id), title: String(t.title ?? ""), headline: String(t.headline ?? ""),
      status: String(t.status ?? "").toUpperCase(), summary: String(t.summary ?? ""),
      nextBeat: String(t.nextBeat ?? ""), pendingDates: String(t.pendingDates ?? ""),
      involved: Array.isArray(t.involved) ? t.involved.map(String) : [],
      log: Array.isArray(t.log) ? t.log.map(String) : [],
      openedDate: String(t.openedDate ?? ""), lastUpdatedDate: String(t.lastUpdatedDate ?? ""),
    }));
    return { threads, active: threads.filter(t => THREAD_PENDING.has(t.status)).length };
  } catch { return { threads: [], active: 0 }; }
}

type MessageListActions = {
  copyMessage(m: ChatMessage): void;
  startEdit(m: ChatMessage): void;
  resendFrom(i: number): void;
  regenerateFrom(i: number): void;
  saveEdit(m: ChatMessage): void;
  cancelEdit(): void;
};

export function SessionConversation({ session, streamState, updateSessionStream }: SessionConversationProps) {
  const queryClient = useQueryClient();
  const detail = useSessionDetail(session.id);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachmentInput[]>([]);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [startingWizardRun, setStartingWizardRun] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [savingSessionSettings, setSavingSessionSettings] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [mutatingMessageIds, setMutatingMessageIds] = useState<Record<string, string | null>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const editDraftRef = useRef("");
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templateContentDraft, setTemplateContentDraft] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<null | { type: "delete" | "truncate"; messageId: string; label: string }>(null);
  const [confirmingTemplateDelete, setConfirmingTemplateDelete] = useState<PromptTemplate | null>(null);
  const [imageModelId, setImageModelId] = useState(IMAGE_MODELS[0]?.id ?? "gpt-image-2");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuProvider, setModelMenuProvider] = useState<string | null>(null);
  const [localSearchOpen, setLocalSearchOpen] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [statusBarOpen, setStatusBarOpen] = useState(() => typeof window === "undefined" ? true : window.innerWidth > 768);
  const [sessionPopoverOpen, setSessionPopoverOpen] = useState(false);
  const [enginePopoverOpen, setEnginePopoverOpen] = useState(false);
  const [previewPopoverOpen, setPreviewPopoverOpen] = useState(false);
  const [campaignPopoverOpen, setCampaignPopoverOpen] = useState(false);
  const [threadsPopoverOpen, setThreadsPopoverOpen] = useState(false);
  const sessionChipRef = useRef<HTMLButtonElement | null>(null);
  const engineChipRef = useRef<HTMLButtonElement | null>(null);
  const previewChipRef = useRef<HTMLButtonElement | null>(null);
  const campaignChipRef = useRef<HTMLButtonElement | null>(null);
  const threadsChipRef = useRef<HTMLButtonElement | null>(null);
  const [seedDialogOpen, setSeedDialogOpen] = useState(false);
  const [seedDialogCreativeModelId, setSeedDialogCreativeModelId] = useState("");
  const [sendError, setSendError] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const messageRefs = useRef<Record<string, HTMLElement | null>>({});
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const stopRequestsRef = useRef<Record<string, boolean>>({});
  const messageActionsRef = useRef<MessageListActions>(null!);
  const providerConfig = useQuery({
    queryKey: ["provider-keys"],
    queryFn: getProviderKeys,
  });
  const availableChatModels = useMemo(() => buildAvailableChatModels(providerConfig.data), [providerConfig.data]);
  const selectedModel = availableChatModels.find((model) => model.id === session.modelId) ?? availableChatModels[0] ?? null;
  const selectedImageModel = IMAGE_MODELS.find((model) => model.id === imageModelId) ?? IMAGE_MODELS[0] ?? null;
  const isWizardSession = session.sessionType === "wizard";
  const mutatingMessageId = mutatingMessageIds[session.id] ?? null;
  // "sending" for UI purposes ends at response.completed — the server keeps the
  // stream open while the scene validator runs (seconds to tens of seconds),
  // and the composer used to stay locked with a stuck Stop button for all of it.
  const sending = streamState.sending && !streamState.completed;
  const stopping = sending && streamState.stopRequested;
  const visibleError = streamState.error || sendError;

  const messages: ChatMessage[] = detail.data?.messages ?? [];
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
  const resolvedContextSettings = useMemo(() => ({
    mode: "keyword" as string,
    retrievalBudgetTokens: 4000,
    semanticTopK: 20,
    semanticThreshold: 0.25,
    scanDepth: 4,
    contextBudgetTokens: 200000,
    guaranteedMessageCount: 20,
    embeddingModel: "openai:text-embedding-3-large",
    researcherEnabled: true,
    researcherModel: "claude-sonnet-4-6-bridge",
    researcherMaxPicks: 16,
    hydeEnabled: true,
    hydeModel: undefined as string | undefined,
    rollingEnabled: true,
    rollingCadence: 4,
    rollingModel: "claude-haiku-4-5-bridge",
    sceneValidatorEnabled: true,
    sceneValidatorModel: "claude-haiku-4-5-bridge",
    sceneValidatorAutoRegen: true,
    attireTrackingEnabled: true,
    attireStaleTurnThreshold: 10,
    pipelineAutoEnabled: true,
    rollingDiffCharThreshold: 17000,
    repetitionCharThreshold: 50000,
    syspromptAuditCharThreshold: 100000,
    maxAntiRepetitionRules: 80,
    antiRepArchiveAfter: 5,
    previewEnabled: false,
    coldInflationWeightMultiplier: 0.6,
    fastModeEnabled: false,
    ...campaign?.contextDefaults,
    ...session.contextOverrides,
  }), [campaign?.contextDefaults, session.contextOverrides]);
  const localSearchNeedle = localSearchQuery.trim().toLocaleLowerCase();
  // The user message is persisted server-side as soon as the stream request lands,
  // so any session-detail refetch mid-stream (window-focus refetch, scene-validation
  // invalidation) pulls the real copy in while the optimistic one is still rendered.
  // Skip the optimistic copy once the persisted duplicate is the last message.
  const lastPersisted = messages[messages.length - 1];
  const pendingAlreadyPersisted = Boolean(
    streamState.pendingPrompt
    && lastPersisted
    && lastPersisted.role === "user"
    && lastPersisted.content === streamState.pendingPrompt,
  );

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
      servedModel: null,
      sceneData: null,
      sceneValidator: null,
      sceneResolution: null,
      overhead: null,
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
      servedModel: null,
      sceneData: null,
      sceneValidator: null,
      sceneResolution: null,
      overhead: null,
      sortOrder: Number.MAX_SAFE_INTEGER,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attachments: [],
      generatedImages: [],
    }] : []),
  ], [messages, streamState.pendingPrompt, streamState.pendingAttachments, streamState.streamingText, streamState.streamingThinking, pendingAlreadyPersisted, session.id, session.modelId]);
  const localSearchMatches = useMemo(() => localSearchNeedle
    ? renderedMessages
      .filter((message) => !message.sceneData && message.content.toLocaleLowerCase().includes(localSearchNeedle))
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
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      void queryClient.invalidateQueries({ queryKey: ["session-detail", session.id] });
    },
  });
  const updateSeedMutation = useMutation({
    mutationFn: ({ campaignId, body }: { campaignId: string; body?: { creativeModelId?: string } }) => enqueuePipelineRun(campaignId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pipeline-active"] });
    },
  });
  const pipelineQueueQuery = useQuery({
    queryKey: ["pipeline-queue-status", session.campaignId],
    queryFn: () => getPipelineQueueStatus(session.campaignId!),
    refetchInterval: (query) => (query.state.data?.jobs.length ? 3000 : 30000),
    enabled: !!session.campaignId,
  });
  const pipelineQueueBusy = (pipelineQueueQuery.data?.jobs.length ?? 0) > 0;
  const threadsQuery = useQuery({
    queryKey: ["lorebook-threads", session.campaignId],
    queryFn: () => getLorebookEntries(session.campaignId!, { tag: "threads" }),
    enabled: !!session.campaignId && !isWizardSession,
    refetchInterval: 60000,
  });
  const threadData = useMemo(() => parseThreadTracker(threadsQuery.data?.entries ?? []), [threadsQuery.data]);
  const rollingDiffOverhead = detail.data?.rollingDiffOverhead ?? [];
  const usageTotals = useMemo(() => sumMessageUsage(messages), [messages]);
  const overheadCost = useMemo(() => sumOverheadCost(messages, rollingDiffOverhead), [messages, rollingDiffOverhead]);
  const estimatedCost = useMemo(() => addCosts(sumMessageCost(messages, session.cacheTtl), overheadCost), [messages, session.cacheTtl, overheadCost]);
  const cacheHitRate = useMemo(() => calculateCacheHitRate(usageTotals), [usageTotals]);
  const cacheSavings = useMemo(() => calculateCacheSavings(messages, session.cacheTtl), [messages, session.cacheTtl]);
  const estimatedContextTokens = useMemo(() => estimateSessionContextTokens(messages, campaign, campaign ? resolvedContextSettings.contextBudgetTokens : undefined), [messages, campaign, resolvedContextSettings.contextBudgetTokens]);
  const contextWarning = useMemo(() => buildContextLimitWarning(selectedModel, estimatedContextTokens), [selectedModel, estimatedContextTokens]);
  const contextMetrics = useMemo(() => computeContextMetrics(messages, campaign), [messages, campaign]);
  const chatModelGroups = useMemo(() => buildChatModelGroups(availableChatModels), [availableChatModels]);
  const isOpenAiReasoningModel = selectedModel?.provider === "openai" && selectedModel.supportsEffort;
  const isZaiModel = selectedModel?.provider === "zai";
  const isCustomResponsesModel = selectedModel?.apiFormat === "responses";
  const showTemperatureControl = Boolean(
    selectedModel && !isZaiModel && !isOpenAiReasoningModel && !isCustomResponsesModel
      && (!selectedModel.supportsThinkingBudget || session.thinkingMode === "off")
      && (!selectedModel.supportsAdaptiveThinking || session.thinkingMode === "off")
      // Toggle-thinking providers (GLM/DeepSeek V4/MiMo) ignore temperature while
      // reasoning — hide the control instead of showing a dead knob.
      && (!selectedModel.supportsToggleThinking || session.thinkingMode === "off")
      && (!selectedModel.supportsEffort || selectedModel.provider !== "google"),
  );

  useEffect(() => {
    setLocalSearchOpen(false);
    setLocalSearchQuery("");
    setActiveSearchIndex(0);
    setEditingMessageId(null);
    editDraftRef.current = "";
    setConfirmingAction(null);
    setShowTemplateDialog(false);
    setEditingTemplateId(null);
    setTemplateNameDraft("");
    setTemplateContentDraft("");
    setTemplateError("");
    setConfirmingTemplateDelete(null);
    setModelMenuOpen(false);
    setModelMenuProvider(null);
    setSendError("");
  }, [session.id]);

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

  useEffect(() => {
    if (!session.autoScroll) return;
    if (!nearBottom) return; // user has scrolled away — don't yank them back
    const targetId = renderedMessages[renderedMessages.length - 1]?.id;
    if (!targetId) return;
    const timer = window.setTimeout(() => {
      messageRefs.current[targetId]?.scrollIntoView({ block: "end", behavior: streamState.streamingText ? "auto" : "smooth" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [renderedMessages, session.autoScroll, streamState.streamingText, nearBottom]);

  const syncDetail = async (sessionId: string, next: Awaited<ReturnType<typeof updateChatMessage>>) => {
    queryClient.setQueryData(["session-detail", sessionId], next);
    await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
  };

  const setSessionMutatingMessageId = (sessionId: string, messageId: string | null) => {
    setMutatingMessageIds((current) => ({ ...current, [sessionId]: messageId }));
  };

  const patchSessionStream = (sessionId: string, patch: Partial<SessionStreamState>) => {
    updateSessionStream(sessionId, (current) => ({ ...current, ...patch }));
  };

  // Guarded: a finishing stream may only reset state it still owns — once the
  // composer unlocks on response.completed, the user can start a NEW stream
  // while the old one drains (validator), and the old finally must not wipe it.
  const resetSessionStreamIfOwner = (sessionId: string, requestId: string, error = "") => {
    updateSessionStream(sessionId, (current) => {
      if (current.requestId !== requestId) return current;
      return { ...createEmptySessionStreamState(), error, contextPreview: current.contextPreview, contextDebug: current.contextDebug, contextBudgetTokens: current.contextBudgetTokens, contextNotes: current.contextNotes };
    });
  };
  const resetSessionStream = (sessionId: string, error = "") => {
    updateSessionStream(sessionId, (current) => ({ ...createEmptySessionStreamState(), error, contextPreview: current.contextPreview, contextDebug: current.contextDebug, contextBudgetTokens: current.contextBudgetTokens, contextNotes: current.contextNotes }));
  };

  const sendMessage = async () => {
    const sessionId = session.id;
    const prompt = draft.trim();
    if ((!prompt && !attachments.length) || sending) return;
    const requestId = buildRequestId();
    stopRequestsRef.current[requestId] = false;
    setSendError("");
    // Snapshot what we're about to send so we can restore the composer on failure.
    const sentDraft = draft;
    const sentAttachments = attachments;
    patchSessionStream(sessionId, {
      sending: true,
      requestId,
      stopRequested: false,
      responseStarted: false,
      pendingPrompt: prompt || "See attached files.",
      pendingAttachments: attachments,
      streamingText: "",
      streamingThinking: "",
      error: "",
      contextPreview: [],
      contextDebug: null,
      contextNotes: [],
      contextBudgetTokens: 0,
    });
    setDraft("");
    setAttachments([]);
    let finalError = "";
    try {
      await streamSessionResponse(sessionId, requestId, {
        prompt,
        modelId: session.modelId,
        attachments,
      }, (event) => {
        if (event.type === "response.started") patchSessionStream(sessionId, { responseStarted: true });
          if (event.type === "response.context") patchSessionStream(sessionId, { contextPreview: event.preview, contextDebug: event.debug, contextBudgetTokens: event.budgetTokens, contextNotes: event.notes });
        if (event.type === "response.scene_validation") void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
        if (event.type === "response.completed") { patchSessionStream(sessionId, { completed: true, completedMessageId: event.message.id }); void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] }); }
        if (event.type === "response.delta") updateSessionStream(sessionId, (current) => ({ ...current, streamingText: current.streamingText + event.delta }));
        if (event.type === "response.thinking.delta") updateSessionStream(sessionId, (current) => ({ ...current, streamingThinking: current.streamingThinking + event.delta }));
        if (event.type === "response.error") {
          finalError = event.error;
          patchSessionStream(sessionId, { error: event.error });
        }
      });
    } catch (error) {
      if (!isAbortError(error) || !stopRequestsRef.current[requestId]) {
        finalError = error instanceof Error ? error.message : "chat request failed";
        patchSessionStream(sessionId, { error: finalError });
      }
    } finally {
      delete stopRequestsRef.current[requestId];
      // On any failure, restore the draft + attachments so the user can recover their text.
      // Skip if the user has already started typing or attaching something new since clear.
      if (finalError) {
        setDraft((current) => (current ? current : sentDraft));
        setAttachments((current) => (current.length > 0 ? current : sentAttachments));
      }
      await queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      resetSessionStreamIfOwner(sessionId, requestId, finalError);
    }
  };

  const startEdit = (message: ChatMessage) => {
    editDraftRef.current = message.content;
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
    setSessionMutatingMessageId(sessionId, message.id);
    setSendError("");
    try {
      const next = await updateChatMessage(sessionId, message.id, { content });
      await syncDetail(sessionId, next);
      cancelEdit();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "message update failed");
    } finally {
      setSessionMutatingMessageId(sessionId, null);
    }
  };

  const deleteMessage = async (messageId: string) => {
    const sessionId = session.id;
    if (mutatingMessageId) return;
    setSessionMutatingMessageId(sessionId, messageId);
    setSendError("");
    try {
      const next = await deleteChatMessage(sessionId, messageId);
      await syncDetail(sessionId, next);
      if (editingMessageId === messageId) cancelEdit();
      setConfirmingAction(null);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "message delete failed");
    } finally {
      setSessionMutatingMessageId(sessionId, null);
    }
  };

  const truncateAfter = async (messageId: string) => {
    const sessionId = session.id;
    if (mutatingMessageId) return;
    setSessionMutatingMessageId(sessionId, messageId);
    setSendError("");
    try {
      const next = await truncateChatMessages(sessionId, messageId);
      await syncDetail(sessionId, next);
      if (editingMessageId && !next.messages.some((message) => message.id === editingMessageId)) cancelEdit();
      setConfirmingAction(null);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "message truncate failed");
    } finally {
      setSessionMutatingMessageId(sessionId, null);
    }
  };

  const resendFrom = async (messageIndex: number) => {
    const sessionId = session.id;
    const message = messages[messageIndex];
    if (!message || message.role !== "user" || sending || mutatingMessageId) return;
    const requestId = buildRequestId();
    stopRequestsRef.current[requestId] = false;
    const replayPrompt = message.content;
    const replayAttachments = message.attachments.map(mapStoredAttachmentToInput);
    setSessionMutatingMessageId(sessionId, message.id);
    setSendError("");
    patchSessionStream(sessionId, {
      sending: true,
      requestId,
      stopRequested: false,
      responseStarted: false,
      pendingPrompt: replayPrompt || "See attached files.",
      pendingAttachments: replayAttachments,
      streamingText: "",
      streamingThinking: "",
      error: "",
      contextPreview: [],
      contextDebug: null,
      contextNotes: [],
      contextBudgetTokens: 0,
    });
    let finalError = "";
    try {
      if (messageIndex === 0) {
        const next = await truncateChatMessages(sessionId, message.id);
        await syncDetail(sessionId, next);
        const afterDelete = await deleteChatMessage(sessionId, message.id);
        await syncDetail(sessionId, afterDelete);
      } else {
        const next = await truncateChatMessages(sessionId, messages[messageIndex - 1]!.id);
        await syncDetail(sessionId, next);
      }
      await streamSessionResponse(sessionId, requestId, {
        prompt: replayPrompt,
        modelId: session.modelId,
        attachments: replayAttachments,
      }, (event) => {
        if (event.type === "response.started") patchSessionStream(sessionId, { responseStarted: true });
          if (event.type === "response.context") patchSessionStream(sessionId, { contextPreview: event.preview, contextDebug: event.debug, contextBudgetTokens: event.budgetTokens, contextNotes: event.notes });
        if (event.type === "response.scene_validation") void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
        if (event.type === "response.completed") { patchSessionStream(sessionId, { completed: true, completedMessageId: event.message.id }); void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] }); }
        if (event.type === "response.delta") updateSessionStream(sessionId, (current) => ({ ...current, streamingText: current.streamingText + event.delta }));
        if (event.type === "response.thinking.delta") updateSessionStream(sessionId, (current) => ({ ...current, streamingThinking: current.streamingThinking + event.delta }));
        if (event.type === "response.error") {
          finalError = event.error;
          patchSessionStream(sessionId, { error: event.error });
        }
      });
    } catch (error) {
      if (!isAbortError(error) || !stopRequestsRef.current[requestId]) {
        finalError = error instanceof Error ? error.message : "message replay failed";
        patchSessionStream(sessionId, { error: finalError });
      }
    } finally {
      delete stopRequestsRef.current[requestId];
      setSessionMutatingMessageId(sessionId, null);
      await queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
      resetSessionStreamIfOwner(sessionId, requestId, finalError);
    }
  };

  const stopStreaming = async () => {
    const requestId = streamState.requestId;
    if (!requestId || !sending || stopping) return;
    stopRequestsRef.current[requestId] = true;
    patchSessionStream(session.id, { stopRequested: true, error: "" });
    setSendError("");
    try {
      const result = await stopSessionResponse(session.id, requestId);
      if (!result.stopped) {
        stopRequestsRef.current[requestId] = false;
        patchSessionStream(session.id, { stopRequested: false });
        setSendError("chat stream is no longer active");
        return;
      }
    } catch (error) {
      stopRequestsRef.current[requestId] = false;
      patchSessionStream(session.id, { stopRequested: false });
      setSendError(error instanceof Error ? error.message : "chat stop failed");
    }
  };

  const regenerateFrom = async (messageIndex: number) => {
    if (sending || mutatingMessageId) return;
    let previousUserIndex = messageIndex - 1;
    while (previousUserIndex >= 0 && messages[previousUserIndex]?.role !== "user") previousUserIndex -= 1;
    if (previousUserIndex >= 0) await resendFrom(previousUserIndex);
  };

  const saveSceneEdit = async (
    messageId: string,
    edits: { location?: string; present?: string[]; presentUnaware?: string[]; reason?: string | null; date?: string | null; time?: string | null },
  ) => {
    if (sending || mutatingMessageId) return;
    const sessionId = session.id;
    setSendError("");
    try {
      const next = await editSceneMetadata(sessionId, messageId, edits);
      await syncDetail(sessionId, next);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "scene edit failed");
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
    setSendError("");
    try {
      const result = await resolveSceneValidation(sessionId, messageId, { choice, userPresent, userPresentUnaware });
      await syncDetail(sessionId, result.detail);
      if (choice === "main" || !resolvedContextSettings.sceneValidatorAutoRegen) return;
      // Auto-regenerate the message with the corrected scene as a one-shot constraint.
      const idx = result.detail.messages.findIndex((m) => m.id === messageId);
      if (idx < 1) return;
      const prevUserIdx = (() => {
        for (let i = idx - 1; i >= 0; i--) if (result.detail.messages[i]!.role === "user") return i;
        return -1;
      })();
      if (prevUserIdx < 0) return;
      const userMessage = result.detail.messages[prevUserIdx]!;
      const requestId = buildRequestId();
      stopRequestsRef.current[requestId] = false;
      const replayPrompt = userMessage.content;
      const replayAttachments = userMessage.attachments.map(mapStoredAttachmentToInput);
      setSessionMutatingMessageId(sessionId, userMessage.id);
      patchSessionStream(sessionId, {
        sending: true,
        requestId,
        stopRequested: false,
        responseStarted: false,
        pendingPrompt: replayPrompt || "See attached files.",
        pendingAttachments: replayAttachments,
        streamingText: "",
        streamingThinking: "",
        error: "",
        contextPreview: [],
        contextDebug: null,
        contextNotes: [],
        contextBudgetTokens: 0,
      });
      let finalError = "";
      try {
        // Truncate to BEFORE the user message — the stream re-persists the user
        // turn, so truncating AT it left the original in place and every
        // auto-regen produced two identical consecutive user messages.
        if (prevUserIdx === 0) {
          const truncResult = await truncateChatMessages(sessionId, userMessage.id);
          await syncDetail(sessionId, truncResult);
          const afterDelete = await deleteChatMessage(sessionId, userMessage.id);
          await syncDetail(sessionId, afterDelete);
        } else {
          const truncResult = await truncateChatMessages(sessionId, result.detail.messages[prevUserIdx - 1]!.id);
          await syncDetail(sessionId, truncResult);
        }
        await streamSessionResponse(sessionId, requestId, {
          prompt: replayPrompt,
          modelId: session.modelId,
          attachments: replayAttachments,
          sceneConstraintOverride: result.correctedScene,
        }, (event) => {
          if (event.type === "response.started") patchSessionStream(sessionId, { responseStarted: true });
          if (event.type === "response.context") patchSessionStream(sessionId, { contextPreview: event.preview, contextDebug: event.debug, contextBudgetTokens: event.budgetTokens, contextNotes: event.notes });
          if (event.type === "response.scene_validation") void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
        if (event.type === "response.completed") { patchSessionStream(sessionId, { completed: true, completedMessageId: event.message.id }); void queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] }); }
          if (event.type === "response.delta") updateSessionStream(sessionId, (current) => ({ ...current, streamingText: current.streamingText + event.delta }));
          if (event.type === "response.thinking.delta") updateSessionStream(sessionId, (current) => ({ ...current, streamingThinking: current.streamingThinking + event.delta }));
          if (event.type === "response.error") {
            finalError = event.error;
            patchSessionStream(sessionId, { error: event.error });
          }
        });
      } catch (error) {
        if (!isAbortError(error) || !stopRequestsRef.current[requestId]) {
          finalError = error instanceof Error ? error.message : "scene regen failed";
          patchSessionStream(sessionId, { error: finalError });
        }
      } finally {
        delete stopRequestsRef.current[requestId];
        setSessionMutatingMessageId(sessionId, null);
        await queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
        await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
        resetSessionStreamIfOwner(sessionId, requestId, finalError);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "scene resolution failed");
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
    setGeneratingImage(true);
    setSendError("");
    try {
      await generateSessionImage(session.id, {
        prompt,
        modelId: imageModelId,
      });
      setDraft("");
      await queryClient.invalidateQueries({ queryKey: ["session-detail", session.id] });
      await queryClient.invalidateQueries({ queryKey: ["workspace-state"] });
    } catch (error) {
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

  const useTemplateAsAttachment = (template: PromptTemplate) => {
    setAttachments((current) => {
      const next = {
        filename: toTemplateFilename(template.name),
        mimeType: "text/markdown",
        contentMode: "text" as const,
        content: template.content,
      };
      if (current.some((attachment) => attachment.filename === next.filename && attachment.content === next.content)) return current;
      return [...current, next].slice(0, 8);
    });
    setShowTemplateDialog(false);
  };

  messageActionsRef.current = { copyMessage, startEdit, resendFrom, regenerateFrom, saveEdit, cancelEdit };

  const renderMessage = (message: ChatMessage, index: number) => {
    if (message.role === "cold-start") {
      return (
        <div key={message.id} ref={(node) => { messageRefs.current[message.id] = node; }} className="message-card role-cold-start">
          <div className="message-heading"><p className="message-role" style={{ color: "var(--accent)" }}>Cold Start</p></div>
          <div className="message-body" style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>
        </div>
      );
    }
    const isPersistedMessage = !message.id.startsWith("pending-");
    const isLocked = session.pipelineWatermark != null && message.sortOrder <= session.pipelineWatermark;
    const isEditing = editingMessageId === message.id;
    const isLongMessage = (message.content || "").split("\n").length > 20;
    const messageCost = calculateMessageCost(message, session.cacheTtl);
    const turnHitRate = calculateTurnCacheHitRate(message);
    const renderActionBar = () => isPersistedMessage ? (
      <div className="message-actions">
        <button type="button" className="ghost-button" onClick={() => messageActionsRef.current.copyMessage(message)}>
          {copiedMessageId === message.id ? "Copied" : "Copy"}
        </button>
        {!sending && !generatingImage && !isLocked ? (
          <>
            <button type="button" className="ghost-button" onClick={() => messageActionsRef.current.startEdit(message)} disabled={Boolean(mutatingMessageId)}>
              Edit
            </button>
            {message.role === "user" ? (
              <button type="button" className="ghost-button" onClick={() => messageActionsRef.current.resendFrom(index)} disabled={Boolean(mutatingMessageId)}>
                Resend
              </button>
            ) : (
              <button type="button" className="ghost-button" onClick={() => messageActionsRef.current.regenerateFrom(index)} disabled={Boolean(mutatingMessageId)}>
                Regen
              </button>
            )}
            {index < messages.length - 1 ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => setConfirmingAction({ type: "truncate", messageId: message.id, label: message.role === "user" ? "this turn" : "this response" })}
                disabled={Boolean(mutatingMessageId)}
              >
                Cut
              </button>
            ) : null}
            <button
              type="button"
              className="ghost-button danger-copy"
              onClick={() => setConfirmingAction({ type: "delete", messageId: message.id, label: message.role === "user" ? "this user message" : "this assistant message" })}
              disabled={Boolean(mutatingMessageId)}
            >
              Delete
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
      onResolve={editableMessage ? (choice, p, pu) => resolveScene(message.id, choice, p, pu) : null}
      onEditSave={editableMessage ? (edits) => saveSceneEdit(message.id, edits) : null}
      autoRegen={resolvedContextSettings.sceneValidatorAutoRegen}
      disabled={Boolean(mutatingMessageId) || sending}
      campaignId={session.campaignId ?? null}
      attireEnabled={resolvedContextSettings.attireTrackingEnabled}
    /> : null}
    <article
      ref={(node) => {
        messageRefs.current[message.id] = node;
      }}
      className={`message-card role-${message.role}${isLocked ? " locked" : ""}${localSearchNeedle && message.content.toLocaleLowerCase().includes(localSearchNeedle) ? " search-hit" : ""}${activeSearchMessageId === message.id ? " active-match" : ""}${(message as any).stopReason === "refusal" ? " is-refusal" : ""}`}
    >
      <div className="message-heading">
        <p className="message-role">{message.role === "user" ? "You" : "Assistant"}</p>
        {message.modelId ? <span className="muted small-copy">{findChatModel(availableChatModels, message.modelId)?.label ?? getChatModel(message.modelId)?.label ?? message.modelId}</span> : null}
        {(message as any).fastMode ? <span className="msg-fast-badge" title="This turn ran in Anthropic fast mode (2.5× speed, ~2× cost)">⚡ FAST</span> : null}
        {(() => {
          // Serving-model transparency: badge any assistant turn the upstream reports
          // as produced by a different model than the one requested (e.g. a Fable 5
          // safeguard fallback served from Opus 4.8). Compare against the wire ID —
          // bridge variants map "-bridge" off before the request.
          const served = (message as any).servedModel as string | null | undefined;
          if (!served || message.role !== "assistant" || !message.modelId) return null;
          const requestedWireId = message.modelId.endsWith("-bridge") ? message.modelId.slice(0, -"-bridge".length) : message.modelId;
          // Bidirectional prefix match: providers report snapshot ids (gpt-5.4 ->
  // gpt-5.4-2026-03-05) or base ids for dated requests — neither direction is
  // a substitution. Real substitutions (grok-4 -> grok-4.3 class) still badge.
  if (served === requestedWireId || served.startsWith(requestedWireId) || requestedWireId.startsWith(served)) return null;
          const servedLabel = getChatModel(served)?.label ?? served;
          return <span className="msg-served-badge" title={`Requested ${requestedWireId} but the response was produced by ${served} (provider-side substitution or fallback).`}>⚠ SERVED BY {servedLabel.toUpperCase()}</span>;
        })()}
        {message.usage ? <span className="message-usage">↓{formatUsageValue(message.usage.inputTokens)} ↑{formatUsageValue(message.usage.outputTokens)}{(message.usage.reasoningTokens ?? 0) > 0 ? ` 🧠${formatUsageValue(message.usage.reasoningTokens)}` : ""} Σ{formatUsageValue(message.usage.totalTokens)}{(message.usage.cacheReadTokens ?? 0) > 0 ? ` ⚡${formatUsageValue(message.usage.cacheReadTokens)}` : ""}{(message.usage.cacheWriteTokens ?? 0) > 0 ? ` 📝${formatUsageValue(message.usage.cacheWriteTokens)}` : ""}{turnHitRate != null ? <span className={`turn-hit-rate ${turnHitRate > 0 ? "hit" : "miss"}`}> {formatPercent(turnHitRate)}</span> : null}{messageCost != null ? ` · ~${formatCostValue(messageCost)}` : ""}</span> : null}
      </div>
      {(message as any).stopReason === "refusal" ? (() => {
        const details = (message as any).stopDetails as { type?: string; category?: string | null; explanation?: string | null } | null;
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
      {isLongMessage ? renderActionBar() : null}
      {isEditing ? (
        <div className="message-edit-stack">
          <div className="textarea-grow-wrap">
            <textarea
              aria-label="Edit message"
              className="message-edit-input"
              defaultValue={editDraftRef.current}
              onChange={(event) => { editDraftRef.current = event.target.value; }}
              disabled={mutatingMessageId === message.id}
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
      {!isEditing && !isLongMessage ? renderActionBar() : null}
      {!isEditing && isLongMessage ? renderActionBar() : null}
    </article>
    </div>
  );};

  const historicalElements = useMemo(
    () => messages.map((m, i) => renderMessage(m, i)),
    // resolvedContextSettings + campaignId were missing: toggling Attire or
    // Auto-regen in the Engine popover didn't re-render existing scene
    // dividers (react-query structural sharing keeps the messages reference).
    [messages, editingMessageId, mutatingMessageId, copiedMessageId, localSearchNeedle, activeSearchMessageId, sending, generatingImage, session.pipelineWatermark, session.cacheTtl, session.campaignId, availableChatModels, resolvedContextSettings.sceneValidatorAutoRegen, resolvedContextSettings.attireTrackingEnabled],
  );

  const pendingElements = useMemo(() => {
    const out: React.ReactNode[] = [];
    let i = messages.length;
    if (streamState.pendingPrompt && !pendingAlreadyPersisted) {
      out.push(renderMessage({
        id: "pending-user", sessionId: session.id, role: "user", content: streamState.pendingPrompt,
        thinking: null, modelId: null, usage: null, stopReason: null, stopDetails: null, fastMode: false, servedModel: null,
        sceneData: null, sceneValidator: null, sceneResolution: null, overhead: null,
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
    if (streamState.sending && !streamState.streamingText && !streamState.streamingThinking) {
      // Nothing has streamed yet — show what the server is doing instead of dead air.
      // Context assembly (retrieval/researcher/HyDE) runs before response.started;
      // after it, large campaigns can sit in model ingestion for a minute.
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
            <span className="msg-waiting-dots" aria-hidden="true"><span /><span /><span /></span>
            <span className="msg-waiting-label">{streamState.responseStarted
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
        modelId: session.modelId, usage: null, stopReason: null, stopDetails: null, fastMode: false, servedModel: null,
        sceneData: null, sceneValidator: null, sceneResolution: null, overhead: null,
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
              <span>{selectedModel?.label ?? "Select model"}</span>
              <span className="chevron">{modelMenuOpen ? "▴" : "▾"}</span>
            </button>
            {modelMenuOpen ? (
              <div className="model-menu">
                {chatModelGroups.map((group) => (
                  <div key={group.provider}>
                    <button
                      type="button"
                      className={`model-menu-provider ${modelMenuProvider === group.provider ? "open" : ""}`}
                      onClick={() => setModelMenuProvider((current) => current === group.provider ? null : group.provider)}
                    >
                      <span>{group.label}</span>
                      <span className="chevron">{modelMenuProvider === group.provider ? "▾" : "▸"}</span>
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
                    onClick={() => {
                      const defaultId = campaign?.pipelineModelId ?? availableChatModels[0]?.id ?? "";
                      setSeedDialogCreativeModelId(defaultId);
                      setSeedDialogOpen(true);
                    }}
                    disabled={updateSeedMutation.isPending || sending || pipelineQueueBusy}
                    title={pipelineQueueBusy ? "Pipeline jobs are currently running" : "Run the campaign pipeline to update the state seed and system prompt"}
                  >
                    {updateSeedMutation.isPending ? "Starting..." : "Update Seed"}
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
                  Link to Campaign
                </button>
              )}
              <select aria-label="Image model" className="tb-btn" value={imageModelId} onChange={(event) => setImageModelId(event.target.value)} disabled={generatingImage || sending} style={{ cursor: "pointer" }}>
                {IMAGE_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
              <button type="button" className="tb-btn" onClick={exportConversation} disabled={exporting || sending || generatingImage}>
                {exporting ? "..." : "Export"}
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
              {selectedModel?.supportsEffort && session.effort ? (
                <>
                  <span className="chat-status-chip-divider">·</span>
                  <span>{capitalize(session.effort)}</span>
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
              >
                <span>Engine</span>
                <span className="chat-status-chip-divider">·</span>
                <span>R:{resolvedContextSettings.researcherEnabled ? resolvedContextSettings.researcherModel.split("-").slice(1, -1).join(" ") : "off"}</span>
                <span className="chat-status-chip-divider">·</span>
                <span>L:{resolvedContextSettings.rollingEnabled ? `${resolvedContextSettings.rollingModel.split("-").slice(1, -1).join(" ")}/${resolvedContextSettings.rollingCadence}` : "off"}</span>
              </button>
              {(() => {
                const usedTokens = streamState.contextDebug?.totalTokens ?? 0;
                const budget = streamState.contextBudgetTokens || 1;
                const ratio = Math.min(1, usedTokens / budget);
                const included = streamState.contextPreview.filter((e) => e.included).length;
                const hasData = streamState.contextPreview.length > 0;
                const degraded = streamState.contextNotes.length > 0;
                return (
                  <button
                    ref={previewChipRef}
                    type="button"
                    className={`chat-status-chip${previewPopoverOpen ? " active" : ""}${degraded ? " degraded" : ""}`}
                    onClick={() => setPreviewPopoverOpen((o) => !o)}
                    title={degraded ? streamState.contextNotes.join("\n") : undefined}
                  >
                    <span>{degraded ? "⚠ Preview" : "Preview"}</span>
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
                className={`chat-status-chip${threadsPopoverOpen ? " active" : ""}`}
                onClick={() => setThreadsPopoverOpen((o) => !o)}
                title="Pending narrative threads"
              >
                <span>Threads</span>
                <span className="chat-status-chip-divider">·</span>
                <span>{threadData.active}</span>
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
            {(selectedModel as any)?.thinkingAlwaysOn ? (
              <>
                <div className="ctrl-divider" />
                <div className="ctrl-group">
                  <span className="lbl">Thinking</span>
                  <select
                    aria-label="Thinking mode (always on for this model)"
                    value="adaptive"
                    disabled
                    title="Thinking cannot be turned off on this model — it runs adaptively on every request and is billed whether or not it is displayed."
                  >
                    <option value="adaptive">Adaptive (always on)</option>
                  </select>
                </div>
              </>
            ) : selectedModel?.supportsThinkingBudget ? (
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
                {session.thinkingMode !== "off" && session.thinkingMode !== "adaptive" ? (
                  <div className="ctrl-group">
                    <span className="lbl">Budget</span>
                    <NumericInput
                      aria-label="Thinking budget"
                      min={128}
                      max={selectedModel.maxThinkingBudget ?? 24576}
                      value={session.thinkingBudget ?? selectedModel.maxThinkingBudget ?? 24576}
                      disabled={savingSessionSettings || sending || generatingImage}
                      onChange={(v) => saveSessionSettings({ thinkingBudget: v })}
                    />
                  </div>
                ) : null}
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
            {selectedModel?.supportsEffort ? (
              <>
                <div className="ctrl-divider" />
                <div className="ctrl-group">
                  <span className="lbl">{selectedModel.provider === "google" ? "Thinking" : "Effort"}</span>
                  <select
                    aria-label={selectedModel.provider === "google" ? "Thinking level" : "Reasoning effort"}
                    value={session.effort ?? "medium"}
                    disabled={savingSessionSettings || sending || generatingImage}
                    onChange={(event) => saveSessionSettings({ effort: event.target.value })}
                  >
                    {(selectedModel.effortOptions ?? ["low", "medium", "high"]).map((effort) => (
                      <option key={effort} value={effort}>{capitalize(effort)}</option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}
            {(() => {
              // Fast mode toggle: shown only on Anthropic models with catalog fast pricing
              // (4.6/4.7/4.8 direct). Bridge variants and other providers hide it entirely
              // because speed:"fast" is not supported through those paths.
              const fastCapable = Boolean(selectedModel
                && (selectedModel as any).fastModeInputCostPerMillionTokens != null
                && selectedModel.provider === "anthropic"
                // Server reads fastModeEnabled from campaign context settings
                // only — on a plain session the toggle lit up, persisted, and
                // did nothing (standard speed, no badge, no error).
                && Boolean(session.campaignId));
              if (!fastCapable) return null;
              const isOn = Boolean(resolvedContextSettings.fastModeEnabled);
              return (
                <>
                  <div className="ctrl-divider" />
                  <div className="ctrl-group">
                    <button
                      type="button"
                      className={`fast-mode-toggle${isOn ? " is-on" : ""}`}
                      title={(() => {
                        const std = (selectedModel as any)?.inputCostPerMillionTokens as number | undefined;
                        const fast = (selectedModel as any)?.fastModeInputCostPerMillionTokens as number | undefined;
                        const mult = std && fast ? `~${Math.round(fast / std)}×` : "higher";
                        return isOn
                          ? `Fast mode ON — faster output at ${mult} cost. Click to disable. (Toggling invalidates prompt cache.)`
                          : `Fast mode OFF — toggle on for Anthropic fast inference (${mult} cost). Requires account approval.`;
                      })()}
                      disabled={savingSessionSettings || sending || generatingImage}
                      onClick={() => saveSessionSettings({ contextOverrides: { fastModeEnabled: !isOn } })}
                    >
                      <span className="bolt">⚡</span> Fast
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

      {campaign ? (
        <>
          <Popover
            open={enginePopoverOpen}
            anchorRef={engineChipRef}
            onClose={() => setEnginePopoverOpen(false)}
            title="Context Engine"
            width={460}
          >
            <div className="popover-section">
              <div className="popover-section-title">Retrieval</div>
              <div className="ctrl-bar">
                <div className="ctrl-group">
                  <span className="lbl">Mode</span>
                  <select
                    aria-label="Context mode"
                    value={resolvedContextSettings.mode}
                    disabled={savingSessionSettings || sending}
                    onChange={(event) => saveSessionSettings({ contextOverrides: { mode: event.target.value } })}
                  >
                    <option value="keyword">Keyword</option>
                    <option value="semantic">Semantic</option>
                    <option value="hybrid">Hybrid</option>
                    <option value="off">Off</option>
                  </select>
                </div>
                {resolvedContextSettings.mode === "semantic" || resolvedContextSettings.mode === "hybrid" ? (
                  <>
                    <div className="ctrl-group">
                      <span className="lbl">Embed</span>
                      <select
                        aria-label="Embedding model"
                        value={resolvedContextSettings.embeddingModel}
                        disabled={savingSessionSettings || sending}
                        onChange={(event) => saveSessionSettings({ contextOverrides: { embeddingModel: event.target.value } })}
                      >
                        {EMBEDDING_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    </div>
                    <div className="ctrl-group">
                      <span className="lbl">Top-K</span>
                      <NumericInput
                        aria-label="Semantic Top-K"
                        min={1}
                        max={50}
                        value={resolvedContextSettings.semanticTopK}
                        disabled={savingSessionSettings || sending}
                        onChange={(v) => saveSessionSettings({ contextOverrides: { semanticTopK: v } })}
                        style={{ width: 40 }}
                      />
                    </div>
                    <div className="ctrl-group">
                      <span className="lbl">Threshold</span>
                      <NumericInput
                        aria-label="Semantic threshold"
                        min={0}
                        max={1}
                        step={0.05}
                        value={resolvedContextSettings.semanticThreshold}
                        disabled={savingSessionSettings || sending}
                        onChange={(v) => saveSessionSettings({ contextOverrides: { semanticThreshold: v } })}
                        style={{ width: 50 }}
                      />
                    </div>
                  </>
                ) : null}
                <div className="ctrl-group">
                  <span className="lbl">Scan</span>
                  <NumericInput
                    aria-label="Scan depth"
                    min={0}
                    max={100}
                    value={resolvedContextSettings.scanDepth}
                    disabled={savingSessionSettings || sending}
                    onChange={(v) => saveSessionSettings({ contextOverrides: { scanDepth: v } })}
                    style={{ width: 40 }}
                  />
                  <span className="lbl">turns</span>
                </div>
                <div className="ctrl-group">
                  <span className="lbl">Budget</span>
                  <NumericInput
                    aria-label="Retrieval budget tokens"
                    min={0}
                    max={50000}
                    step={500}
                    value={resolvedContextSettings.retrievalBudgetTokens}
                    disabled={savingSessionSettings || sending}
                    onChange={(v) => saveSessionSettings({ contextOverrides: { retrievalBudgetTokens: v } })}
                    style={{ width: 60 }}
                  />
                  <span className="lbl">tok</span>
                </div>
                <div className="ctrl-group">
                  <span className="lbl">Context</span>
                  <NumericInput
                    aria-label="Context budget tokens"
                    min={10000}
                    max={2000000}
                    step={10000}
                    value={resolvedContextSettings.contextBudgetTokens}
                    disabled={savingSessionSettings || sending}
                    onChange={(v) => saveSessionSettings({ contextOverrides: { contextBudgetTokens: v } })}
                    style={{ width: 80 }}
                  />
                  <span className="lbl">tok</span>
                </div>
                <div className="ctrl-group">
                  <span className="lbl">Guaranteed</span>
                  <NumericInput
                    aria-label="Guaranteed message count"
                    min={2}
                    max={200}
                    value={resolvedContextSettings.guaranteedMessageCount}
                    disabled={savingSessionSettings || sending}
                    onChange={(v) => saveSessionSettings({ contextOverrides: { guaranteedMessageCount: v } })}
                    style={{ width: 40 }}
                  />
                  <span className="lbl">msgs</span>
                </div>
                <div className="ctrl-group" title="Score multiplier applied to cold-archived entries when an activating compressed trigger is replaced by its full cold content. 1 = equal weight to active entries, <1 = downweight (cold only wins budget on strong activation), 0 = cold enters at score 0 (likely pruned by budget, but if room exists the full cold content still appears). Compressed synopsis content is never injected into context regardless of this value — CT activation always inflates.">
                  <span className="lbl">Cold weight</span>
                  <NumericInput
                    aria-label="Cold inflation weight multiplier"
                    min={0}
                    max={2}
                    step={0.1}
                    value={resolvedContextSettings.coldInflationWeightMultiplier}
                    disabled={savingSessionSettings || sending}
                    onChange={(v) => saveSessionSettings({ contextOverrides: { coldInflationWeightMultiplier: v } })}
                    style={{ width: 40 }}
                  />
                  <span className="lbl">×</span>
                </div>
              </div>
            </div>

            <div className="popover-section">
              <div className="popover-section-title">HyDE Query Expansion</div>
              <div className="ctrl-bar">
                <div className="ctrl-group">
                  <button
                    type="button"
                    className={`toggle-pill ${resolvedContextSettings.hydeEnabled ? "active" : ""}`}
                    onClick={() => saveSessionSettings({ contextOverrides: { hydeEnabled: !resolvedContextSettings.hydeEnabled } })}
                    disabled={savingSessionSettings || sending}
                    style={{ fontSize: 10, padding: "1px 6px" }}
                    title="Expands user prompts into a hypothetical answer to widen semantic recall"
                  >
                    {resolvedContextSettings.hydeEnabled ? "On" : "Off"}
                  </button>
                  {resolvedContextSettings.hydeEnabled ? (
                    <>
                      <span className="lbl">Model</span>
                      <select
                        aria-label="HyDE model"
                        value={resolvedContextSettings.hydeModel ?? resolvedContextSettings.researcherModel}
                        disabled={savingSessionSettings || sending}
                        onChange={(event) => saveSessionSettings({ contextOverrides: { hydeModel: event.target.value } })}
                      >
                        {availableChatModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="popover-section">
              <div className="popover-section-title">Researcher</div>
              <div className="ctrl-bar">
                <div className="ctrl-group">
                  <button
                    type="button"
                    className={`toggle-pill ${resolvedContextSettings.researcherEnabled ? "active" : ""}`}
                    onClick={() => saveSessionSettings({ contextOverrides: { researcherEnabled: !resolvedContextSettings.researcherEnabled } })}
                    disabled={savingSessionSettings || sending}
                    style={{ fontSize: 10, padding: "1px 6px" }}
                  >
                    {resolvedContextSettings.researcherEnabled ? "On" : "Off"}
                  </button>
                  {resolvedContextSettings.researcherEnabled ? (
                    <>
                      <span className="lbl">Model</span>
                      <select
                        aria-label="Researcher model"
                        value={resolvedContextSettings.researcherModel}
                        disabled={savingSessionSettings || sending}
                        onChange={(event) => saveSessionSettings({ contextOverrides: { researcherModel: event.target.value } })}
                      >
                        {availableChatModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                      <span className="lbl">Max picks</span>
                      <NumericInput
                        aria-label="Researcher max picks"
                        min={1}
                        max={50}
                        value={resolvedContextSettings.researcherMaxPicks}
                        disabled={savingSessionSettings || sending}
                        onChange={(v) => saveSessionSettings({ contextOverrides: { researcherMaxPicks: v } })}
                        style={{ width: 40 }}
                      />
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="popover-section">
              <div className="popover-section-title">Rolling Diff</div>
              <div className="ctrl-bar">
                <div className="ctrl-group">
                  <button
                    type="button"
                    className={`toggle-pill ${resolvedContextSettings.rollingEnabled ? "active" : ""}`}
                    onClick={() => saveSessionSettings({ contextOverrides: { rollingEnabled: !resolvedContextSettings.rollingEnabled } })}
                    disabled={savingSessionSettings || sending}
                    style={{ fontSize: 10, padding: "1px 6px" }}
                  >
                    {resolvedContextSettings.rollingEnabled ? "On" : "Off"}
                  </button>
                  {resolvedContextSettings.rollingEnabled ? (
                    <>
                      <span className="lbl">every</span>
                      <NumericInput
                        aria-label="Rolling diff cadence"
                        min={1}
                        max={32}
                        value={resolvedContextSettings.rollingCadence}
                        disabled={savingSessionSettings || sending}
                        onChange={(v) => saveSessionSettings({ contextOverrides: { rollingCadence: v } })}
                        style={{ width: 40 }}
                      />
                      <span className="lbl">turns</span>
                      <select
                        aria-label="Rolling diff model"
                        value={resolvedContextSettings.rollingModel}
                        disabled={savingSessionSettings || sending}
                        onChange={(event) => saveSessionSettings({ contextOverrides: { rollingModel: event.target.value } })}
                      >
                        {availableChatModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="popover-section">
              <div className="popover-section-title">Scene Validator</div>
              <div className="ctrl-bar">
                <div className="ctrl-group">
                  <button
                    type="button"
                    className={`toggle-pill ${resolvedContextSettings.sceneValidatorEnabled ? "active" : ""}`}
                    onClick={() => saveSessionSettings({ contextOverrides: { sceneValidatorEnabled: !resolvedContextSettings.sceneValidatorEnabled } })}
                    disabled={savingSessionSettings || sending}
                    style={{ fontSize: 10, padding: "1px 6px" }}
                  >
                    {resolvedContextSettings.sceneValidatorEnabled ? "On" : "Off"}
                  </button>
                  {resolvedContextSettings.sceneValidatorEnabled ? (
                    <>
                      <span className="lbl">Model</span>
                      <select
                        aria-label="Scene validator model"
                        value={resolvedContextSettings.sceneValidatorModel}
                        disabled={savingSessionSettings || sending}
                        onChange={(event) => saveSessionSettings({ contextOverrides: { sceneValidatorModel: event.target.value } })}
                      >
                        {availableChatModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                      <button
                        type="button"
                        className={`toggle-pill ${resolvedContextSettings.sceneValidatorAutoRegen ? "active" : ""}`}
                        onClick={() => saveSessionSettings({ contextOverrides: { sceneValidatorAutoRegen: !resolvedContextSettings.sceneValidatorAutoRegen } })}
                        disabled={savingSessionSettings || sending}
                        style={{ fontSize: 10, padding: "1px 6px" }}
                        title="Auto-regenerate message when picking validator/user resolution"
                      >
                        Auto-regen {resolvedContextSettings.sceneValidatorAutoRegen ? "On" : "Off"}
                      </button>
                    </>
                  ) : null}
                </div>
                {resolvedContextSettings.sceneValidatorEnabled ? (
                  <div className="ctrl-group" style={{ marginTop: 4 }}>
                    <span className="lbl">Attire</span>
                    <button
                      type="button"
                      className={`toggle-pill ${resolvedContextSettings.attireTrackingEnabled ? "active" : ""}`}
                      onClick={() => saveSessionSettings({ contextOverrides: { attireTrackingEnabled: !resolvedContextSettings.attireTrackingEnabled } })}
                      disabled={savingSessionSettings || sending}
                      style={{ fontSize: 10, padding: "1px 6px" }}
                      title="Track each present character's attire; verifier folds attire reconciliation into the scene validator pass"
                    >
                      {resolvedContextSettings.attireTrackingEnabled ? "On" : "Off"}
                    </button>
                    {resolvedContextSettings.attireTrackingEnabled ? (
                      <>
                        <span className="lbl" title="Turns since a character was last seen before their recorded attire is flagged stale in context">Stale after (turns)</span>
                        <input
                          type="number"
                          min={1}
                          max={200}
                          value={resolvedContextSettings.attireStaleTurnThreshold}
                          disabled={savingSessionSettings || sending}
                          onChange={(event) => {
                            const v = Number(event.target.value);
                            if (Number.isFinite(v) && v >= 1 && v <= 200) {
                              saveSessionSettings({ contextOverrides: { attireStaleTurnThreshold: Math.round(v) } });
                            }
                          }}
                          style={{ width: 50, fontSize: 10 }}
                        />
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="popover-section">
              <div className="popover-section-title">Pipeline (Auto-Enqueue)</div>
              <div className="ctrl-bar">
                <div className="ctrl-group">
                  <span className="lbl">Auto</span>
                  <button
                    type="button"
                    className={`toggle-pill ${resolvedContextSettings.pipelineAutoEnabled ? "active" : ""}`}
                    onClick={() => saveSessionSettings({ contextOverrides: { pipelineAutoEnabled: !resolvedContextSettings.pipelineAutoEnabled } })}
                    disabled={savingSessionSettings || sending}
                    style={{ fontSize: 10, padding: "1px 6px" }}
                    title="Master switch for all auto-enqueued pipeline jobs (rolling diff, repetition, sysprompt audit, consolidation, archival)"
                  >
                    {resolvedContextSettings.pipelineAutoEnabled ? "On" : "Off"}
                  </button>
                </div>
                {resolvedContextSettings.pipelineAutoEnabled ? (
                  <>
                    <div className="ctrl-group">
                      <span className="lbl">Rolling diff at</span>
                      <NumericInput
                        aria-label="Rolling diff char threshold"
                        min={1000}
                        max={200000}
                        step={1000}
                        value={resolvedContextSettings.rollingDiffCharThreshold}
                        disabled={savingSessionSettings || sending}
                        onChange={(v) => saveSessionSettings({ contextOverrides: { rollingDiffCharThreshold: v } })}
                        style={{ width: 70 }}
                      />
                      <span className="lbl">chars</span>
                      <span className="inherit-hint">model from Rolling Diff section</span>
                    </div>
                    <div className="ctrl-group">
                      <span className="lbl">Repetition at</span>
                      <NumericInput
                        aria-label="Repetition char threshold"
                        min={5000}
                        max={500000}
                        step={5000}
                        value={resolvedContextSettings.repetitionCharThreshold}
                        disabled={savingSessionSettings || sending}
                        onChange={(v) => saveSessionSettings({ contextOverrides: { repetitionCharThreshold: v } })}
                        style={{ width: 70 }}
                      />
                      <span className="lbl">chars</span>
                      <span className="inherit-hint">model from Campaign pipeline</span>
                    </div>
                    <div className="ctrl-group">
                      <span className="lbl">Sysprompt audit at</span>
                      <NumericInput
                        aria-label="Sysprompt audit char threshold"
                        min={10000}
                        max={1000000}
                        step={10000}
                        value={resolvedContextSettings.syspromptAuditCharThreshold}
                        disabled={savingSessionSettings || sending}
                        onChange={(v) => saveSessionSettings({ contextOverrides: { syspromptAuditCharThreshold: v } })}
                        style={{ width: 80 }}
                      />
                      <span className="lbl">chars</span>
                      <span className="inherit-hint">model from Campaign pipeline</span>
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            <div className="popover-section">
              <div className="popover-section-title">Anti-Repetition</div>
              <div className="ctrl-bar">
                <div className="ctrl-group">
                  <span className="lbl">Max rules</span>
                  <NumericInput
                    aria-label="Max anti-repetition rules"
                    min={10}
                    max={300}
                    value={resolvedContextSettings.maxAntiRepetitionRules}
                    disabled={savingSessionSettings || sending}
                    onChange={(v) => saveSessionSettings({ contextOverrides: { maxAntiRepetitionRules: v } })}
                    style={{ width: 50 }}
                  />
                </div>
                <div className="ctrl-group">
                  <span className="lbl">Archive after</span>
                  <NumericInput
                    aria-label="Anti-rep archive after N runs unmatched"
                    min={2}
                    max={20}
                    value={resolvedContextSettings.antiRepArchiveAfter}
                    disabled={savingSessionSettings || sending}
                    onChange={(v) => saveSessionSettings({ contextOverrides: { antiRepArchiveAfter: v } })}
                    style={{ width: 40 }}
                  />
                  <span className="lbl">unmatched runs</span>
                </div>
              </div>
            </div>

            <div className="popover-section">
              <div className="popover-section-title">UI</div>
              <div className="ctrl-bar">
                <div className="ctrl-group">
                  <span className="lbl">Live context preview</span>
                  <button
                    type="button"
                    className={`toggle-pill ${resolvedContextSettings.previewEnabled ? "active" : ""}`}
                    onClick={() => saveSessionSettings({ contextOverrides: { previewEnabled: !resolvedContextSettings.previewEnabled } })}
                    disabled={savingSessionSettings || sending}
                    style={{ fontSize: 10, padding: "1px 6px" }}
                    title="Stream context-assembly events to the Preview popover during generation"
                  >
                    {resolvedContextSettings.previewEnabled ? "On" : "Off"}
                  </button>
                </div>
              </div>
            </div>
          </Popover>

          <Popover
            open={previewPopoverOpen}
            anchorRef={previewChipRef}
            onClose={() => setPreviewPopoverOpen(false)}
            title={streamState.contextPreview.length > 0
              ? `Context Preview · ${streamState.contextPreview.filter((e) => e.included).length} entries · ${streamState.contextDebug?.totalTokens ?? 0} / ${streamState.contextBudgetTokens} tok`
              : "Context Preview"}
            width={520}
          >
            {streamState.contextNotes.length > 0 ? (
              <div className="ctx-preview-notes">
                {streamState.contextNotes.map((note, i) => (
                  <div key={i} className="ctx-preview-note">⚠ {note}</div>
                ))}
              </div>
            ) : null}
            {streamState.contextPreview.length > 0 ? (
              <>
                <div className="ctx-preview-summary">
                  <span className="ctx-stat"><span className="ctx-stat-val">{streamState.contextDebug?.keywordHits ?? 0}</span> keyword</span>
                  <span className="ctx-stat"><span className="ctx-stat-val">{streamState.contextDebug?.semanticHits ?? 0}</span> semantic</span>
                  <span className="ctx-stat"><span className="ctx-stat-val">{streamState.contextDebug?.researcherHits ?? 0}</span> researcher</span>
                  {(streamState.contextDebug?.coldInflations ?? 0) > 0 ? (
                    <span className="ctx-stat cold-inflate"><span className="ctx-stat-val">{streamState.contextDebug?.coldInflations}</span> inflated</span>
                  ) : null}
                  {(streamState.contextDebug?.droppedForBudget ?? 0) > 0 ? (
                    <span className="ctx-stat dropped"><span className="ctx-stat-val">{streamState.contextDebug?.droppedForBudget}</span> dropped</span>
                  ) : null}
                </div>
                <div className="ctx-preview-entries">
                  {[...streamState.contextPreview].sort((a, b) => b.score - a.score).map((entry) => (
                    <div key={entry.entryId} className={`ctx-preview-entry${entry.included ? "" : " dropped"}`}>
                      <span className={`ctx-source-pill ${entry.source}`}>{entry.source === "scene-present" ? "scene" : entry.source === "cold-inflate" ? "cold" : entry.source}</span>
                      <span className="entry-name" title={entry.name}>{entry.name}</span>
                      {entry.tag ? <span className="entry-tag">{entry.tag}</span> : null}
                      <span className="entry-score">{entry.score}</span>
                      <span className="entry-tokens">{entry.tokenCost}t</span>
                      <span className={`entry-status ${entry.included ? "included" : "excluded"}`}>{entry.included ? "✓" : "✗"}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p style={{ margin: 0, color: "var(--text2)" }}>No context data yet — send a message to see the breakdown.</p>
            )}
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
          </Popover>

          <Popover
            open={threadsPopoverOpen}
            anchorRef={threadsChipRef}
            onClose={() => setThreadsPopoverOpen(false)}
            title={`Threads · ${threadData.active} active`}
            width={520}
          >
            {threadData.threads.length === 0 ? (
              <p style={{ margin: 0, color: "var(--text2)" }}>
                No threads tracked yet. The thread tracker builds itself as the campaign's pipeline runs.
              </p>
            ) : (
              <div className="thread-list">
                {[...threadData.threads]
                  .sort((a, b) => {
                    const pa = THREAD_PENDING.has(a.status) ? 0 : 1;
                    const pb = THREAD_PENDING.has(b.status) ? 0 : 1;
                    return pa - pb;
                  })
                  .map((t) => (
                    <div key={t.id} className={`thread-card thread-${t.status.toLowerCase()}`}>
                      <div className="thread-card-head">
                        <span className={`thread-status-badge thread-${t.status.toLowerCase()}`}>{t.status}</span>
                        <span className="thread-card-title">{t.title}</span>
                        <span className="thread-card-id">{t.id}</span>
                      </div>
                      <div className="thread-card-summary">{t.summary || t.headline}</div>
                      {THREAD_PENDING.has(t.status) && t.nextBeat ? (
                        <div className="thread-card-next"><strong>Next:</strong> {t.nextBeat}</div>
                      ) : null}
                      {t.pendingDates ? <div className="thread-card-dates">⏱ {t.pendingDates}</div> : null}
                      <div className="thread-card-meta">
                        {t.involved.length > 0 ? <span>{t.involved.join(", ")}</span> : null}
                        {t.openedDate ? <span>opened {t.openedDate}</span> : null}
                        {t.lastUpdatedDate ? <span>updated {t.lastUpdatedDate}</span> : null}
                      </div>
                      {t.log.length > 0 ? (
                        <details className="thread-card-log">
                          <summary>{t.log.length} log entries</summary>
                          <ul>{t.log.map((l, i) => <li key={i}>{l}</li>)}</ul>
                        </details>
                      ) : null}
                    </div>
                  ))}
              </div>
            )}
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
            </p>
          </div>
        ) : null}
        <div className="message-list" ref={messageListRef}>
          {detail.isLoading ? <p className="muted">Loading conversation...</p> : null}
          {!detail.isLoading && renderedMessages.length === 0 ? <p className="muted">{isWizardSession ? "The wizard will guide campaign setup through chat." : "Send the first message to start the session."}</p> : null}
          {historicalElements}
          {pendingElements}
        </div>

        <div className="input-area">
          {attachments.length ? (
            <div className="file-chips">
              {attachments.map((attachment) => (
                <span key={`${attachment.filename}-${attachment.content.length}`} className={`file-chip ${isImageAttachment(attachment) ? "image" : isPdfAttachment(attachment) ? "pdf" : "text"}`}>
                  <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.filename}</span>
                  <button type="button" className="file-chip-x" onClick={() => setAttachments((current) => current.filter((item) => item !== attachment))}>×</button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="input-wrap">
            {!isWizardSession ? (
              <button type="button" className="tb-btn" onClick={openTemplateDialog} disabled={sending || generatingImage} style={{ alignSelf: "center", padding: "0 10px", height: 36, fontSize: 11 }}>
                📋
              </button>
            ) : null}
            <label className="tb-btn" style={{ alignSelf: "center", cursor: "pointer", padding: "0 10px", height: 36, fontSize: 11 }}>
              📎
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
                    next.push(await readAttachmentFile(file));
                  }
                  setAttachments((current) => [...current, ...next].slice(0, 8));
                  input.value = "";
                }}
              />
            </label>
            <div className="textarea-grow-wrap">
              <div className="textarea-grow-handle at-top" onMouseDown={startTextareaResize} title="Drag to resize" />
              <textarea
                aria-label="Message prompt"
                placeholder={isWizardSession ? "Answer the wizard..." : "Send a message..."}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={sending}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && draft.trim()) {
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
                    next.push(await readAttachmentFile(file));
                  }
                  if (next.length) setAttachments((current) => [...current, ...next].slice(0, 8));
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, alignSelf: "flex-end", flexShrink: 0 }}>
              {sending ? (
                <button type="button" className="send-btn" onClick={stopStreaming} disabled={stopping} title="Stop">■</button>
              ) : (
                <button type="button" className="send-btn" onClick={sendMessage} disabled={!draft.trim() && !attachments.length} title="Send">▲</button>
              )}
              {!isWizardSession ? (
                <button type="button" className="tb-btn" onClick={generateImage} disabled={!draft.trim() || generatingImage || sending} style={{ fontSize: 10, padding: "2px 6px" }} title="Generate image">
                  🖼
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
                  {startingWizardRun ? "Starting..." : "✨ Generate Campaign"}
                </button>
              ) : null}
            </div>
          </div>
          {visibleError ? <p className="error" style={{ maxWidth: 900, margin: "8px auto 0", fontSize: 12 }}>{visibleError}</p> : null}
        </div>

        <div className="status-bar">
          <button type="button" className="status-bar-toggle" onClick={() => setStatusBarOpen((current) => !current)}>
            {statusBarOpen ? "▾" : "▸"} Stats{!statusBarOpen ? ` · ${formatCostValue(estimatedCost)}${selectedModel?.supportsCacheTtl && cacheHitRate != null ? ` · Hit ${formatPercent(cacheHitRate)}` : ""}` : ""}
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
              <div className="status-stat">
                <span className="label">Session</span>
                <span className="value">{formatCostValue(estimatedCost)}</span>
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
        <div className="dialog-backdrop">
          <div className="dialog-card template-dialog" role="dialog" aria-modal="true" aria-label="Prompt templates">
            <div className="stack stack-tight">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Prompt Templates</p>
                  <h3>{editingTemplateId ? "Edit Template" : "Create Template"}</h3>
                </div>
                <button type="button" className="secondary-button" onClick={() => setShowTemplateDialog(false)} disabled={savingTemplate}>
                  Close
                </button>
              </div>
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
                        <button type="button" className="secondary-button" onClick={() => useTemplateAsAttachment(template)} disabled={savingTemplate}>
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
                    <input aria-label="Prompt template name" value={templateNameDraft} onChange={(event) => setTemplateNameDraft(event.target.value)} disabled={savingTemplate} />
                  </label>
                  <label className="stack stack-tight">
                    <span className="muted small-copy">Template Content</span>
                    <textarea
                      aria-label="Prompt template content"
                      className="message-edit-input template-editor"
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
          </div>
        </div>
      ) : null}

      {confirmingAction ? (
        <div className="dialog-backdrop">
          <div className="dialog-card" role="dialog" aria-modal="true" aria-label="Confirm message action">
            <div className="stack stack-tight">
              <p className="eyebrow">Message Action</p>
              <h3>{confirmingAction.type === "truncate" ? "Cut After Message" : "Delete Message"}</h3>
              <p className="muted">
                {confirmingAction.type === "truncate"
                  ? `Delete everything after ${confirmingAction.label}?`
                  : `Delete ${confirmingAction.label}?`}
              </p>
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
          </div>
        </div>
      ) : null}

      {confirmingTemplateDelete ? (
        <div className="dialog-backdrop">
          <div className="dialog-card" role="dialog" aria-modal="true" aria-label={`Delete ${confirmingTemplateDelete.name}`}>
            <div className="stack stack-tight">
              <p className="eyebrow">Prompt Templates</p>
              <h3>Delete {confirmingTemplateDelete.name}?</h3>
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
          </div>
        </div>
      ) : null}
      {seedDialogOpen ? createPortal(
        <div className="dialog-backdrop" role="presentation" onClick={() => setSeedDialogOpen(false)} style={{ zIndex: 200 }}>
          <div className="dialog-card" role="dialog" aria-modal="true" aria-label="Run Pipeline" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420, padding: 20 }}>
            <h3 style={{ margin: "0 0 12px" }}>Run Pipeline</h3>
            <p className="muted small-copy" style={{ marginBottom: 16 }}>Select the model for the pipeline run. It handles analysis, lorebook refresh, and system prompt updates.</p>
            <div className="stack stack-tight">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{ fontSize: 11, color: "var(--text2)", whiteSpace: "nowrap", minWidth: 80 }}>Model:</label>
                <select value={seedDialogCreativeModelId} onChange={(e) => setSeedDialogCreativeModelId(e.target.value)} style={{ fontSize: 11, flex: 1 }}>
                  {availableChatModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" className="ghost-button" onClick={() => setSeedDialogOpen(false)}>Cancel</button>
              <button
                type="button"
                onClick={() => {
                  updateSeedMutation.mutate({ campaignId: session.campaignId!, body: { creativeModelId: seedDialogCreativeModelId } });
                  setSeedDialogOpen(false);
                }}
                disabled={updateSeedMutation.isPending}
                style={{ background: "var(--accent)", color: "#fff", border: "none" }}
              >
                Run Pipeline
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
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
    const next = Math.max(48, Math.min(window.innerHeight * 0.6, startHeight + delta));
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

function mapStoredAttachmentToInput(attachment: ChatMessage["attachments"][number]) {
  return {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    contentMode: attachment.contentMode,
    content: attachment.content,
  };
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

async function readAttachmentFile(file: File) {
  const mimeType = file.type || inferMimeType(file.name);
  if (isTextMimeType(mimeType, file.name)) {
    return {
      filename: file.name,
      mimeType,
      contentMode: "text" as const,
      content: await file.text(),
    };
  }
  const processed = mimeType.startsWith("image/") ? await resizeImageIfNeeded(file) : file;
  return {
    filename: processed.name,
    mimeType: processed.type || mimeType,
    contentMode: "base64" as const,
    content: arrayBufferToBase64(await processed.arrayBuffer()),
  };
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
        <span className="chevron">{open ? "▾" : "▸"}</span>
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

function computeContextMetrics(messages: ChatMessage[], campaign: SessionDetailResponse["campaign"]) {
  let chars = 0;
  let lines = 0;
  if (campaign) {
    chars += (campaign.systemPrompt || "").length;
    lines += countLines(campaign.systemPrompt || "");
  }
  for (const m of messages) {
    chars += m.content.length;
    lines += countLines(m.content);
  }
  return { chars, lines };
}

function countLines(s: string) { return s ? s.split("\n").length : 0; }

function estimateSessionContextTokens(messages: ChatMessage[], campaign: SessionDetailResponse["campaign"], contextBudgetTokens?: number) {
  const syspromptChars = campaign ? campaign.systemPrompt.length + 32 : 0;
  if (!contextBudgetTokens) {
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if ((m as { role: string }).role === "cold-start") continue;
    let msgChars = m.content.length + 24;
    for (const a of m.attachments) msgChars += estimateAttachmentContextChars(a);
    const msgTokens = Math.ceil(msgChars / 4);
    if (msgTokens > remaining) break;
    remaining -= msgTokens;
    tokens += msgTokens;
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

// Fast mode pricing stacks with cache multipliers: cacheRead = fastInput × 0.1,
// cacheWrite5m = fastInput × 1.25, cacheWrite1h = fastInput × 2. Standard rates
// fall back when the message wasn't actually run in fast mode (per server-reported
// usage.speed) or when the model has no fast-mode pricing in catalog.
function getEffectiveRates(message: ChatMessage) {
  if (!message.modelId) return null;
  const model = getChatModel(message.modelId);
  if (!model?.inputCostPerMillionTokens || !model.outputCostPerMillionTokens) return null;
  const useFast = (message as any).fastMode === true
    && model.fastModeInputCostPerMillionTokens != null
    && model.fastModeOutputCostPerMillionTokens != null;
  if (useFast) {
    const fastInput = model.fastModeInputCostPerMillionTokens!;
    return {
      input: fastInput,
      output: model.fastModeOutputCostPerMillionTokens!,
      cacheRead: fastInput * 0.1,
      cacheWrite5m: fastInput * 1.25,
      cacheWrite1h: fastInput * 2,
    };
  }
  // Long-context tier (Gemini 3.1 Pro / 2.5 Pro, grok-4.3): the WHOLE request
  // reprices when prompt-side tokens exceed the threshold; cached tokens count
  // toward it. No overlap with fast mode (tiered models have no fast fields).
  if (model.longContextThresholdTokens != null && message.usage) {
    const promptSide = (message.usage.inputTokens ?? 0)
      + (message.usage.cacheReadTokens ?? 0)
      + (message.usage.cacheWriteTokens ?? 0);
    if (promptSide > model.longContextThresholdTokens) {
      return {
        input: model.longContextInputCostPerMillionTokens ?? model.inputCostPerMillionTokens,
        output: model.longContextOutputCostPerMillionTokens ?? model.outputCostPerMillionTokens,
        cacheRead: model.longContextCacheReadCostPerMillionTokens ?? model.cacheReadCostPerMillionTokens ?? 0,
        cacheWrite5m: model.cacheWrite5mCostPerMillionTokens ?? 0,
        cacheWrite1h: model.cacheWrite1hCostPerMillionTokens ?? 0,
      };
    }
  }
  return {
    input: model.inputCostPerMillionTokens,
    output: model.outputCostPerMillionTokens,
    cacheRead: model.cacheReadCostPerMillionTokens ?? 0,
    cacheWrite5m: model.cacheWrite5mCostPerMillionTokens ?? 0,
    cacheWrite1h: model.cacheWrite1hCostPerMillionTokens ?? 0,
  };
}

function calculateMessageCost(message: ChatMessage, cacheTtl: "off" | "5m" | "1h") {
  if (!message.usage) return null;
  const rates = getEffectiveRates(message);
  if (!rates) return null;
  const inputTokens = message.usage.inputTokens ?? 0;
  const outputTokens = message.usage.outputTokens ?? 0;
  const cacheReadTokens = message.usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = message.usage.cacheWriteTokens ?? 0;
  let total = inputTokens * rates.input + outputTokens * rates.output;
  if (rates.cacheRead) total += cacheReadTokens * rates.cacheRead;
  const writeCost = cacheTtl === "1h" ? rates.cacheWrite1h : rates.cacheWrite5m;
  if (cacheTtl !== "off" && writeCost) total += cacheWriteTokens * writeCost;
  return total / 1_000_000;
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
    const rates = getEffectiveRates(message);
    if (!rates || !rates.cacheRead) continue;
    const cacheRead = message.usage.cacheReadTokens ?? 0;
    if (cacheRead <= 0) continue;
    found = true;
    savings += cacheRead * (rates.input - rates.cacheRead) / 1_000_000;
  }
  return found ? savings : null;
}

type OverheadEntry = { source: string; modelId: string; inputTokens: number; outputTokens: number };

function sumOverheadCost(messages: ChatMessage[], rollingDiffOverhead: OverheadEntry[]): number | null {
  const all: OverheadEntry[] = [...rollingDiffOverhead];
  for (const m of messages) {
    if ((m as any).overhead) all.push(...(m as any).overhead);
  }
  if (!all.length) return null;
  let total = 0;
  for (const entry of all) {
    const model = getChatModel(entry.modelId);
    if (!model?.inputCostPerMillionTokens || !model.outputCostPerMillionTokens) continue;
    total += (entry.inputTokens * model.inputCostPerMillionTokens + entry.outputTokens * model.outputCostPerMillionTokens) / 1_000_000;
  }
  return total || null;
}

function addCosts(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function buildRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function buildChatModelGroups(models: ReturnType<typeof buildAvailableChatModels>) {
  const groups: Array<{ provider: string; label: string; models: Array<ReturnType<typeof buildAvailableChatModels>[number]> }> = [];
  for (const model of models) {
    const existing = groups.find((group) => group.provider === model.provider);
    if (existing) {
      existing.models.push(model);
      continue;
    }
    groups.push({
      provider: model.provider,
      label: "providerLabel" in model && typeof model.providerLabel === "string" ? model.providerLabel : providerLabel(model.provider),
      models: [model],
    });
  }
  return groups;
}

function findChatModel(models: ReturnType<typeof buildAvailableChatModels>, modelId: string) {
  return models.find((model) => model.id === modelId) ?? null;
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

function formatPercent(value: number | null) {
  return value == null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function providerLabel(provider: string) {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "claude-code") return "ClaudeCode Bridge";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "google") return "Google";
  if (provider === "openai") return "OpenAI";
  if (provider === "xai") return "xAI";
  if (provider === "xiaomi") return "Xiaomi (MiMo)";
  if (provider === "zai") return "z.ai";
  return provider;
}

function capitalize(value: string) {
  if (value === "xhigh") return "XHigh";
  return value.charAt(0).toUpperCase() + value.slice(1);
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

type SceneEditPayload = { location?: string; present?: string[]; presentUnaware?: string[]; reason?: string | null; date?: string | null; time?: string | null };

function CharacterAttireChip({ campaignId, name, attireEnabled }: { campaignId: string | null | undefined; name: string; attireEnabled: boolean }) {
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
        const msg = err instanceof Error ? err.message : "Failed to load attire";
        if (msg.includes("404")) {
          setRecord(null);
          setError("No attire recorded yet — will be set on the next assistant turn.");
        } else {
          setError(msg);
        }
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [open, campaignId, name, attireEnabled]);

  const save = async () => {
    if (!campaignId) return;
    setSaving(true);
    try {
      const updated = await updateCharacterAttire(campaignId, name, { attireDescription: draft.trim(), reason: "manual edit" });
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

function CharacterAttireChipList({ campaignId, names, attireEnabled }: { campaignId: string | null | undefined; names: string[]; attireEnabled: boolean }) {
  if (names.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {names.map((n, i) => (
        <span key={n + i}>
          <CharacterAttireChip campaignId={campaignId} name={n} attireEnabled={attireEnabled} />
          {i < names.length - 1 ? <span style={{ color: "var(--muted)" }}>,&nbsp;</span> : null}
        </span>
      ))}
    </span>
  );
}

function SceneDivider({ location, present, presentUnaware, notPresent, reason, date, time, validator, resolution, onResolve, onEditSave, autoRegen, disabled, campaignId, attireEnabled }: {
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
  onEditSave: ((edits: SceneEditPayload) => Promise<void>) | null;
  autoRegen: boolean;
  disabled: boolean;
  campaignId: string | null;
  attireEnabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<"idle" | "manual" | "edit">("idle");
  const [manualPresent, setManualPresent] = useState("");
  const [manualUnaware, setManualUnaware] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flashResolved, setFlashResolved] = useState(false);
  const [editLocation, setEditLocation] = useState("");
  const [editPresent, setEditPresent] = useState("");
  const [editPresentUnaware, setEditPresentUnaware] = useState("");
  const [editReason, setEditReason] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("");
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
    setEditLocation(location);
    setEditPresent(present.join(", "));
    setEditPresentUnaware(presentUnaware.join(", "));
    setEditReason(reason ?? "");
    setEditDate(date ?? "");
    setEditTime(time ?? "");
    setExpanded(true);
  };

  const saveEdit = async () => {
    if (!onEditSave || submitting) return;
    setSubmitting(true);
    try {
      const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      await onEditSave({
        location: editLocation.trim() !== location ? editLocation.trim() : undefined,
        present: editPresent !== present.join(", ") ? splitList(editPresent) : undefined,
        presentUnaware: editPresentUnaware !== presentUnaware.join(", ") ? splitList(editPresentUnaware) : undefined,
        reason: editReason !== (reason ?? "") ? (editReason.trim() || null) : undefined,
        date: editDate !== (date ?? "") ? (editDate.trim() || null) : undefined,
        time: editTime !== (time ?? "") ? (editTime.trim() || null) : undefined,
      });
      setMode("idle");
    } finally {
      setSubmitting(false);
    }
  };

  const dateTimeChip = date || time ? ` · ${[date, time].filter(Boolean).join(" ")}` : "";
  const headerLabel = disagreement
    ? `— ${location} · ⚠ presence disagreement${dateTimeChip} —`
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
            <button type="button" className="scene-divider-edit-btn" onClick={openEdit} disabled={disabled} title="Edit scene metadata" aria-label="Edit scene metadata">✎</button>
          ) : null}
          {(date || time) ? <div className="scene-divider-when"><strong>When:</strong> {[date, time].filter(Boolean).join(" — ")}</div> : null}
          <div><strong>Present:</strong> <CharacterAttireChipList campaignId={campaignId} names={present} attireEnabled={attireEnabled} /></div>
          {presentUnaware.length > 0 ? <div><strong>Present (unaware):</strong> <CharacterAttireChipList campaignId={campaignId} names={presentUnaware} attireEnabled={attireEnabled} /></div> : null}
          {notPresent.length > 0 ? <div><strong>Not present:</strong> {notPresent.join(", ")}</div> : null}
          {reason ? <div className="scene-divider-reason">{reason}</div> : null}
          {mode === "edit" ? (
            <div className="scene-divider-edit">
              <div className="scene-divider-edit-head"><strong>Edit scene metadata</strong></div>
              <label className="scene-divider-edit-row"><span className="lbl">Location</span><input type="text" value={editLocation} onChange={(e) => setEditLocation(e.target.value)} disabled={submitting || disabled} /></label>
              <label className="scene-divider-edit-row"><span className="lbl">Date</span><input type="text" value={editDate} onChange={(e) => setEditDate(e.target.value)} placeholder="e.g. Monday, September 28, 1998" disabled={submitting || disabled} /></label>
              <label className="scene-divider-edit-row"><span className="lbl">Time</span><input type="text" value={editTime} onChange={(e) => setEditTime(e.target.value)} placeholder="e.g. 10:47 AM, late evening" disabled={submitting || disabled} /></label>
              <label className="scene-divider-edit-row"><span className="lbl">Present (comma-separated)</span><input type="text" value={editPresent} onChange={(e) => setEditPresent(e.target.value)} disabled={submitting || disabled} /></label>
              <label className="scene-divider-edit-row"><span className="lbl">Present unaware (comma-separated)</span><input type="text" value={editPresentUnaware} onChange={(e) => setEditPresentUnaware(e.target.value)} disabled={submitting || disabled} /></label>
              <label className="scene-divider-edit-row"><span className="lbl">Reason</span><input type="text" value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="optional — what changed" disabled={submitting || disabled} /></label>
              <div className="scene-divider-actions">
                <button type="button" className="ghost-button" onClick={() => setMode("idle")} disabled={submitting || disabled}>Cancel</button>
                <button type="button" className="primary-button" onClick={saveEdit} disabled={submitting || disabled}>{submitting ? "Saving…" : "Save"}</button>
              </div>
            </div>
          ) : null}
          {validator && validator.agreement === "disagree" ? (
            <div className={`scene-divider-validator${flashResolved ? " scene-divider-validator-flash" : ""}`}>
              <div className="scene-divider-validator-head">
                <strong>{resolution ? "Resolution applied" : "Validator disagrees"}</strong>
                <span className="scene-divider-validator-model">{validator.modelId}</span>
              </div>
              {resolution ? (
                <div className="scene-divider-resolution-banner">
                  {resolution === "main"
                    ? "✓ Kept Main LLM's scene metadata. No regen."
                    : resolution === "validator"
                      ? "✓ Applied Validator's lists to this message's scene metadata."
                      : "✓ Applied your manual correction to this message's scene metadata."}
                </div>
              ) : null}
              <div className="scene-divider-validator-cols">
                <div className={resolution === "main" ? "scene-divider-validator-col-chosen" : resolution ? "scene-divider-validator-col-rejected" : ""}>
                  <div className="scene-divider-validator-col-head">Main {resolution === "main" ? "✓" : ""}</div>
                  <div><span className="lbl">Present:</span> {validator.main.present.join(", ") || "—"}</div>
                  {validator.main.presentUnaware.length ? <div><span className="lbl">Unaware:</span> {validator.main.presentUnaware.join(", ")}</div> : null}
                </div>
                <div className={resolution === "validator" ? "scene-divider-validator-col-chosen" : resolution ? "scene-divider-validator-col-rejected" : ""}>
                  <div className="scene-divider-validator-col-head">Validator {resolution === "validator" ? "✓" : ""}</div>
                  <div><span className="lbl">Present:</span> {validator.validator.present.join(", ") || "—"}</div>
                  {validator.validator.presentUnaware.length ? <div><span className="lbl">Unaware:</span> {validator.validator.presentUnaware.join(", ")}</div> : null}
                </div>
              </div>
              {resolution === "user" ? (
                <div className="scene-divider-validator-applied">
                  <div className="scene-divider-validator-col-head">Applied (user) ✓</div>
                  <div><span className="lbl">Present:</span> {present.join(", ") || "—"}</div>
                  {presentUnaware.length ? <div><span className="lbl">Unaware:</span> {presentUnaware.join(", ")}</div> : null}
                </div>
              ) : null}
              {validator.rationale ? <div className="scene-divider-validator-rationale">{validator.rationale}</div> : null}
              {resolution === null && onResolve ? (
                mode === "manual" ? (
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
                        {submitting ? "Saving…" : autoRegen ? "Save & regenerate" : "Save correction"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="scene-divider-actions">
                    <button type="button" className="ghost-button" onClick={() => submit("main")} disabled={submitting || disabled}>Agree with Main LLM</button>
                    <button type="button" className="primary-button" onClick={() => submit("validator")} disabled={submitting || disabled}>
                      {autoRegen ? "Agree with Validator & regenerate" : "Agree with Validator"}
                    </button>
                    <button type="button" className="ghost-button" onClick={openManual} disabled={submitting || disabled}>Both wrong</button>
                  </div>
                )
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
