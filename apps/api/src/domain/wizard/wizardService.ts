import type {
  ActiveWizardRunsResponse,
  ApproveWizardRunResponse,
  ApproveWizardRunRequest,
  CancelWizardRunResponse,
  EnqueueWizardRunRequest,
  RetryWizardRunResponse,
  UpdateWizardTemplatesRequest,
  WizardRunsResponse,
  WizardTemplatesResponse,
} from "@tracyhill-rp/contracts";
import { getDefaultChatModelId } from "@tracyhill-rp/model-catalog";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { CampaignRepository } from "../campaigns/campaignRepository";
import type { CharacterAttireRepository } from "../chat/characterAttireRepository";
import { MessageAttachmentRepository } from "../chat/messageAttachmentRepository";
import { MessageRepository } from "../chat/messageRepository";
import { PendingAssistantMessageRepository } from "../chat/pendingAssistantMessageRepository";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { UserRepository } from "../users/userRepository";
import { CustomEndpointRepository } from "../providerKeys/customEndpointRepository";
import { resolveChatModelConfig } from "../providerKeys/chatModelConfig";
import { FolderRepository } from "../workspace/folderRepository";
import { SessionRepository } from "../workspace/sessionRepository";
import { UserPreferencesRepository } from "../workspace/userPreferencesRepository";
import { createDefaultWizardRunDetails, parseWizardRunDetails, WizardRunRepository, synthesizeWizardTranscript, type LorebookCorpusEntry } from "./wizardRunRepository";
import { LorebookRepository } from "../context/lorebookRepository";
import { EmbeddingService } from "../context/embeddingService";
import { estimateTokens } from "../context/lorebookTokenEstimator";
import { buildWizardTranscript, extractWizardCampaignName, stripWizardReadyMarker } from "./wizardSession";
import { WizardTemplateRepository } from "./wizardTemplateRepository";

export type WizardKick = {
  kick: () => void;
};

export type WizardControl = WizardKick & {
  cancelRun?: (runId: string) => boolean;
};

export class WizardService {
  constructor(
    private readonly users: UserRepository,
    private readonly campaigns: CampaignRepository,
    private readonly sessions: SessionRepository,
    private readonly preferences: UserPreferencesRepository,
    private readonly folders: FolderRepository,
    private readonly messages: MessageRepository,
    private readonly attachments: MessageAttachmentRepository,
    private readonly pending: PendingAssistantMessageRepository,
    private readonly generatedImages: GeneratedImageRepository,
    private readonly imageStore: ImageStore,
    private readonly templates: WizardTemplateRepository,
    private readonly runs: WizardRunRepository,
    private readonly customEndpoints: CustomEndpointRepository,
    private readonly control: WizardControl | null = null,
    private readonly lorebook: LorebookRepository | null = null,
    private readonly attireRepo: CharacterAttireRepository | null = null,
    private readonly embeddingService: EmbeddingService | null = null,
  ) {}

  private resolveWizardEmbedModel(_userId: string, _entries: Array<{ id: string }>): string {
    // Wizard-created campaigns start with default contextDefaults; embed under
    // the default model (campaign-level switches re-embed via workspace flow).
    return "openai:text-embedding-3-large";
  }

  getTemplates(userId: string): WizardTemplatesResponse {
    this.requireUser(userId);
    const row = this.templates.ensureForUser(userId, new Date().toISOString());
    return {
      templates: {
        exampleSystemPrompt: row.exampleSystemPrompt,
        updatedAt: row.updatedAt,
      },
    };
  }

  updateTemplates(userId: string, input: UpdateWizardTemplatesRequest): WizardTemplatesResponse {
    this.requireUser(userId);
    const now = new Date().toISOString();
    this.templates.ensureForUser(userId, now);
    this.templates.updateForUser(userId, {
      exampleSystemPrompt: input.exampleSystemPrompt.trim(),
      updatedAt: now,
    });
    return this.getTemplates(userId);
  }

  listRuns(userId: string): WizardRunsResponse {
    this.requireUser(userId);
    return {
      runs: this.runs.listForUser(userId).map((run) => this.serializeRun(run)),
    };
  }

  listActiveRuns(userId: string): ActiveWizardRunsResponse {
    this.requireUser(userId);
    return {
      runs: this.runs.listActiveForUser(userId).map((run) => this.serializeRun(run)),
    };
  }

