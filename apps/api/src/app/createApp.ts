import fs from "node:fs";
import path from "node:path";

import express from "express";

import { buildCustomChatModels } from "@tracyhill-rp/contracts";
import { createDatabaseClient, migrateDatabase } from "@tracyhill-rp/db";
import { createLogger } from "@tracyhill-rp/logging";
import {
  createMockChatRuntime,
  createMockImageGenerationRuntime,
  type ChatRuntime,
  type ImageGenerationRuntime,
} from "@tracyhill-rp/provider-runtime";

import { AuthService } from "../domain/auth/authService";
import { AdminService } from "../domain/admin/adminService";
import { AuditRepository } from "../domain/audit/auditRepository";
import { AuditService } from "../domain/audit/auditService";
import { CampaignRepository } from "../domain/campaigns/campaignRepository";
import { CampaignService } from "../domain/campaigns/campaignService";
import { CampaignVersionRepository } from "../domain/campaigns/campaignVersionRepository";
import { PipelineRunRepository } from "../domain/pipeline/pipelineRunRepository";
import { CampaignAuditService } from "../domain/pipeline/campaignAuditService";
import { AuditFindingRepository } from "../domain/pipeline/auditFindingRepository";
import { PipelineService } from "../domain/pipeline/pipelineService";
import { CustomEndpointRepository } from "../domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../domain/providerKeys/providerKeyRepository";
import { ProviderKeyService } from "../domain/providerKeys/providerKeyService";
import { ProviderConnectionRepository } from "../domain/subscriptions/providerConnectionRepository";
import { RunnerClient } from "../domain/subscriptions/runnerClient";
import { SubscriptionService } from "../domain/subscriptions/subscriptionService";
import { createChatRuntimeForUser, createImageRuntimeForUser } from "../domain/providerKeys/providerKeyRuntime";
import { PromptTemplateRepository } from "../domain/promptTemplates/promptTemplateRepository";
import { PromptTemplateService } from "../domain/promptTemplates/promptTemplateService";
import { WizardRunRepository } from "../domain/wizard/wizardRunRepository";
import { WizardService } from "../domain/wizard/wizardService";
import { WizardTemplateRepository } from "../domain/wizard/wizardTemplateRepository";
import { ChatService } from "../domain/chat/chatService";
import { CharacterAttireRepository } from "../domain/chat/characterAttireRepository";
import { CharacterDrivesRepository } from "../domain/chat/characterDrivesRepository";
import { AdversarialWorldRepository } from "../domain/world/adversarialWorldRepository";
import { MessageAttachmentRepository } from "../domain/chat/messageAttachmentRepository";
import { MessageContextSnapshotRepository } from "../domain/chat/messageContextSnapshotRepository";
import { MessageRepository } from "../domain/chat/messageRepository";
import { PendingAssistantMessageRepository } from "../domain/chat/pendingAssistantMessageRepository";
import { GeneratedImageRepository } from "../domain/images/generatedImageRepository";
import { ImageService } from "../domain/images/imageService";
import { ImageStore } from "../domain/images/imageStore";
import { SettingsService } from "../domain/settings/settingsService";
import { defaultChatModelFor, startingModelOverrides, type StartingModels } from "../domain/providerKeys/defaultModels";
import { SERVER_SUBSCRIPTION_HOME, ServerConnectionRepository } from "../domain/subscriptions/serverConnectionRepository";
import { withSharedKeys } from "../domain/settings/sharedKeys";
import { TwoFactorService } from "../domain/auth/twoFactorService";
import { InviteService } from "../domain/auth/inviteService";
import { SetupService } from "../domain/setup/setupService";
import { UserRepository } from "../domain/users/userRepository";
import { loadEnv } from "../config/env";
import { initEncryptionKey } from "../lib/crypto";
import { ClaudeCodeBridgeService, type ClaudeCodeBridge } from "../domain/claudeCode/claudeCodeBridgeService";
import { CodexBridgeService, type CodexBridge } from "../domain/codex/codexBridgeService";
import { ContextEngine } from "../domain/context/contextEngine";
import { RetrievalScoringPool } from "../domain/context/retrievalScoringPool";
import { EmbeddingService, buildEmbeddingProviders } from "../domain/context/embeddingService";
import { LorebookEmbeddingRepository } from "../domain/context/lorebookEmbeddingRepository";
import { checkEmbeddingCoverage } from "../domain/context/embeddingCoverageMonitor";
import { LorebookRepository } from "../domain/context/lorebookRepository";
import { LorebookRevisionRepository } from "../domain/context/lorebookRevisionRepository";
import { LorebookService } from "../domain/context/lorebookService";
import { FolderRepository } from "../domain/workspace/folderRepository";
import { SessionRepository } from "../domain/workspace/sessionRepository";
import { UserPreferencesRepository } from "../domain/workspace/userPreferencesRepository";
import { WorkspaceService } from "../domain/workspace/workspaceService";
import { csrfProtection } from "../http/middleware/csrfProtection";
import { errorHandler } from "../http/middleware/errorHandler";
import { createIpAllowlist } from "../http/middleware/ipAllowlist";
import { createRequireAdmin } from "../http/middleware/requireAdmin";
import { createRequireAuth } from "../http/middleware/requireAuth";
import { createRequestLogger } from "../http/middleware/requestLogger";
import { createSecurityHeaders } from "../http/middleware/securityHeaders";
import { createAdminRoutes } from "../http/routes/adminRoutes";
import { createAuthRoutes } from "../http/routes/authRoutes";
import { createAccountRoutes } from "../http/routes/accountRoutes";
import { createCampaignRoutes } from "../http/routes/campaignRoutes";
import { createChatRoutes } from "../http/routes/chatRoutes";
import { createContextRoutes } from "../http/routes/contextRoutes";
import { createCharacterAttireRoutes } from "../http/routes/characterAttireRoutes";
import { createDrivesRoutes } from "../http/routes/drivesRoutes";
import { createWorldRoutes } from "../http/routes/worldRoutes";
import { WorldService } from "../domain/world/worldService";
import { ScheduledBeatRepository } from "../domain/world/scheduledBeatRepository";
import { createLorebookRoutes } from "../http/routes/lorebookRoutes";
import { createModelCatalogRoutes } from "../http/routes/modelCatalogRoutes";
import { createClaudeCodeRoutes } from "../http/routes/claudeCodeRoutes";
import { createCodexRoutes } from "../http/routes/codexRoutes";
import { createImageRoutes } from "../http/routes/imageRoutes";
import { createPipelineRoutes } from "../http/routes/pipelineRoutes";
import { createProviderKeyRoutes } from "../http/routes/providerKeyRoutes";
import { createSubscriptionRoutes } from "../http/routes/subscriptionRoutes";
import { createPromptTemplateRoutes } from "../http/routes/promptTemplateRoutes";
import { createAuthOptionsRoutes } from "../http/routes/authOptionsRoutes";
import { createCodingPanelRoutes } from "../http/routes/codingPanelRoutes";
import { createServerSettingsRoutes } from "../http/routes/serverSettingsRoutes";
import { createSetupRoutes } from "../http/routes/setupRoutes";
import { createSystemRoutes } from "../http/routes/systemRoutes";
import { createWizardRoutes } from "../http/routes/wizardRoutes";
import { createWorkspaceRoutes } from "../http/routes/workspaceRoutes";
import { createSystemEventRoutes } from "../http/routes/systemEventRoutes";
import { initSystemEvents, sweepSystemEvents, recordSystemEvent } from "../domain/system/systemEvents";
import { checkPipelineLiveness, getWorkerStatus } from "../domain/system/livenessMonitor";
import { checkCatalogInvariants } from "@tracyhill-rp/model-catalog";
import { createSessionMiddleware } from "../services/sessionCookie";
import { AuthEmailService } from "../services/authEmail";
import { PipelineQueueService } from "../domain/pipeline/pipelineQueueService";
import { PipelineWorker } from "../../../worker/src/pipeline/pipelineWorker";
import { WizardWorker } from "../../../worker/src/wizard/wizardWorker";

