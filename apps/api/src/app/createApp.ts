import fs from "node:fs";
import path from "node:path";

import express from "express";

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
import { ArtifactRepository } from "../domain/pipeline/artifactRepository";
import { PipelineRunRepository } from "../domain/pipeline/pipelineRunRepository";
import { PipelineService } from "../domain/pipeline/pipelineService";
import { CustomEndpointRepository } from "../domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../domain/providerKeys/providerKeyRepository";
import { ProviderKeyService } from "../domain/providerKeys/providerKeyService";
import { createChatRuntimeForUser, createImageRuntimeForUser } from "../domain/providerKeys/providerKeyRuntime";
import { PromptTemplateRepository } from "../domain/promptTemplates/promptTemplateRepository";
import { PromptTemplateService } from "../domain/promptTemplates/promptTemplateService";
import { WizardRunRepository } from "../domain/wizard/wizardRunRepository";
import { WizardService } from "../domain/wizard/wizardService";
import { WizardTemplateRepository } from "../domain/wizard/wizardTemplateRepository";
import { ChatService } from "../domain/chat/chatService";
import { CharacterAttireRepository } from "../domain/chat/characterAttireRepository";
import { MessageAttachmentRepository } from "../domain/chat/messageAttachmentRepository";
import { MessageRepository } from "../domain/chat/messageRepository";
import { PendingAssistantMessageRepository } from "../domain/chat/pendingAssistantMessageRepository";
import { GeneratedImageRepository } from "../domain/images/generatedImageRepository";
import { ImageService } from "../domain/images/imageService";
import { ImageStore } from "../domain/images/imageStore";
import { UserRepository } from "../domain/users/userRepository";
import { loadEnv } from "../config/env";
import { initEncryptionKey } from "../lib/crypto";
import { ClaudeCodeBridgeService, type ClaudeCodeBridge } from "../domain/claudeCode/claudeCodeBridgeService";
import { CodexBridgeService, type CodexBridge } from "../domain/codex/codexBridgeService";
import { ContextEngine } from "../domain/context/contextEngine";
import { EmbeddingService, OpenAIEmbeddingProvider, GoogleEmbeddingProvider, type EmbeddingProvider } from "../domain/context/embeddingService";
import { LorebookEmbeddingRepository } from "../domain/context/lorebookEmbeddingRepository";
import { LorebookRepository } from "../domain/context/lorebookRepository";
import { LorebookService } from "../domain/context/lorebookService";
import { FolderRepository } from "../domain/workspace/folderRepository";
import { SessionRepository } from "../domain/workspace/sessionRepository";
import { UserPreferencesRepository } from "../domain/workspace/userPreferencesRepository";
import { WorkspaceService } from "../domain/workspace/workspaceService";
import { csrfProtection } from "../http/middleware/csrfProtection";
import { errorHandler } from "../http/middleware/errorHandler";
import { createIpAllowlist } from "../http/middleware/ipAllowlist";
import { createRequireAdmin } from "../http/middleware/requireAdmin";
import { createRequestLogger } from "../http/middleware/requestLogger";
import { createSecurityHeaders } from "../http/middleware/securityHeaders";
import { createAdminRoutes } from "../http/routes/adminRoutes";
import { createAuthRoutes } from "../http/routes/authRoutes";
import { createAccountRoutes } from "../http/routes/accountRoutes";
import { createCampaignRoutes } from "../http/routes/campaignRoutes";
import { createChatRoutes } from "../http/routes/chatRoutes";
import { createContextRoutes } from "../http/routes/contextRoutes";
import { createCharacterAttireRoutes } from "../http/routes/characterAttireRoutes";
import { createLorebookRoutes } from "../http/routes/lorebookRoutes";
import { createClaudeCodeRoutes } from "../http/routes/claudeCodeRoutes";
import { createCodexRoutes } from "../http/routes/codexRoutes";
import { createImageRoutes } from "../http/routes/imageRoutes";
import { createPipelineRoutes } from "../http/routes/pipelineRoutes";
import { createProviderKeyRoutes } from "../http/routes/providerKeyRoutes";
import { createPromptTemplateRoutes } from "../http/routes/promptTemplateRoutes";
import { createSystemRoutes } from "../http/routes/systemRoutes";
import { createWizardRoutes } from "../http/routes/wizardRoutes";
import { createWorkspaceRoutes } from "../http/routes/workspaceRoutes";
import { createSystemEventRoutes } from "../http/routes/systemEventRoutes";
import { initSystemEvents, sweepSystemEvents } from "../domain/system/systemEvents";
import { createSessionMiddleware } from "../services/sessionCookie";
import { AuthEmailService } from "../services/authEmail";
import { PipelineQueueService } from "../domain/pipeline/pipelineQueueService";
import { PipelineWorker } from "../../../worker/src/pipeline/pipelineWorker";
import { WizardWorker } from "../../../worker/src/wizard/wizardWorker";