  enqueueRun(userId: string, input: EnqueueWizardRunRequest): WizardRunsResponse {
    this.requireUser(userId);
    const modelId = this.requireWizardModel(userId, input.modelId);
    const now = new Date().toISOString();
    const sourceSession = input.wizardSessionId ? this.sessions.findActiveById(userId, input.wizardSessionId) : null;
    if (input.wizardSessionId && (!sourceSession || sourceSession.sessionType !== "wizard")) throw new HttpError(400, "wizardSessionId must reference an active wizard session");
    const sessionMessages = sourceSession ? this.messages.listForSession(userId, sourceSession.id) : [];
    const sourceTranscript = sourceSession ? buildWizardTranscript(sessionMessages.map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }))) : "";
    const brief = sourceSession
      ? stripWizardReadyMarker([...sessionMessages].reverse().find((message) => message.role === "assistant")?.content ?? input.brief.trim())
      : input.brief.trim();
    const campaignName = extractWizardCampaignName(sourceTranscript)
      ?? extractWizardCampaignName(brief)
      ?? input.campaignName.trim();
    if (!campaignName) throw new HttpError(400, "wizard campaign name could not be determined");
    const wizardTranscript = synthesizeWizardTranscript(campaignName, brief, sourceTranscript || input.wizardTranscript);
    const details = createDefaultWizardRunDetails(campaignName, brief, wizardTranscript);
    details.review.wizardSessionId = sourceSession?.id ?? null;
    this.runs.createRun({
      id: createId(),
      userId,
      modelId,
      status: "queued",
      summary: null,
      error: null,
      detailsJson: JSON.stringify(details),
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    });
    this.control?.kick();
    return this.listRuns(userId);
  }

  retryRun(userId: string, runId: string): RetryWizardRunResponse {
    this.requireUser(userId);
    const current = this.runs.findById(userId, runId);
    if (!current || current.userId !== userId) throw new HttpError(404, "wizard run not found");
    const details = parseWizardRunDetails(current.detailsJson);
    return this.enqueueRetry(userId, current.modelId, details.review.campaignName, details.review.brief, details.review.wizardTranscript, current.id);
  }

  cancelRun(userId: string, runId: string): CancelWizardRunResponse {
    this.requireUser(userId);
    const run = this.runs.findById(userId, runId);
    if (!run || run.userId !== userId) throw new HttpError(404, "wizard run not found");
    if (run.approvedAt) throw new HttpError(400, "approved wizard runs cannot be canceled");
    if (run.status === "queued") {
      this.runs.markCanceled(run.id, new Date().toISOString(), "wizard run canceled", run.detailsJson);
      return this.listRuns(userId);
    }
    if (run.status === "running") {
      const canceled = this.control?.cancelRun?.(run.id) ?? false;
      if (!canceled) this.runs.markCanceled(run.id, new Date().toISOString(), "wizard run canceled", run.detailsJson);
      return this.listRuns(userId);
    }
    if (run.status === "canceled") return this.listRuns(userId);
    throw new HttpError(400, "only queued or running wizard runs can be canceled");
  }

  approveRun(userId: string, runId: string, input: ApproveWizardRunRequest = {}): ApproveWizardRunResponse {
    // Collect created corpus entry ids so they can be embedded post-commit —
    // wizard-approved campaigns previously had ZERO semantic retrieval until
    // the consolidation worker's bootstrap backfill (every 10th rolling diff).
    const createdCorpus: Array<{ id: string; userId: string; content: string }> = [];
    const rememberCorpusId = (id: string, content: string) => { createdCorpus.push({ id, userId, content }); return id; };
    this.requireUser(userId);
    const run = this.runs.findById(userId, runId);
    if (!run || run.userId !== userId) throw new HttpError(404, "wizard run not found");
    if (run.status !== "completed") throw new HttpError(400, "wizard run is not ready for approval");
    if (run.approvedAt) return this.listRuns(userId);
    const details = parseWizardRunDetails(run.detailsJson);
    if (input.campaignName !== undefined) details.review.campaignName = input.campaignName.trim();
    if (input.systemPromptDraft !== undefined) details.review.systemPromptDraft = input.systemPromptDraft.trim();
    const campaignName = details.review.campaignName.trim();
    const systemPrompt = details.review.systemPromptDraft?.trim();
    const lorebookCorpus = details.review.lorebookCorpusDraft ?? [];

    if (!campaignName || !systemPrompt) throw new HttpError(400, "wizard run has incomplete review output");

    const now = new Date().toISOString();
    const campaignId = createId();
    const folderId = createId();
    const sessionId = createId();
    const approvalBody = () => {
      this.folders.createFolder({
        id: folderId,
        userId,
        name: campaignName,
        position: this.folders.nextPosition(userId),
        collapsed: 0,
        createdAt: now,
        updatedAt: now,
      });
      this.campaigns.createCampaign({
        id: campaignId,
        userId,
        name: campaignName,
        folderId,
        pipelineModelId: this.requireWizardModel(userId, run.modelId),
        systemPrompt,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      if (this.attireRepo) {
        for (const entry of lorebookCorpus) {
          if (entry.tag !== "characters" || !entry.startingAttire || !entry.startingAttire.trim()) continue;
          this.attireRepo.upsert({
            campaignId,
            characterName: entry.name,
            attireDescription: entry.startingAttire.trim(),
            turn: 0,
            messageId: null,
            source: "wizard_seed",
            previousAttire: null,
            reason: "wizard seed",
            recordHistory: true,
          });
        }
      }
      if (this.lorebook && lorebookCorpus.length > 0) {
        this.lorebook.createMany(lorebookCorpus.map(entry => ({
          id: rememberCorpusId(createId(), entry.content),
          userId,
          campaignId,
          name: entry.name,
          tag: entry.tag,
          content: entry.content,
          comment: null,
          keys: JSON.stringify(entry.keys),
          keysSecondary: JSON.stringify(entry.keysSecondary ?? []),
          selectiveLogic: "and_any",
          scanDepth: entry.scanDepth ?? 4,
          position: entry.position ?? "before_main",
          insertionOrder: entry.insertionOrder ?? 100,
          probability: 100,
          isConstant: entry.isConstant ? 1 : 0,
          isEnabled: 1,
          sticky: 0,
          cooldown: 0,
          delay: 0,
          excludeRecursion: 0,
          preventRecursion: 0,
          delayUntilRecursion: 0,
          tokensEstimate: estimateTokens(entry.content),
          matchOptionsJson: null,
          legacySource: null,
          createdAt: now,
          updatedAt: now,
        })));
      }
      this.sessions.createSession({
        id: sessionId,
        userId,
        sessionType: "standard",
        campaignId,
        folderId,
        name: `${campaignName} Part 1`,
        modelId: getDefaultChatModelId(),
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      });
      this.preferences.ensureForUser(userId, now);
      const wizardSessionId = details.review.wizardSessionId ?? this.sessions.findActiveWizardForUser(userId)?.id ?? null;
      if (wizardSessionId) this.destroyWizardSession(userId, wizardSessionId);
      this.preferences.updateForUser(userId, { activeSessionId: sessionId, updatedAt: now });
      details.review.approvedCampaignId = campaignId;
      details.review.approvedSessionId = sessionId;
      const summary = `Wizard campaign ${campaignName} created with Part 1 ready.`;
      this.runs.updateRun(runId, {
        summary,
        approvedAt: now,
        detailsJson: JSON.stringify(details),
        updatedAt: now,
      });
    };
    if (this.lorebook) this.lorebook.transact(approvalBody);
    else this.folders.transact(approvalBody);
    if (this.embeddingService && createdCorpus.length > 0) {
      const model = this.resolveWizardEmbedModel(userId, createdCorpus);
      this.embeddingService.indexEntries(createdCorpus, model).catch(() => {
        // embedding service records the system event; approval itself succeeded
      });
    }
    return this.listRuns(userId);
  }

  private enqueueRetry(userId: string, modelId: string, campaignName: string, brief: string, wizardTranscript: string, retriedFromRunId: string) {
    const now = new Date().toISOString();
    const details = createDefaultWizardRunDetails(campaignName, brief, wizardTranscript);
    const currentRun = this.runs.findById(userId, retriedFromRunId);
    if (currentRun) {
      const currentDetails = parseWizardRunDetails(currentRun.detailsJson);
      details.review.wizardSessionId = currentDetails.review.wizardSessionId;
    }
    details.review.retriedFromRunId = retriedFromRunId;
    this.runs.createRun({
      id: createId(),
      userId,
      modelId,
      status: "queued",
      summary: null,
      error: null,
      detailsJson: JSON.stringify(details),
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    });
    this.control?.kick();
    return this.listRuns(userId);
  }

  private serializeRun(run: ReturnType<WizardRunRepository["listForUser"]>[number]) {
    const details = parseWizardRunDetails(run.detailsJson);
    return {
      id: run.id,
      modelId: run.modelId,
      status: run.status as "queued" | "running" | "completed" | "failed" | "canceled",
      summary: run.summary ?? null,
      error: run.error ?? null,
      steps: details.steps,
      review: details.review,
      requestedAt: run.requestedAt,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      approvedAt: run.approvedAt ?? null,
      updatedAt: run.updatedAt,
    };
  }

  private requireUser(userId: string) {
    const user = this.users.findById(userId);
    if (!user) throw new HttpError(401, "authentication required");
    return user;
  }

  private requireWizardModel(userId: string, modelId: string | undefined) {
    const resolved = modelId?.trim() || getDefaultChatModelId();
    if (!resolveChatModelConfig(this.customEndpoints, userId, resolved)) throw new HttpError(400, "wizard model not found");
    return resolved;
  }

  private destroyWizardSession(userId: string, sessionId: string) {
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