export function createApp(options?: { chatRuntime?: ChatRuntime | null; imageRuntime?: ImageGenerationRuntime | null; pipelineRuntime?: ChatRuntime | null; wizardRuntime?: ChatRuntime | null; claudeCodeBridge?: ClaudeCodeBridge | null; kimiCodeBridge?: ClaudeCodeBridge | null; codexBridge?: CodexBridge | null }) {
  const env = loadEnv();
  initEncryptionKey(env.sessionSecret);
  const logger = createLogger("tracyhill-rp-v2-api");
  // Every background interval is registered here so index.ts can clear them on
  // SIGTERM and tests can release them.
  const backgroundTimers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => { const t = setInterval(fn, ms); t.unref?.(); backgroundTimers.push(t); };
  migrateDatabase(env.dbFile);
  const { db } = createDatabaseClient(env.dbFile);
  // No-silent-failures recorder: passive subsystems (embeds, HyDE, researcher,
  // validators, workers) persist their failures here for UI surfacing.
  initSystemEvents(db);
  // Retention sweep at boot AND daily: setInterval's first tick is
  // 24 h after boot, so an API restarted more often than daily (every deploy)
  // never swept and the table grew without bound.
  try { sweepSystemEvents(); } catch { /* non-fatal */ }
  every(24 * 60 * 60 * 1000, () => { try { sweepSystemEvents(); } catch { /* non-fatal */ } });
  // Catalog-invariant check: the model catalog is a static artifact, so a broken
  // invariant (e.g. a bridge id that misroutes max_tokens) should never reach
  // serving silently. Fail fast in dev/test/CI so the vitest + a deploy catch it;
  // in prod log + record events and keep booting (a catalog typo must not crash-loop).
  {
    const { errors, warnings } = checkCatalogInvariants();
    for (const w of warnings) logger.warn({ source: "model-catalog" }, `[catalog-invariant] ${w}`);
    if (errors.length > 0) {
      if (process.env.NODE_ENV === "production") {
        for (const e of errors) {
          logger.error({ source: "model-catalog" }, `[catalog-invariant] ${e}`);
          recordSystemEvent({ userId: "__system__", source: "pipeline", severity: "error", message: `catalog invariant violated: ${e}` });
        }
      } else {
        throw new Error(`Model catalog invariants violated:\n  ${errors.join("\n  ")}`);
      }
    }
  }
  const users = new UserRepository(db);
  const auditEvents = new AuditRepository(db);
  const audit = new AuditService(auditEvents);
  const sessions = new SessionRepository(db);
  const campaigns = new CampaignRepository(db);
  const folders = new FolderRepository(db);
  const campaignVersions = new CampaignVersionRepository(db);
  const pipelineRuns = new PipelineRunRepository(db);
  const providerKeys = new ProviderKeyRepository(db);
  const customEndpoints = new CustomEndpointRepository(db);
  const providerConnections = new ProviderConnectionRepository(db);
  const promptTemplates = new PromptTemplateRepository(db);
  const wizardTemplates = new WizardTemplateRepository(db);
  const wizardRuns = new WizardRunRepository(db);
  const messages = new MessageRepository(db);
  const attachments = new MessageAttachmentRepository(db);
  // Per-reply context snapshots: the chat turn writes
  // them (ChatService) and the chat route below reads them.
  const contextSnapshots = new MessageContextSnapshotRepository(db);
  const pendingAssistantMessages = new PendingAssistantMessageRepository(db);
  const characterAttire = new CharacterAttireRepository(db);
  const characterDrives = new CharacterDrivesRepository(db);
  // Adversarial World state (phases 3-6). Gated on worldStance internally, so
  // constructing it is free at the shipped default.
  const adversarialWorld = new AdversarialWorldRepository(db);
  const scheduledBeats = new ScheduledBeatRepository(db);
  const generatedImages = new GeneratedImageRepository(db);
  const imageStore = new ImageStore(env.imageDir);
  // The server settings (Admin: Server settings): read through this service, and a value the
  // environment sets wins and shows locked. The coding panels' readiness is read lazily: the bridges come later.
  let codingPanelsReady = () => ({ claudeCode: false, codex: false, kimi: false });
  const settings = new SettingsService(db, {
    sendgridApiKey: env.sendgridApiKey,
    emailFrom: env.emailFrom,
    emailFromName: env.emailFromName,
    exposeAuthCodes: env.exposeAuthCodes,
    trustProxy: process.env.TRUST_PROXY?.trim() ?? "",
    allowedIps: env.allowedIps,
    defaultTimeZone: process.env.TZ?.trim() || "UTC",
    codingPanels: () => codingPanelsReady(),
    providerKeys: {
      anthropic: env.anthropicApiKey, deepseek: env.deepseekApiKey, fireworks: env.fireworksApiKey, gmicloud: env.gmicloudApiKey,
      google: env.googleApiKey, moonshot: env.moonshotApiKey, openai: env.openaiApiKey, xai: env.xaiApiKey, xiaomi: env.xiaomiApiKey, zai: env.zaiApiKey,
    },
  });
  settings.initialize();
  const authEmail = new AuthEmailService({
    exposeAuthCodes: env.exposeAuthCodes,
    transport: () => settings.emailTransport(),
    working: () => settings.emailWorking(),
  });
  const preferences = new UserPreferencesRepository(db);
  // First-run setup: index.ts prints the one-time code at boot while no account exists; the first account writes the
  // new server's settings.
  const setup = new SetupService(users, preferences, undefined, ({ timeZone }) => settings.writeFreshDefaults(timeZone));
  const sessionMiddleware = createSessionMiddleware(env);
  // Each provider key resolves at read time: the environment's value, else the server-wide key set in Admin: Server
  // settings, which every account without its own key uses.
  const runtimeDefaults = withSharedKeys({
    anthropicApiKey: env.anthropicApiKey,
    runnerUrl: env.runnerUrl,
    runnerSecret: env.runnerSecret,
    deepseekApiKey: env.deepseekApiKey,
    fireworksApiKey: env.fireworksApiKey,
    gmicloudApiKey: env.gmicloudApiKey,
    googleApiKey: env.googleApiKey,
    moonshotApiKey: env.moonshotApiKey,
    openaiApiKey: env.openaiApiKey,
    xaiApiKey: env.xaiApiKey,
    xiaomiApiKey: env.xiaomiApiKey,
    zaiApiKey: env.zaiApiKey,
    localEmbeddingUrl: env.localEmbeddingUrl,
    localEmbeddingKey: env.localEmbeddingKey,
  }, (provider) => settings.sharedKey(provider));
  // Revision capture: every destructive lorebook mutation snapshots
  // the pre-write row so worker rewrites are auditable + revertible.
  const lorebookRevisions = new LorebookRevisionRepository(db);
  const lorebookRepo = new LorebookRepository(db, lorebookRevisions);
  const campaignService = new CampaignService(users, campaigns, campaignVersions, folders, lorebookRepo, sessions);
  // Account deletion (self-service AND admin) runs the campaign SERVICE delete
  // per owned campaign inside the account transaction, so the account path
  // inherits every campaign-scoped cascade instead of re-listing tables.
  const deleteUserCampaigns = (userId: string) => {
    for (const campaign of campaigns.listForUser(userId)) campaignService.delete(userId, campaign.id);
  };
  // eslint-disable-next-line prefer-const
  let subscriptionServiceRef: SubscriptionService;
  const twoFactor = new TwoFactorService(db);
  const invites = new InviteService(db);
  const auth = new AuthService(users, generatedImages, imageStore, authEmail, deleteUserCampaigns, (userId) => subscriptionServiceRef.disconnectAll(userId), {
    registrationOpen: () => settings.accounts().registration === "open",
    termsRequired: () => settings.accounts().termsRequired,
  }, { settings: () => settings.twoFactor(), service: twoFactor });
  const admin = new AdminService(users, preferences, sessions, messages, providerKeys, generatedImages, imageStore, env.dbFile, env.imageDir, sessionMiddleware.store, deleteUserCampaigns, (userId) => subscriptionServiceRef.disconnectAll(userId));
  const lorebookEmbeddingRepo = new LorebookEmbeddingRepository(db);
  // Embedding-coverage watchdog: every 6h, surface campaigns whose lorebook has a
  // significant missing/stale-vector gap so the drift class becomes observable
  // instead of needing ad-hoc backfill scripts. Defensive + throttled internally.
  every(6 * 60 * 60 * 1000, () => { try { checkEmbeddingCoverage({ users, campaigns, sessions, embeddings: lorebookEmbeddingRepo }); } catch { /* non-fatal */ } });
  // The server-level embedding providers (OpenAI and Google from the server's keys, including shared ones, read when
  // used; `local:` from LOCAL_EMBEDDING_URL, dormant unless set), the same builder every worker uses.
  const embeddingProviders = buildEmbeddingProviders(runtimeDefaults);
  const embeddingService = new EmbeddingService(lorebookEmbeddingRepo, embeddingProviders, providerKeys);
  const lorebookService = new LorebookService(users, lorebookRepo, embeddingService, lorebookEmbeddingRepo, campaigns, lorebookRevisions, sessions);
  const providerKeyService = new ProviderKeyService(users, providerKeys, customEndpoints, providerConnections, runtimeDefaults, env.customEndpointAllowHosts);
  const runnerClient = new RunnerClient({ runnerUrl: env.runnerUrl, runnerSecret: env.runnerSecret });
  const subscriptionService = new SubscriptionService(users, providerConnections, runnerClient);
  subscriptionServiceRef = subscriptionService;
  // The Claude and ChatGPT sign-ins of accounts deleted while the runner could not be reached: removed shortly after
  // start and every six hours (a no-op without a runner; never under NODE_ENV=test, like the runner probe below).
  const removeOrphanedSignIns = () => {
    subscriptionService.removeOrphanedSignIns((userId) => Boolean(users.findById(userId)))
      .catch((error) => logger.warn({ err: error }, "subscription sign-in cleanup failed; the next run retries"));
  };
  if (runnerClient.configured && !env.mockProvider && process.env.NODE_ENV !== "test") {
    const firstCleanup = setTimeout(removeOrphanedSignIns, 30_000);
    firstCleanup.unref?.();
    backgroundTimers.push(firstCleanup);
    every(6 * 60 * 60 * 1000, removeOrphanedSignIns);
  }
  // The server-wide sign-in: the same flow for the runner's shared home, which no account owns.
  const sharedSubscriptionService = new SubscriptionService(
    // It checks only that the "account" exists: the shared home stands in for one.
    { findById: (id: string) => (id === SERVER_SUBSCRIPTION_HOME ? ({ id } as NonNullable<ReturnType<UserRepository["findById"]>>) : undefined) },
    new ServerConnectionRepository(db),
    runnerClient,
  );
  const getChatRuntimeForUser = (userId: string) => options?.chatRuntime
    ?? (env.mockProvider ? createMockChatRuntime() : createChatRuntimeForUser(providerKeys, customEndpoints, providerConnections, userId, runtimeDefaults));
  const getImageRuntimeForUser = (userId: string) => options?.imageRuntime
    ?? (env.mockProvider ? createMockImageGenerationRuntime() : createImageRuntimeForUser(providerKeys, userId, runtimeDefaults));
  // What a session with nothing to inherit starts on, for one account (defaultModels.ts): the providers it can reach now
  // (its own key or sign-in, a server-wide one, or the environment's) decide between Claude Opus 4.6 and a fallback.
  const startingModels: StartingModels = (userId, requestedModelId) => {
    const { providers, customEndpoints: endpoints } = providerKeyService.listKeys(userId);
    const usable = new Set(Object.entries(providers).filter(([, status]) => status.configured).map(([provider]) => provider));
    const customModelIds = buildCustomChatModels(endpoints).map((model) => model.id);
    const modelId = requestedModelId?.trim() || defaultChatModelFor(usable, customModelIds);
    return { modelId, overrides: startingModelOverrides(usable, modelId, { localEmbeddings: Boolean(env.localEmbeddingUrl) }) };
  };
  const workspace = new WorkspaceService(
    users,
    preferences,
    folders,
    sessions,
    campaigns,
    messages,
    attachments,
    pendingAssistantMessages,
    generatedImages,
    imageStore,
    customEndpoints,
    embeddingService,
    lorebookRepo,
    () => settings.sessionDefaultOverrides(),
    startingModels,
  );
  // MOCK_PROVIDER: the inline pipeline worker must get the MOCK runtime object — every pipeline
  // worker reads `null` as "build the user's real runtime from stored keys". The wizard keeps
  // `null` as its own explicit-mock sentinel.
  const pipelineRuntime = options?.pipelineRuntime ?? (env.mockProvider ? createMockChatRuntime() : undefined);
  const inlinePipelineWorker = env.inlineWorkers ? new PipelineWorker(env.dbFile, { runtime: pipelineRuntime, runtimeDefaults }) : null;
  const pipeline = new PipelineService(users, campaigns, pipelineRuns, sessions, inlinePipelineWorker);
  const promptTemplateService = new PromptTemplateService(users, promptTemplates);
  const wizardRuntime = options?.wizardRuntime ?? (env.mockProvider ? null : undefined);
  const inlineWizardWorker = env.inlineWorkers ? new WizardWorker(env.dbFile, { runtime: wizardRuntime, runtimeDefaults }) : null;
  const wizard = new WizardService(users, campaigns, sessions, preferences, folders, messages, attachments, pendingAssistantMessages, generatedImages, imageStore, wizardTemplates, wizardRuns, customEndpoints, inlineWizardWorker, lorebookRepo, characterAttire, embeddingService, characterDrives, adversarialWorld, () => settings.sessionDefaultOverrides(), startingModels);
  // Per-turn retrieval scoring runs on a worker thread (CONTEXT_SCORING_WORKER=0 keeps it inline).
  const retrievalScoring = new RetrievalScoringPool({ enabled: env.contextScoringWorker });
  const contextEngine = new ContextEngine(lorebookRepo, lorebookEmbeddingRepo, embeddingService, getChatRuntimeForUser, retrievalScoring);
  // The API fills the pipeline queue in BOTH worker topologies — auto-enqueue
  // (evaluateAndEnqueue) runs on turn completion in this process regardless of
  // who executes the runs. Only the kick shortcut is inline-only; the dedicated
  // worker container discovers queued runs by polling (PIPELINE_POLL_MS).
  // Gating the queue itself on inlinePipelineWorker silently killed ALL
  // auto-pipeline work under INLINE_WORKERS=0, masked for a month by an older
  // deployment setup that forced inline mode.
  const pipelineQueue = new PipelineQueueService(db, pipelineRuns, inlinePipelineWorker ? () => inlinePipelineWorker.kick() : () => {});
  // Boot attestation: state the
  // effective topology once, loudly, where operators already look. The
  // month-long masking of the split-topology bugs happened precisely because
  // nothing ever recorded what mode was actually running.
  recordSystemEvent({
    userId: "__system__", source: "pipeline", severity: "info",
    message: `boot: api online — topology=${env.inlineWorkers ? "inline-workers" : "split-worker"}, pipeline queue active${env.inlineWorkers ? "" : " (dedicated worker drains by poll)"}`,
  });
  // Recover runs left `running` by a deploy/restart BEFORE the boot kick,
  // so an orphaned run can't block its campaign's queue for up to the 60-min stale
  // window. Guarded `running→queued`, idempotent across the two-process topology.
  if (inlinePipelineWorker) { try { pipelineRuns.recoverOrphanedRunningJobs(); } catch (err) { logger.warn({ err }, "pipeline orphan recovery failed (non-fatal)"); } }
  if (inlineWizardWorker) { try { wizardRuns.recoverOrphanedRunningJobs(); } catch (err) { logger.warn({ err }, "wizard orphan recovery failed (non-fatal)"); } }
  if (inlinePipelineWorker) setTimeout(() => inlinePipelineWorker.kick(), 5000).unref?.();
  every(5 * 60 * 1000, () => { if (pipelineQueue.sweepStaleLocks() > 0) inlinePipelineWorker?.kick(); });
  // Liveness invariants: worker-heartbeat staleness + wedged-enqueue
  // detection. Absence of pipeline activity during active play must be loud:
  // it is the signature of a silently dead pipeline.
  const bootedAtMs = Date.now();
  every(5 * 60 * 1000, () => {
    try { checkPipelineLiveness(db, { inlineWorkers: env.inlineWorkers, bootedAtMs }); }
    catch (err) { logger.warn({ err }, "pipeline liveness check failed (non-fatal)"); }
  });
  // Wizard worker parity: boot kick, which the pipeline worker
  // already had but the wizard worker never did. The 5-min stale-lock sweep that
  // used to sit beside it could never reap a row (the 45-s heartbeat keeps a live
  // run fresh; a dead process's rows are requeued by recoverOrphanedRunningJobs at
  // the next boot) and was removed.
  if (inlineWizardWorker) setTimeout(() => inlineWizardWorker.kick(), 5000).unref?.();
  const worldService = new WorldService(users, campaigns, sessions, messages, pipelineRuns, characterDrives, scheduledBeats, lorebookRepo, contextEngine, embeddingService, inlinePipelineWorker ? () => inlinePipelineWorker.kick() : null, adversarialWorld);
  const campaignAuditService = new CampaignAuditService(users, campaigns, sessions, pipelineRuns, contextEngine, customEndpoints, inlinePipelineWorker ? () => inlinePipelineWorker.kick() : null, messages, new AuditFindingRepository(db), lorebookRepo);
  const chat = new ChatService(users, sessions, campaigns, messages, attachments, pendingAssistantMessages, generatedImages, imageStore, wizardTemplates, customEndpoints, getChatRuntimeForUser, contextEngine, pipelineRuns, pipelineQueue, characterAttire, characterDrives, scheduledBeats, adversarialWorld, contextSnapshots);
  const images = new ImageService(users, sessions, messages, generatedImages, getImageRuntimeForUser, imageStore, chat);
  const requireAdmin = createRequireAdmin(users);
  const claudeCodeBridge = options?.claudeCodeBridge ?? new ClaudeCodeBridgeService({
    host: env.claudeCodeHost,
    port: env.claudeCodePort,
    secret: env.claudeCodeSecret,
    caPath: env.claudeCodeCaPath || undefined,
    servername: env.claudeCodeServername,
  });
  const codexBridge = options?.codexBridge ?? new CodexBridgeService({
    host: env.codexAgentHost,
    port: env.codexAgentPort,
    secret: env.codexAgentSecret,
    caPath: env.codexAgentCaPath || undefined,
    servername: env.codexAgentServername,
  });
  // Kimi coding panel — a second ClaudeCode-harness bridge pointed at the
  // external Kimi agent service (default port 7704), which serves Kimi K3 via the Claude Code CLI.
  const kimiCodeBridge = options?.kimiCodeBridge ?? new ClaudeCodeBridgeService({
    host: env.kimiCodeHost,
    port: env.kimiCodePort,
    secret: env.kimiCodeSecret,
    caPath: env.kimiCodeCaPath || undefined,
    servername: env.kimiCodeServername,
    exportFilePrefix: "kimi-code",
  });
  codingPanelsReady = () => ({ claudeCode: claudeCodeBridge.isConfigured(), codex: codexBridge.isConfigured(), kimi: kimiCodeBridge.isConfigured() });
  // The coding panels are optional and never set up automatically: an unset panel is an
  // info event at boot, not an alert, and the web greys it out (GET /api/coding-panels). The -codex-bridge chat models
  // do not depend on CODEX_*: they run on the subscription runner since 2026-09-25.
  if (!codexBridge.isConfigured()) {
    recordSystemEvent({ userId: "__system__", source: "pipeline", severity: "info", message: "The Codex panel is not set up: it needs CODEX_HOST and CODEX_SECRET. It is optional, and the coding menu shows it greyed out." });
  }
  if (!runnerClient.configured) {
    recordSystemEvent({ userId: "__system__", source: "pipeline", severity: "warn", message: "Subscription runner is not configured (RUNNER_URL and RUNNER_SECRET, or SESSION_SECRET) — Claude and ChatGPT subscription sign-ins and their models will be unavailable" });
  } else if (!env.mockProvider && process.env.NODE_ENV !== "test") {
    // Non-blocking boot probe: a missing or unhealthy runner is a boot signal, not a
    // per-turn surprise. Delayed so the runner container has a moment to come up.
    // Never under NODE_ENV=test (vitest's default): the default RUNNER_URL is the
    // Compose host name, and API tests never resolve a real host name.
    setTimeout(() => {
      runnerClient.health().then((health) => {
        logger.info({ runner: env.runnerUrl, claudeVersion: health.claudeVersion ?? null, codexVersion: health.codexVersion ?? null }, "subscription runner reachable");
      }).catch((error: unknown) => {
        recordSystemEvent({ userId: "__system__", source: "pipeline", severity: "warn", message: `Subscription runner at ${env.runnerUrl} is not reachable at boot (${error instanceof Error ? error.message : String(error)}) — sign-ins and subscription models will fail until it is` });
      });
    }, 15_000).unref();
  }
  if (!kimiCodeBridge.isConfigured()) {
    recordSystemEvent({ userId: "__system__", source: "pipeline", severity: "info", message: "The Kimi (K3) panel is not set up: it needs KIMI_CODE_HOST and KIMI_CODE_SECRET. It is optional, and the coding menu shows it greyed out." });
  }
  if (!claudeCodeBridge.isConfigured()) {
    recordSystemEvent({ userId: "__system__", source: "pipeline", severity: "info", message: "The Claude Code panel is not set up: it needs CLAUDE_CODE_HOST and CLAUDE_CODE_SECRET. It is optional, and the coding menu shows it greyed out." });
  }
  // isConfigured() ignores the CA: with *_CA_PATH unset or unreadable every
  // TLS handshake to the self-signed agents fails at request time with no
  // boot signal. configWarning() is
  // optional on the interfaces so test mocks need not implement it.
  for (const [label, bridge] of [
    ["ClaudeCode panel bridge", claudeCodeBridge],
    ["CodexBridge", codexBridge],
    ["Kimi coding bridge", kimiCodeBridge],
  ] as const) {
    const warning = bridge.configWarning?.();
    if (warning) recordSystemEvent({ userId: "__system__", source: "pipeline", severity: "warn", message: `${label}: ${warning}` });
  }

  const app = express();
  app.disable("x-powered-by");
  // Hop count or trusted-address list from TRUST_PROXY: one hop was
  // hard-coded, which collapses every external client onto the edge proxy's
  // address when the edge proxy chains through the internal one. Express
  // compiles an address list here and throws on an invalid entry (loud boot).
  if (env.trustProxy) app.set("trust proxy", env.trustProxySetting);
  app.use(createSecurityHeaders(env));
  // Request logger BEFORE the gates: allowlist 403s, body-parser
  // 4xx and CSRF rejections used to happen before any request-id / start /
  // completion line existed, so the error handler could not correlate them.
  app.use(createRequestLogger(logger));
  app.use(createIpAllowlist(env.allowedIps));
  app.use(sessionMiddleware);
  app.use(csrfProtection);
  // Auth endpoints are reachable pre-auth — cap their bodies tightly before
  // the global parser (which stays large for attachment/import payloads) so an
  // anonymous caller can't have 100MB buffered + parsed.
  app.use(["/api/auth", "/api/setup"], express.json({ limit: "64kb" }));
  // Resolve current authentication BEFORE allocating attachment/import bodies.
  // The route-level ownership checks still enforce the specific resource.
  app.use(["/api/chat", "/api/lorebook", "/api/wizard/import"], createRequireAuth(users), express.json({ limit: "75mb" }));
  // Panel uploads: the three /upload routes carry
  // base64 file bodies up to PANEL_UPLOAD_MAX_BYTES (20 MB decoded ≈ 26.7 MB of
  // base64) and were silently under the global 1 MB parser — base64 JSON over
  // ~750 KB 413'd while the Codex composer advertised 20 MB. The routes
  // pre-check the decoded size, so this only needs to admit the encoded body.
  app.use(["/api/claude-code/upload", "/api/kimi-code/upload", "/api/codex/upload"], createRequireAuth(users), requireAdmin, express.json({ limit: "28mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/system", createSystemRoutes({
    topology: env.inlineWorkers ? "inline" : "split",
    workerStatus: env.inlineWorkers ? null : () => getWorkerStatus(db),
  }));
  app.use("/api/admin/settings/subscriptions", createSubscriptionRoutes(sharedSubscriptionService, audit, users, {
    userOf: () => SERVER_SUBSCRIPTION_HOME,
    guards: [requireAdmin],
    auditTarget: { targetType: "server-subscription", targetId: "server" },
    auditPrefix: "subscriptions.shared_",
  }));
  app.use("/api/admin/settings", createServerSettingsRoutes(settings, audit, requireAdmin, users));
  app.use("/api/admin", createAdminRoutes(admin, audit, requireAdmin, users, (userId) => auth.resetTwoFactor(userId), invites));
  app.use("/api/auth", createAuthOptionsRoutes(settings, setup, authEmail));
  app.use("/api/auth", createAuthRoutes(auth, audit, sessionMiddleware.store, invites));
  app.use("/api/setup", createSetupRoutes(setup, audit));
  app.use("/api/account", createAccountRoutes(auth, audit, users, sessionMiddleware.store));
  app.use("/api/campaigns", createCampaignRoutes(campaignService, users));
  app.use("/api/chat", createChatRoutes(chat, users, { contextSnapshots, sessions }));
  app.use("/api/context", createContextRoutes({ contextEngine, embeddingService, lorebook: lorebookRepo, users, sessions, campaigns, messages }));
  app.use("/api/lorebook", createLorebookRoutes(lorebookService, users));
  // Current-turn resolver for manual attire/drive edits: the campaign's newest
  // live session's max ACTIVE sort_order + 1 —
  // the same estimate chatService's attire staleness check computes.
  const resolveCurrentTurn = (userId: string, campaignId: string): number | null => {
    const session = sessions.findNewestForCampaign(userId, campaignId);
    if (!session) return null;
    const tail = messages.listWindow(userId, session.id, { limit: 1 });
    return Math.max(0, tail[0]?.sortOrder ?? 0) + 1;
  };
  app.use("/api/character-attire", createCharacterAttireRoutes(characterAttire, campaigns, users, resolveCurrentTurn));
  app.use("/api/drives", createDrivesRoutes(characterDrives, campaigns, users, resolveCurrentTurn));
  app.use("/api/world", createWorldRoutes(worldService, users));
  app.use("/api/claude-code", createClaudeCodeRoutes(claudeCodeBridge, audit, requireAdmin, users));
  app.use("/api/kimi-code", createClaudeCodeRoutes(kimiCodeBridge, audit, requireAdmin, users, { serving: true }));
  app.use("/api/codex", createCodexRoutes(codexBridge, audit, requireAdmin, users));
  app.use("/api/coding-panels", createCodingPanelRoutes({ claudeCode: claudeCodeBridge, codex: codexBridge, kimi: kimiCodeBridge }, requireAdmin, users));
  app.use("/api/images", createImageRoutes(images, users));
  app.use("/api/models", createModelCatalogRoutes(users));
  app.use("/api/pipeline", createPipelineRoutes(pipeline, audit, users, pipelineRuns, campaignAuditService));
  app.use("/api/provider-keys", createProviderKeyRoutes(providerKeyService, audit, users));
  app.use("/api/providers/subscriptions", createSubscriptionRoutes(subscriptionService, audit, users));
  app.use("/api/prompt-templates", createPromptTemplateRoutes(promptTemplateService, users));
  app.use("/api/wizard", createWizardRoutes(wizard, audit, users));
  app.use("/api/workspace", createWorkspaceRoutes(workspace, users));
  app.use("/api/system-events", createSystemEventRoutes(users));
  // Unknown /api/* paths answer in the JSON {error} shape every client parses,
  // not finalhandler's HTML "Cannot GET" page.
  app.use("/api", (_req, res) => { res.status(404).json({ error: "not found" }); });
  if (fs.existsSync(env.webDistDir)) {
    app.use(express.static(env.webDistDir));
    app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(env.webDistDir, "index.html"));
    });
  }
  app.use(errorHandler);
  // pipelineQueue is exposed for the split-topology wiring regression test —
  // it must exist regardless of INLINE_WORKERS (see the construction comment).
  // sessionStore is exposed so index.ts can close its handle + prune timer on
  // SIGTERM and tests can release it.
  const stopBackgroundTimers = () => { for (const t of backgroundTimers.splice(0)) clearInterval(t); };
  return { app, env, logger, pipelineQueue, sessionStore: sessionMiddleware.store, stopBackgroundTimers, retrievalScoring, setup, settings };
}
