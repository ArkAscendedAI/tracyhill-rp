import type {
  ActiveWizardRunsResponse,
  ApproveWizardRunResponse,
  ApproveWizardRunRequest,
  CancelWizardRunResponse,
  DismissWizardRunResponse,
  EnqueueWizardRunRequest,
  ImportWizardRunResponse,
  RetryWizardRunResponse,
  UpdateWizardTemplatesRequest,
  WizardRunsResponse,
  WizardTemplatesResponse,
} from "@tracyhill-rp/contracts";
import { WIZARD_PLAYER_CHARACTER_FALLBACK, clampDriveSeedText, driveSheetSchema, findNonCanonicalStrippedLines, lorebookCorpusActivationSchema, normalizeCorpusRetrievalFields, normalizeDriveSeedList, normalizeWizardCorpusName, stampCanonicalPcProtectionBlock, type LorebookCorpusOrigin } from "@tracyhill-rp/contracts";
import { getDefaultChatModelId, DEFAULT_EMBEDDING_MODEL } from "@tracyhill-rp/model-catalog";

import { createId } from "../../lib/ids";
import { HttpError } from "../../lib/httpError";
import { CampaignRepository } from "../campaigns/campaignRepository";
import type { CharacterAttireRepository } from "../chat/characterAttireRepository";
import type { CharacterDrivesRepository } from "../chat/characterDrivesRepository";
import type { AdversarialWorldRepository } from "../world/adversarialWorldRepository";
import { MessageAttachmentRepository } from "../chat/messageAttachmentRepository";
import { MessageRepository } from "../chat/messageRepository";
import { PendingAssistantMessageRepository } from "../chat/pendingAssistantMessageRepository";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { UserRepository } from "../users/userRepository";
import { CustomEndpointRepository } from "../providerKeys/customEndpointRepository";
import type { StartingModels } from "../providerKeys/defaultModels";
import { resolveChatModelConfig } from "../providerKeys/chatModelConfig";
import { FolderRepository } from "../workspace/folderRepository";
import { SessionRepository } from "../workspace/sessionRepository";
import { UserPreferencesRepository } from "../workspace/userPreferencesRepository";
import { getSessionRuntimeDefaults } from "../workspace/workspaceService";
import { createDefaultWizardRunDetails, parseWizardRunDetails, WizardRunRepository, synthesizeWizardTranscript } from "./wizardRunRepository";
import { LorebookRepository } from "../context/lorebookRepository";
import { EmbeddingService } from "../context/embeddingService";
import { estimateTokens } from "../context/lorebookTokenEstimator";
import { sanitizeCreateTag } from "../context/lorebookTags";
import { normalizeKeyList } from "../context/lorebookKeys";
import { buildWizardTranscript, extractWizardCampaignName, stripWizardReadyMarker } from "./wizardSession";
import { prepareSillyTavernImport } from "./sillyTavernImport";
import { WizardTemplateRepository } from "./wizardTemplateRepository";