export function createApp(options?: { chatRuntime?: ChatRuntime | null; imageRuntime?: ImageGenerationRuntime | null; pipelineRuntime?: ChatRuntime | null; wizardRuntime?: ChatRuntime | null; claudeCodeBridge?: ClaudeCodeBridge | null; codexBridge?: CodexBridge | null }) {
  const env = loadEnv();
  initEncryptionKey(env.sessionSecret);
  const logger = createLogger("tracyhill-rp-v2-api");
  migrateDatabase(env.dbFile);
  const { db } = createDatabaseClient(env.dbFile);
  // No-silent-failures recorder: passive subsystems (embeds, HyDE, researcher,
  // validators, workers) persist their failures here for UI surfacing.
  initSystemEvents(db);
  setInterval(() => { try { sweepSystemEvents(); } catch { /* non-fatal */ } }, 24 * 60 * 60 * 1000).unref?.();
  const users = new UserRepository(db);
  const auditEvents = new AuditRepository(db);
  const audit = new AuditService(auditEvents);
  const sessions = new SessionRepository(db);
  const campaigns = new CampaignRepository(db);
  const folders = new FolderRepository(db);
  const campaignVersions = new CampaignVersionRepository(db);
  const pipelineRuns = new PipelineRunRepository(db);
  const pipelineArtifacts = new ArtifactRepository(db);
  try { pipelineArtifacts.sweepExpired(); } catch {}
  const providerKeys = new ProviderKeyRepository(db);
  const customEndpoints = new CustomEndpointRepository(db);
  const promptTemplates = new PromptTemplateRepository(db);
  const wizardTemplates = new WizardTemplateRepository(db);
  const wizardRuns = new WizardRunRepository(db);
  const messages = new MessageRepository(db);
  const attachments = new MessageAttachmentRepository(db);
  const pendingAssistantMessages = new PendingAssistantMessageRepository(db);
  const characterAttire = new CharacterAttireRepository(db);
  const generatedImages = new GeneratedImageRepository(db);
  const imageStore = new ImageStore(env.imageDir);
  const authEmail = new AuthEmailService({
    sendgridApiKey: env.sendgridApiKey,
    emailFrom: env.emailFrom,
    emailFromName: env.emailFromName,
    exposeAuthCodes: env.exposeAuthCodes,
  });
  const auth = new AuthService(users, generatedImages, imageStore, authEmail);
  const preferences = new UserPreferencesRepository(db);
  const sessionMiddleware = createSessionMiddleware(env);
  const admin = new AdminService(users, preferences, sessions, messages, providerKeys, generatedImages, imageStore, env.dbFile, env.imageDir, sessionMiddleware.store);
  const runtimeDefaults = {
    anthropicApiKey: env.anthropicApiKey,
    claudeCodeBridgeUrl: env.claudeCodeBridgeUrl,
    claudeCodeBridgeSecret: env.claudeCodeBridgeSecret,
    deepseekApiKey: env.deepseekApiKey,
    googleApiKey: env.googleApiKey,
    openaiApiKey: env.openaiApiKey,
    xaiApiKey: env.xaiApiKey,
    xiaomiApiKey: env.xiaomiApiKey,
    zaiApiKey: env.zaiApiKey,
  };
  const lorebookRepo = new LorebookRepository(db);
  const campaignService = new CampaignService(users, campaigns, campaignVersions, customEndpoints, folders, lorebookRepo, characterAttire, sessions);
  const lorebookEmbeddingRepo = new LorebookEmbeddingRepository(db);
  const embeddingProviders = new Map<string, EmbeddingProvider>();
  if (runtimeDefaults.openaiApiKey) embeddingProviders.set("openai", new OpenAIEmbeddingProvider(runtimeDefaults.openaiApiKey));
  if (runtimeDefaults.googleApiKey) embeddingProviders.set("google", new GoogleEmbeddingProvider(runtimeDefaults.googleApiKey));
  const embeddingService = new EmbeddingService(lorebookEmbeddingRepo, embeddingProviders, providerKeys);
  const lorebookService = new LorebookService(users, lorebookRepo, embeddingService, lorebookEmbeddingRepo, campaigns);
  const providerKeyService = new ProviderKeyService(users, providerKeys, customEndpoints, runtimeDefaults, env.customEndpointAllowHosts);
  const getChatRuntimeForUser = (userId: string) => options?.chatRuntime
    ?? (env.mockProvider ? createMockChatRuntime() : createChatRuntimeForUser(providerKeys, customEndpoints, userId, runtimeDefaults));
  const getImageRuntimeForUser = (userId: string) => options?.imageRuntime
    ?? (env.mockProvider ? createMockImageGenerationRuntime() : createImageRuntimeForUser(providerKeys, userId, runtimeDefaults));
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
  );
  const pipelineRuntime = options?.pipelineRuntime ?? (env.mockProvider ? null : undefined);
  const inlinePipelineWorker = env.inlineWorkers ? new PipelineWorker(env.dbFile, { runtime: pipelineRuntime, runtimeDefaults }) : null;
  const pipeline = new PipelineService(users, campaigns, campaignVersions, pipelineRuns, sessions, inlinePipelineWorker, pipelineArtifacts, lorebookRepo, embeddingService, lorebookEmbeddingRepo);
  const promptTemplateService = new PromptTemplateService(users, promptTemplates);
  const wizardRuntime = options?.wizardRuntime ?? pipelineRuntime;
  const inlineWizardWorker = env.inlineWorkers ? new WizardWorker(env.dbFile, { runtime: wizardRuntime, runtimeDefaults }) : null;
  const wizard = new WizardService(users, campaigns, sessions, preferences, folders, messages, attachments, pendingAssistantMessages, generatedImages, imageStore, wizardTemplates, wizardRuns, customEndpoints, inlineWizardWorker, lorebookRepo, characterAttire, embeddingService);
  const contextEngine = new ContextEngine(lorebookRepo, lorebookEmbeddingRepo, embeddingService, getChatRuntimeForUser);
  const pipelineQueue = inlinePipelineWorker ? new PipelineQueueService(db, pipelineRuns, () => inlinePipelineWorker.kick()) : null;
  if (inlinePipelineWorker) setTimeout(() => inlinePipelineWorker.kick(), 5000).unref?.();
  if (pipelineQueue) setInterval(() => { if (pipelineQueue.sweepStaleLocks() > 0) inlinePipelineWorker!.kick(); }, 5 * 60 * 1000).unref?.();
  const chat = new ChatService(users, sessions, campaigns, messages, attachments, pendingAssistantMessages, generatedImages, imageStore, wizardTemplates, customEndpoints, getChatRuntimeForUser, contextEngine, pipelineRuns, inlinePipelineWorker ? () => inlinePipelineWorker.kick() : null, pipelineQueue, characterAttire);
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

  const app = express();
  if (env.trustProxy) app.set("trust proxy", 1);
  app.use(createSecurityHeaders(env));
  app.use(createIpAllowlist(env.allowedIps));
  // Auth endpoints are reachable pre-auth — cap their bodies tightly before
  // the global parser (which stays large for attachment/import payloads) so an
  // anonymous caller can't have 100MB buffered + parsed.
  app.use("/api/auth", express.json({ limit: "64kb" }));
  app.use(express.json({ limit: "100mb" }));
  app.use(sessionMiddleware);
  app.use(csrfProtection);
  app.use(createRequestLogger(logger));
  app.use("/api/system", createSystemRoutes());
  app.use("/api/admin", createAdminRoutes(admin, audit, requireAdmin, users));
  app.use("/api/auth", createAuthRoutes(auth, audit, sessionMiddleware.store));
  app.use("/api/account", createAccountRoutes(auth, audit, users, sessionMiddleware.store));
  app.use("/api/campaigns", createCampaignRoutes(campaignService, users));
  app.use("/api/chat", createChatRoutes(chat, users));
  app.use("/api/context", createContextRoutes({ contextEngine, embeddingService, lorebook: lorebookRepo, users, sessions, campaigns, messages }));
  app.use("/api/lorebook", createLorebookRoutes(lorebookService, users));
  app.use("/api/character-attire", createCharacterAttireRoutes(characterAttire, campaigns, users));
  app.use("/api/claude-code", createClaudeCodeRoutes(claudeCodeBridge, audit, requireAdmin, users));
  app.use("/api/codex", createCodexRoutes(codexBridge, audit, requireAdmin, users));
  app.use("/api/images", createImageRoutes(images, users));
  app.use("/api/pipeline", createPipelineRoutes(pipeline, audit, users, pipelineRuns));
  app.use("/api/provider-keys", createProviderKeyRoutes(providerKeyService, audit, users));
  app.use("/api/prompt-templates", createPromptTemplateRoutes(promptTemplateService, users));
  app.use("/api/wizard", createWizardRoutes(wizard, audit, users));
  app.use("/api/workspace", createWorkspaceRoutes(workspace, users));
  app.use("/api/system-events", createSystemEventRoutes(users));
  if (fs.existsSync(env.webDistDir)) {
    app.use(express.static(env.webDistDir));
    app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(env.webDistDir, "index.html"));
    });
  }
  app.use(errorHandler);
  return { app, env, logger };
}