/** The Lorebook panel's record of an imported entry: its title in the file and what the importer added to it. */
export function importedEntryComment(origin: LorebookCorpusOrigin): string {
  const title = origin.source?.trim() ? ` ("${origin.source.trim().slice(0, 200)}")` : "";
  const added = origin.added?.filter((section) => section.trim()) ?? [];
  return `Imported from a SillyTavern lorebook${title}.${added.length > 0 ? ` The importer added: ${added.join(", ")}.` : ""}`;
}

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
    private readonly drivesRepo: CharacterDrivesRepository | null = null,
    private readonly adversarialWorld: AdversarialWorldRepository | null = null,
    // The server-wide starting values for a new session (Admin: Server settings → New sessions, 2026-10-02).
    private readonly newSessionOverrides: () => Record<string, unknown> = () => ({}),
    // The models Part 1 starts with for this account (defaultModels.ts). Absent in unit tests: the shipped defaults.
    private readonly startingModels: StartingModels | null = null,
  ) {}

  private resolveWizardEmbedModel(part1EmbeddingModel: string | undefined): string {
    // The embedding dial is per-SESSION (0077 retired the campaign tier). The corpus is embedded under the model the
    // Part-1 session starts on: the default dial, or the one the account can reach when it cannot reach the default;
    // pointing the dial elsewhere later re-embeds through the workspace flow.
    return part1EmbeddingModel ?? DEFAULT_EMBEDDING_MODEL;
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
    // H: mutual exclusion — only one wizard run may be queued/running per user.
    if (this.runs.hasQueuedOrRunning(userId)) throw new HttpError(409, "a wizard run is already active");
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
    const campaignName = extractWizardCampaignName(brief)
      ?? (input.campaignName.trim() || extractWizardCampaignName(sourceTranscript));
    if (!campaignName) throw new HttpError(400, "wizard campaign name could not be determined");
    const wizardTranscript = synthesizeWizardTranscript(campaignName, brief, sourceTranscript || input.wizardTranscript);
    const details = createDefaultWizardRunDetails(campaignName, brief, wizardTranscript);
    details.review.wizardSessionId = sourceSession?.id ?? null;
    // The single-flight guard is re-checked inside the insert's transaction so
    // the check-then-act window cannot admit a second run.
    this.runs.transact(() => {
      if (this.runs.hasQueuedOrRunning(userId)) throw new HttpError(409, "a wizard run is already active");
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
    });
    this.control?.kick();
    return this.listRuns(userId);
  }

  /**
   * A SillyTavern lorebook as the source of a new campaign: the file's entries are
   * normalized here and the worker converts them; the owner reviews and approves the result like any wizard run.
   */
  importRun(userId: string, input: {
    fileName: string;
    campaignName: string;
    playerCharacterName: string;
    charName: string;
    notes: string;
    modelId?: string;
    addCharacterSections: boolean;
    lorebook: unknown;
  }): ImportWizardRunResponse {
    this.requireUser(userId);
    if (this.runs.hasQueuedOrRunning(userId)) throw new HttpError(409, "a wizard run is already active");
    const modelId = this.requireWizardModel(userId, input.modelId);
    const campaignName = input.campaignName.trim();
    const playerCharacterName = input.playerCharacterName.trim();
    const prepared = prepareSillyTavernImport(input.lorebook, { playerCharacterName, charName: input.charName.trim() });
    if (prepared.entries.length === 0) throw new HttpError(400, prepared.leftOut[0] ?? "The file has no lorebook entries to import.");
    const fileName = input.fileName.trim() || "lorebook.json";
    const notes = input.notes.trim();
    const transcript = [
      "### User",
      "",
      `Campaign Name: ${campaignName}`,
      "",
      `Imported from the SillyTavern lorebook ${fileName}: ${prepared.entries.length} of ${prepared.total} entries. ${playerCharacterName} is the player character.`,
      ...(notes ? ["", notes] : []),
    ].join("\n");
    const details = createDefaultWizardRunDetails(campaignName, notes, transcript);
    details.review.playerCharacterName = playerCharacterName;
    details.review.importSummary = {
      format: "sillytavern",
      fileName,
      entries: prepared.total,
      imported: prepared.entries.length,
      leftOut: prepared.leftOut,
      notes,
    };
    details.source = {
      format: "sillytavern",
      fileName,
      charName: input.charName.trim(),
      notes,
      addCharacterSections: input.addCharacterSections,
      entries: prepared.entries,
      notices: prepared.notices,
    };
    const now = new Date().toISOString();
    const runId = createId();
    this.runs.transact(() => {
      if (this.runs.hasQueuedOrRunning(userId)) throw new HttpError(409, "a wizard run is already active");
      this.runs.createRun({
        id: runId,
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
    });
    this.control?.kick();
    return { ...this.listRuns(userId), runId };
  }

  retryRun(userId: string, runId: string): RetryWizardRunResponse {
    this.requireUser(userId);
    // H: mutual exclusion — refuse a retry while another run is in flight.
    if (this.runs.hasQueuedOrRunning(userId)) throw new HttpError(409, "a wizard run is already active");
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

  dismissRun(userId: string, runId: string): DismissWizardRunResponse {
    this.requireUser(userId);
    const run = this.runs.findById(userId, runId);
    if (!run || run.userId !== userId) throw new HttpError(404, "wizard run not found");
    // An approved run is the campaign's provenance record and stays; a
    // queued/running run has Cancel. Everything terminal and unapproved —
    // failed, canceled, or a completed run the owner decided not to use — can
    // be cleared from the activity list. The wizard SESSION (the interview)
    // is untouched: it is only destroyed by approval, so a dismissed run's
    // conversation remains recoverable from the session rail.
    if (run.approvedAt) throw new HttpError(400, "approved wizard runs cannot be dismissed");
    if (run.status === "queued" || run.status === "running") throw new HttpError(400, "cancel the wizard run before dismissing it");
    this.runs.deleteRun(run.id);
    return this.listRuns(userId);
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
    // The generated name is fixed at generation and Section A is read-only in
    // the review, so a mis-extracted name ("Corin Vale" for a character the
    // owner calls "Corin", or the placeholder when the marker line was missing)
    // could only be approved as-is or regenerated. An explicit name on the
    // request re-stamps Section A with it.
    const generatedName = details.review.playerCharacterName;
    const playerCharacterName = input.playerCharacterName?.trim() || generatedName;
    details.review.playerCharacterName = playerCharacterName;
    const campaignName = details.review.campaignName.trim();
    const systemPromptDraft = details.review.systemPromptDraft?.trim();
    const lorebookCorpus = details.review.lorebookCorpusDraft ?? [];

    if (!campaignName || !systemPromptDraft) throw new HttpError(400, "wizard run has incomplete review output");
    // One lorebook row per entry name. The worker and the
    // staging tool keep one entry per name now; a run frozen before that could
    // still carry a repeat, and approval would insert both rows while the later
    // entry's attire/drive seeds silently overwrote the first's. Refuse loudly —
    // the corpus is not editable at review, so the owner regenerates.
    const seenNames = new Set<string>();
    for (const entry of lorebookCorpus) {
      const key = normalizeWizardCorpusName(entry.name);
      if (seenNames.has(key)) throw new HttpError(400, `the generated corpus names "${entry.name}" more than once; regenerate the run (the wizard now keeps one entry per name)`);
      seenNames.add(key);
    }
    // Approval may contain owner edits from the review textarea. Re-stamp the
    // immutable Section A so edits cannot accidentally duplicate, alter, or
    // remove the shared player/world authorship contract — and REFUSE when the
    // re-stamp would drop text that is not that block (an edited Section A, or
    // owner prose left under it without a heading). The campaign is created
    // from this prompt with no prior version to restore, so a silent loss here
    // is unrecoverable. A line that is canonical
    // for EITHER the generated name or a corrected one is the block being
    // replaced, not owner text.
    const droppedForNew = findNonCanonicalStrippedLines(systemPromptDraft, playerCharacterName);
    const droppedForOld = playerCharacterName === generatedName ? droppedForNew : findNonCanonicalStrippedLines(systemPromptDraft, generatedName);
    const dropped = droppedForNew.filter((line) => droppedForOld.includes(line));
    if (dropped.length > 0) {
      throw new HttpError(400, `Section A is canonical and re-stamped at approval; the edited draft would lose text under it: "${dropped[0]!.slice(0, 120)}". Keep Section A as generated and put your text under its own "## " heading.`);
    }
    const systemPrompt = stampCanonicalPcProtectionBlock(systemPromptDraft, playerCharacterName);
    details.review.systemPromptDraft = systemPrompt;

    const now = new Date().toISOString();
    const campaignId = createId();
    const folderId = createId();
    const sessionId = createId();
    // Part 1's models: Claude Opus 4.6 when this account can use it, otherwise a model it can use (defaultModels.ts).
    const starting = this.startingModels ? this.startingModels(userId) : null;
    // Image FILES of the destroyed wizard session are collected here and removed
    // only after the transaction commits.
    let orphanedImages: Array<{ id: string; mimeType: string }> = [];
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
      if (this.drivesRepo) {
        for (const entry of lorebookCorpus) {
          const seed = entry.startingDrives;
          const scheme = entry.startingSchemes?.[0] ?? null;
          if (entry.tag !== "characters" || (!seed && !scheme)) continue;
          const wants = (seed?.wants ?? []).filter((w) => w.trim());
          const goals = (seed?.goals ?? []).filter((g) => g.trim());
          const structural = (seed?.redLines?.length ?? 0) + (seed?.leverage?.length ?? 0) + (seed?.concealment?.length ?? 0);
          if (!scheme && wants.length === 0 && goals.length === 0 && structural === 0 && !seed?.offpageProject) continue;
          this.drivesRepo.upsert({
            campaignId, characterName: entry.name,
            // Seed strings are normalized to the schema caps rather than parsed
            // raw — a completed run is frozen, so one over-cap generated string
            // would otherwise fail its approval forever (2026-08-09: a 310-char
            // red line 500'd one campaign's approval). New runs arrive pre-normalized
            // by the worker; this covers frozen and legacy runs.
            sheet: driveSheetSchema.parse({
              wants: wants.slice(0, 5).map((text, i) => ({ id: `w${i + 1}`, text: clampDriveSeedText(text, 400), pressure: 0, sinceTurn: null })),
              goals: goals.slice(0, 3).map((text, i) => ({ id: `g${i + 1}`, text: clampDriveSeedText(text, 400), status: "active" })),
              redLines: normalizeDriveSeedList(seed?.redLines, 300, 6),
              leverage: normalizeDriveSeedList(seed?.leverage, 300, 6),
              concealment: (seed?.concealment ?? []).filter((c) => c.secret?.trim() && c.behavior?.trim()).slice(0, 4)
                .map((c) => ({ secret: clampDriveSeedText(c.secret, 300), behavior: clampDriveSeedText(c.behavior, 400) })),
              offpageProject: seed?.offpageProject ? clampDriveSeedText(seed.offpageProject, 600) : null,
              dispositions: seed?.dispositions
                ? Object.fromEntries(Object.entries(seed.dispositions).slice(0, 6).map(([key, value]) => [key, clampDriveSeedText(String(value), 400)]))
                : {},
            }),
            sealed: Boolean(scheme),
            scheme,
            turn: 0,
            messageId: null,
            source: scheme ? "scheme_seed" : "wizard",
            reason: scheme ? "wizard antagonist scheme seed" : "wizard seed",
            recordHistory: true,
          });
          // Phase 7: seed the scheme's clock at creation so a front exists from
          // turn 1 rather than waiting for the first world tick to notice. Same
          // reasoning as seeding drive sheets here — a generated corpus is not
          // reversible, and a campaign whose antagonist has no front until someone
          // remembers to tick is a campaign where the world does not move on its own.
          if (scheme && this.adversarialWorld) {
            const step = scheme.steps[0];
            this.adversarialWorld.createClock({
              campaignId,
              name: `${entry.name} — ${scheme.targetCitation}`.slice(0, 200),
              impulse: step?.text?.trim() || `advance the scheme against ${scheme.targetCitation}`,
              total: Math.max(2, Math.min(12, scheme.cadence || 6)),
              ownerCharacter: entry.name,
            });
          }
        }
      }
      if (this.lorebook && lorebookCorpus.length > 0) {
        this.lorebook.createMany(lorebookCorpus.map(entry => {
          // The worker validates these at generation; frozen runs
          // from before that, and staged rows, take the same contract here.
          const retrieval = normalizeCorpusRetrievalFields(entry);
          // Tags and keys take the rules every machine CREATE path shares (since 2026-09-29):
          // the worker aligns new runs, but runs generated before that and
          // hand-staged rows reach approval raw — a reserved "threads"/"archived" tag, blank keys
          // (a blank key matched nearly every turn) or more than the 100-key cap. An entry left
          // with no usable key is keyed on its own name, as the worker does for a missing list.
          const keys = normalizeKeyList(entry.keys).keys;
          // An imported entry keeps how it fired in SillyTavern; a wizard-written one,
          // or a malformed setting, takes the native defaults.
          const parsedActivation = entry.activation ? lorebookCorpusActivationSchema.safeParse(entry.activation) : null;
          const activation = parsedActivation?.success ? parsedActivation.data : null;
          const matchOptions: Record<string, boolean> = {};
          if (activation?.caseSensitive) matchOptions.caseSensitive = true;
          if (activation?.matchWholeWords !== undefined) matchOptions.matchWholeWords = activation.matchWholeWords;
          const imported = entry.origin?.kind === "imported";
          return {
          id: rememberCorpusId(createId(), entry.content),
          userId,
          campaignId,
          name: entry.name,
          tag: sanitizeCreateTag(entry.tag).tag,
          content: entry.content,
          comment: imported ? importedEntryComment(entry.origin!) : null,
          keys: JSON.stringify(keys.length > 0 ? keys : [entry.name]),
          keysSecondary: JSON.stringify(normalizeKeyList(entry.keysSecondary ?? []).keys),
          selectiveLogic: activation?.selectiveLogic ?? "and_any",
          scanDepth: retrieval.scanDepth,
          position: retrieval.position,
          insertionOrder: retrieval.insertionOrder,
          probability: activation?.probability ?? 100,
          isConstant: entry.isConstant ? 1 : 0,
          isEnabled: activation?.enabled === false ? 0 : 1,
          sticky: activation?.sticky ?? 0,
          cooldown: activation?.cooldown ?? 0,
          delay: activation?.delay ?? 0,
          excludeRecursion: activation?.excludeRecursion ? 1 : 0,
          preventRecursion: activation?.preventRecursion ? 1 : 0,
          delayUntilRecursion: activation?.delayUntilRecursion ? 1 : 0,
          tokensEstimate: estimateTokens(entry.content),
          matchOptionsJson: Object.keys(matchOptions).length > 0 ? JSON.stringify(matchOptions) : null,
          legacySource: imported ? `st-import-${now}` : null,
          createdAt: now,
          updatedAt: now,
          };
        }));
      }
      // J: resolve runtime defaults for the Part-1 session's model so it inherits
      // proper thinking/effort/cacheTtl (e.g. adaptive thinking on Anthropic)
      // instead of the schema's thinkingMode:"off" — a wizard-created Part 1 with
      // an Opus model used to land thinking-off on first open.
      const part1ModelId = starting?.modelId ?? getDefaultChatModelId();
      const part1Defaults = getSessionRuntimeDefaults(this.customEndpoints, userId, part1ModelId);
      this.sessions.createSession({
        id: sessionId,
        userId,
        sessionType: "standard",
        campaignId,
        folderId,
        name: `${campaignName} Part 1`,
        // Part 1 starts at the server-wide starting values; everything else is the built-in defaults, which since
        // 2026-10-02 include the Dramatist (on, standard), so this no longer seeds a restrained one.
        // The PC key is seeded only for a REAL name. The guard used to compare
        // against "<user>", a sentinel the wizard never produces, so a run whose
        // marker line was missing seeded the literal placeholder "the player
        // character" as an alias instead of the intended [].
        contextOverridesJson: JSON.stringify({ ...this.newSessionOverrides(), ...(starting?.overrides ?? {}), playerCharacterKeys: playerCharacterName.trim() && playerCharacterName.trim().toLowerCase() !== WIZARD_PLAYER_CHARACTER_FALLBACK ? [playerCharacterName.trim()] : [] }),
        modelId: part1ModelId,
        temperature: part1Defaults.temperature,
        thinkingMode: part1Defaults.thinkingMode,
        thinkingBudget: part1Defaults.thinkingBudget,
        effort: part1Defaults.effort,
        cacheTtl: part1Defaults.cacheTtl,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      });
      this.preferences.ensureForUser(userId, now);
      // H: destroy ONLY the wizard session this run was actually built from.
      // The old findActiveWizardForUser fallback could blow away an UNRELATED
      // active wizard session (e.g. a second wizard the user just started) when
      // the run carried no wizardSessionId of its own.
      const wizardSessionId = details.review.wizardSessionId ?? null;
      if (wizardSessionId) orphanedImages = this.destroyWizardSession(userId, wizardSessionId);
      this.preferences.updateForUser(userId, { activeSessionId: sessionId, updatedAt: now });
      details.review.approvedCampaignId = campaignId;
      details.review.approvedSessionId = sessionId;
      const summary = `Wizard campaign ${campaignName} created with Part 1 ready.`;
      // Guarded stamp: matches only a still-unapproved completed row, so a
      // second approval that raced past the check above rolls this whole
      // transaction back instead of creating a second folder/campaign/session
      // and overwriting approvedCampaignId.
      const stamped = this.runs.stampApproved(runId, {
        summary,
        approvedAt: now,
        detailsJson: JSON.stringify(details),
        updatedAt: now,
      });
      if (!stamped) throw new HttpError(409, "wizard run was already approved");
    };
    if (this.lorebook) this.lorebook.transact(approvalBody);
    else this.folders.transact(approvalBody);
    // Deleting the files inside the transaction left dangling generated_images
    // rows whenever a later write rolled the row deletes back; the rows are
    // committed now, so the files can go.
    for (const image of orphanedImages) this.imageStore.delete(image.id, image.mimeType);
    if (this.embeddingService && createdCorpus.length > 0) {
      const model = this.resolveWizardEmbedModel(starting?.overrides.embeddingModel);
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
      // A lorebook import is re-run from the same file and the same choices.
      if (currentDetails.source) {
        details.source = currentDetails.source;
        details.review.importSummary = currentDetails.review.importSummary;
        details.review.playerCharacterName = currentDetails.review.playerCharacterName;
      }
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

  /** Row-only teardown; returns the session's image files for the caller to
   *  delete AFTER the enclosing transaction commits. */
  private destroyWizardSession(userId: string, sessionId: string): Array<{ id: string; mimeType: string }> {
    const images = this.generatedImages.listForSession(userId, sessionId).map((image) => ({ id: image.id, mimeType: image.mimeType }));
    this.generatedImages.deleteForSession(userId, sessionId);
    this.attachments.deleteForSession(userId, sessionId);
    this.pending.deleteForSession(userId, sessionId);
    this.messages.deleteForSession(userId, sessionId);
    this.lorebook?.clearActivationState(sessionId);
    this.sessions.deleteSession(userId, sessionId);
    return images;
  }
}
