import fs from "node:fs";
import path from "node:path";

import { eq, or } from "drizzle-orm";

import {
  campaignVersions,
  campaigns,
  createDatabaseClient,
  customEndpoints,
  folders,
  generatedImages,
  messageAttachments,
  messages,
  migrateDatabase,
  pendingAssistantMessages,
  pipelineRuns,
  providerKeys,
  sessions,
  userPreferences,
  users,
  wizardTemplates,
} from "@tracyhill-rp/db";
import { customEndpointInputSchema, customEndpointModelSchema } from "@tracyhill-rp/contracts";
import { getChatModel, getDefaultChatModelId } from "@tracyhill-rp/model-catalog";

import { ImageStore } from "../domain/images/imageStore";
import { createDefaultPipelineRunDetails, type StoredPipelineRunStep } from "../domain/pipeline/pipelineRunRepository";

type JsonRecord = Record<string, unknown>;

type V1ImporterOptions = {
  sourceDir: string;
  dbFile?: string;
  imageDir?: string;
  dryRun?: boolean;
  report?: boolean;
};

type V1CustomEndpoint = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: "chat-completions" | "responses";
  authHeader: "Bearer" | "api-key" | "none";
  models: Array<{ id: string; label: string; maxOut: number; ctx: number }>;
};

type ImportedSession = {
  id: string;
  userId: string;
  sessionType: string;
  campaignId: string | null;
  folderId: string | null;
  name: string;
  modelId: string;
  temperature: number;
  thinkingMode: string;
  thinkingBudget: number | null;
  effort: string | null;
  cacheTtl: string;
  systemPrompt: string;
  autoScroll: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  deletedAt: string | null;
  messages: Array<{
    id: string;
    sessionId: string;
    userId: string;
    role: "user" | "assistant";
    content: string;
    thinking: string | null;
    modelId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  }>;
  attachments: Array<{
    id: string;
    messageId: string;
    sessionId: string;
    userId: string;
    filename: string;
    mimeType: string;
    contentMode: "text" | "base64";
    content: string;
    createdAt: string;
  }>;
  generatedImages: Array<{
    id: string;
    messageId: string;
    sessionId: string;
    userId: string;
    prompt: string;
    mimeType: string;
    createdAt: string;
    sourcePath: string | null;
  }>;
};

type ImportedUser = {
  id: string;
  username: string;
  email: string | null;
  emailVerified: number;
  agreedToTerms: number;
  trustedDevices: string;
  role: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  preferences: {
    userId: string;
    activeSessionId: string | null;
    fontSize: number;
    sidebarOpen: number;
    statusBarOpen: number;
    ctrlBarOpen: number;
    updatedAt: string;
  };
  folders: Array<{
    id: string;
    userId: string;
    name: string;
    parentId: string | null;
    position: number;
    collapsed: number;
    createdAt: string;
    updatedAt: string;
  }>;
  sessions: ImportedSession[];
  pendingAssistantMessages: Array<{
    id: string;
    sessionId: string;
    userId: string;
    sourceUserMessageId: string;
    modelId: string;
    content: string;
    thinking: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    stopReason: string | null;
    stopDetailsJson: string | null;
    fastMode: boolean;
    servedModel: string | null;
    sceneData: string | null;
    overheadJson: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  pipelineRuns: Array<{
    id: string;
    userId: string;
    campaignId: string;
    status: "queued" | "running" | "completed" | "failed" | "canceled";
    summary: string | null;
    error: string | null;
    detailsJson: string;
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    approvedAt: string | null;
    updatedAt: string;
  }>;
  campaigns: Array<{
    id: string;
    userId: string;
    name: string;
    folderId: string | null;
    pipelineModelId: string;
    systemPrompt: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  }>;
  campaignVersions: Array<{
    id: string;
    campaignId: string;
    userId: string;
    version: number;
    systemPrompt: string;
    createdAt: string;
  }>;
  wizardTemplates: {
    userId: string;
    exampleSystemPrompt: string;
    updatedAt: string;
  } | null;
  providerKeys: Array<{
    userId: string;
    provider: string;
    apiKey: string;
    createdAt: string;
    updatedAt: string;
  }>;
  customEndpoints: Array<{
    id: string;
    userId: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: string;
    authHeader: string;
    modelsJson: string;
    createdAt: string;
    updatedAt: string;
  }>;
  deferred: {
    pendingFiles: number;
    pipelineFiles: number;
  };
};

export type V1ImportResult = {
  mode: "dry-run" | "import" | "report";
  sourceDir: string;
  dbFile: string | null;
  imageDir: string | null;
  importedAt: string;
  counts: {
    users: number;
    folders: number;
    sessions: number;
    messages: number;
    attachments: number;
    pendingAssistantMessages: number;
    pipelineRuns: number;
    generatedImages: number;
    campaigns: number;
    campaignVersions: number;
    wizardTemplates: number;
    providerKeys: number;
    customEndpoints: number;
  };
  deferred: {
    pendingFiles: number;
    pipelineFiles: number;
  };
  warnings: string[];
  report: V1ImportReport | null;
};

type V1ImportReportSection = {
  sourceCount: number;
  targetCount: number;
  missing: string[];
  extra: string[];
  changed: string[];
};

export type V1ImportReport = {
  matches: boolean;
  sections: {
    users: V1ImportReportSection;
    userPreferences: V1ImportReportSection;
    folders: V1ImportReportSection;
    sessions: V1ImportReportSection;
    messages: V1ImportReportSection;
    attachments: V1ImportReportSection;
    pendingAssistantMessages: V1ImportReportSection;
    pipelineRuns: V1ImportReportSection;
    generatedImages: V1ImportReportSection;
    imageFiles: V1ImportReportSection;
    campaigns: V1ImportReportSection;
    campaignVersions: V1ImportReportSection;
    wizardTemplates: V1ImportReportSection;
    providerKeys: V1ImportReportSection;
    customEndpoints: V1ImportReportSection;
  };
};

const SQLITE_BATCH_SIZE = 100;

export function runV1Import(options: V1ImporterOptions): V1ImportResult {
  const sourceDir = path.resolve(options.sourceDir);
  const importedAt = new Date().toISOString();
  const warnings: string[] = [];
  const data = readSourceData(sourceDir, importedAt, warnings);
  const counts = buildCounts(data.users);
  const deferred = {
    pendingFiles: data.users.reduce((sum, user) => sum + user.deferred.pendingFiles, 0),
    pipelineFiles: data.users.reduce((sum, user) => sum + user.deferred.pipelineFiles, 0),
  };
  const result: V1ImportResult = {
    mode: options.dryRun ? "dry-run" : options.report ? "report" : "import",
    sourceDir,
    dbFile: options.dbFile ? path.resolve(options.dbFile) : null,
    imageDir: options.imageDir ? path.resolve(options.imageDir) : null,
    importedAt,
    counts,
    deferred,
    warnings,
    report: null,
  };
  if (options.dryRun) return result;
  if (options.report) {
    if (!options.dbFile || !options.imageDir) throw new Error("dbFile and imageDir are required for report mode");
    if (!fs.existsSync(options.dbFile)) throw new Error(`dbFile not found: ${options.dbFile}`);
    const { db, sqlite } = createDatabaseClient(options.dbFile);
    try {
      result.report = buildReport(db, data.users, new ImageStore(options.imageDir));
    } finally {
      sqlite.close();
    }
    return result;
  }
  if (!options.dbFile || !options.imageDir) throw new Error("dbFile and imageDir are required for import mode");

  migrateDatabase(options.dbFile);
  const { db, sqlite } = createDatabaseClient(options.dbFile);
  const imageStore = new ImageStore(options.imageDir);
  try {
    const tx = sqlite.transaction(() => {
      for (const importedUser of data.users) {
        for (const existingImage of db.select().from(generatedImages).where(eq(generatedImages.userId, importedUser.id)).all()) {
          imageStore.delete(existingImage.id, existingImage.mimeType);
        }
        db.delete(generatedImages).where(eq(generatedImages.userId, importedUser.id)).run();
        db.delete(messageAttachments).where(eq(messageAttachments.userId, importedUser.id)).run();
        db.delete(pendingAssistantMessages).where(eq(pendingAssistantMessages.userId, importedUser.id)).run();
        db.delete(messages).where(eq(messages.userId, importedUser.id)).run();
        db.delete(sessions).where(eq(sessions.userId, importedUser.id)).run();
        db.delete(pipelineRuns).where(eq(pipelineRuns.userId, importedUser.id)).run();
        db.delete(campaignVersions).where(eq(campaignVersions.userId, importedUser.id)).run();
        db.delete(campaigns).where(eq(campaigns.userId, importedUser.id)).run();
        db.delete(customEndpoints).where(eq(customEndpoints.userId, importedUser.id)).run();
        db.delete(providerKeys).where(eq(providerKeys.userId, importedUser.id)).run();
        db.delete(wizardTemplates).where(eq(wizardTemplates.userId, importedUser.id)).run();
        db.delete(folders).where(eq(folders.userId, importedUser.id)).run();
        db.delete(userPreferences).where(eq(userPreferences.userId, importedUser.id)).run();
        db.delete(users).where(or(eq(users.id, importedUser.id), eq(users.username, importedUser.username))).run();

        db.insert(users).values({
          id: importedUser.id,
          username: importedUser.username,
          email: importedUser.email,
          emailVerified: importedUser.emailVerified,
          agreedToTerms: importedUser.agreedToTerms,
          trustedDevices: importedUser.trustedDevices,
          role: importedUser.role,
          passwordHash: importedUser.passwordHash,
          createdAt: importedUser.createdAt,
          updatedAt: importedUser.updatedAt,
        }).run();
        db.insert(userPreferences).values(importedUser.preferences).run();
        insertRows(db, folders, importedUser.folders);
        insertRows(db, campaigns, importedUser.campaigns);
        insertRows(db, campaignVersions, importedUser.campaignVersions);
        insertRows(db, providerKeys, importedUser.providerKeys);
        insertRows(db, customEndpoints, importedUser.customEndpoints);
        if (importedUser.wizardTemplates) db.insert(wizardTemplates).values(importedUser.wizardTemplates).run();
        insertRows(
          db,
          sessions,
          importedUser.sessions.map(({ messages: _messages, attachments: _attachments, generatedImages: _generatedImages, ...session }) => session),
        );
        const sessionMessages = importedUser.sessions.flatMap((session) => session.messages);
        const sessionAttachments = importedUser.sessions.flatMap((session) => session.attachments);
        const sessionImages = importedUser.sessions.flatMap((session) => session.generatedImages);
        const sessionPending = importedUser.pendingAssistantMessages;
        insertRows(db, messages, sessionMessages);
        insertRows(db, messageAttachments, sessionAttachments);
        insertRows(db, pendingAssistantMessages, sessionPending);
        insertRows(db, pipelineRuns, importedUser.pipelineRuns);
        if (sessionImages.length) {
          insertRows(db, generatedImages, sessionImages.map(({ sourcePath: _sourcePath, ...image }) => image));
          for (const image of sessionImages) {
            if (!image.sourcePath) continue;
            imageStore.write(image.id, image.mimeType, fs.readFileSync(image.sourcePath));
          }
        }
      }
    });
    tx();
  } finally {
    sqlite.close();
  }
  return result;
}

function buildCounts(importedUsers: ImportedUser[]) {
  return {
    users: importedUsers.length,
    folders: importedUsers.reduce((sum, user) => sum + user.folders.length, 0),
    sessions: importedUsers.reduce((sum, user) => sum + user.sessions.length, 0),
    messages: importedUsers.reduce((sum, user) => sum + user.sessions.reduce((inner, session) => inner + session.messages.length, 0), 0),
    attachments: importedUsers.reduce((sum, user) => sum + user.sessions.reduce((inner, session) => inner + session.attachments.length, 0), 0),
    pendingAssistantMessages: importedUsers.reduce((sum, user) => sum + user.pendingAssistantMessages.length, 0),
    pipelineRuns: importedUsers.reduce((sum, user) => sum + user.pipelineRuns.length, 0),
    generatedImages: importedUsers.reduce((sum, user) => sum + user.sessions.reduce((inner, session) => inner + session.generatedImages.length, 0), 0),
    campaigns: importedUsers.reduce((sum, user) => sum + user.campaigns.length, 0),
    campaignVersions: importedUsers.reduce((sum, user) => sum + user.campaignVersions.length, 0),
    wizardTemplates: importedUsers.filter((user) => user.wizardTemplates).length,
    providerKeys: importedUsers.reduce((sum, user) => sum + user.providerKeys.length, 0),
    customEndpoints: importedUsers.reduce((sum, user) => sum + user.customEndpoints.length, 0),
  };
}

function buildReport(db: ReturnType<typeof createDatabaseClient>["db"], importedUsers: ImportedUser[], imageStore: ImageStore): V1ImportReport {
  const sourceUsers = new Map(importedUsers.map((user) => [user.id, stableStringify({
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    agreedToTerms: user.agreedToTerms,
    trustedDevices: user.trustedDevices,
    role: user.role,
    passwordHash: user.passwordHash,
  })]));
  const sourcePreferences = new Map(importedUsers.map((user) => [user.preferences.userId, stableStringify(user.preferences)]));
  const sourceFolders = new Map(importedUsers.flatMap((user) => user.folders.map((folder) => [folder.id, stableStringify(folder)] as const)));
  const sourceSessions = new Map(importedUsers.flatMap((user) => user.sessions.map((session) => [session.id, stableStringify({
    userId: session.userId,
    sessionType: session.sessionType,
    campaignId: session.campaignId,
    folderId: session.folderId,
    name: session.name,
    modelId: session.modelId,
    temperature: session.temperature,
    thinkingMode: session.thinkingMode,
    thinkingBudget: session.thinkingBudget,
    effort: session.effort,
    cacheTtl: session.cacheTtl,
    systemPrompt: session.systemPrompt,
    autoScroll: session.autoScroll,
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    deletedAt: session.deletedAt,
  })] as const)));
  const sourceMessages = new Map(importedUsers.flatMap((user) => user.sessions.flatMap((session) => session.messages.map((message) => [message.id, stableStringify(message)] as const))));
  const sourceAttachments = new Map(importedUsers.flatMap((user) => user.sessions.flatMap((session) => session.attachments.map((attachment) => [attachment.id, stableStringify(attachment)] as const))));
  const sourcePendingAssistantMessages = new Map(importedUsers.flatMap((user) => user.pendingAssistantMessages.map((message) => [message.id, stableStringify(message)] as const)));
  const sourcePipelineRuns = new Map(importedUsers.flatMap((user) => user.pipelineRuns.map((run) => [run.id, stableStringify({
    id: run.id,
    userId: run.userId,
    campaignId: run.campaignId,
    status: run.status,
    summary: run.summary,
    error: run.error,
    detailsJson: run.detailsJson,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    approvedAt: run.approvedAt,
    updatedAt: run.updatedAt,
  })] as const)));
  const sourceGeneratedImages = new Map(importedUsers.flatMap((user) => user.sessions.flatMap((session) => session.generatedImages.map((image) => [image.id, stableStringify({
    id: image.id,
    messageId: image.messageId,
    sessionId: image.sessionId,
    userId: image.userId,
    prompt: image.prompt,
    mimeType: image.mimeType,
    createdAt: image.createdAt,
  })] as const))));
  const sourceImageFiles = new Map(importedUsers.flatMap((user) => user.sessions.flatMap((session) => session.generatedImages.map((image) => [image.id, stableStringify({
    filePath: imageStore.getFilePath(image.id, image.mimeType),
    mimeType: image.mimeType,
    exists: true,
  })] as const))));
  const sourceCampaigns = new Map(importedUsers.flatMap((user) => user.campaigns.map((campaign) => [campaign.id, stableStringify(campaign)] as const)));
  const sourceCampaignVersions = new Map(importedUsers.flatMap((user) => user.campaignVersions.map((campaignVersion) => [campaignVersion.id, stableStringify(campaignVersion)] as const)));
  const sourceWizardTemplates = new Map(importedUsers.flatMap((user) => user.wizardTemplates ? [[user.wizardTemplates.userId, stableStringify({
    userId: user.wizardTemplates.userId,
    exampleSystemPrompt: user.wizardTemplates.exampleSystemPrompt,
  })] as const] : []));
  const sourceProviderKeys = new Map(importedUsers.flatMap((user) => user.providerKeys.map((providerKey) => [`${providerKey.userId}:${providerKey.provider}`, stableStringify({
    userId: providerKey.userId,
    provider: providerKey.provider,
    apiKey: providerKey.apiKey,
  })] as const)));
  const sourceCustomEndpoints = new Map(importedUsers.flatMap((user) => user.customEndpoints.map((endpoint) => [endpoint.id, stableStringify({
    id: endpoint.id,
    userId: endpoint.userId,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    apiFormat: endpoint.apiFormat,
    authHeader: endpoint.authHeader,
    modelsJson: endpoint.modelsJson,
  })] as const)));

  const targetUsers = new Map(db.select().from(users).all().map((user) => [user.id, stableStringify({
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    agreedToTerms: user.agreedToTerms,
    trustedDevices: user.trustedDevices,
    role: user.role,
    passwordHash: user.passwordHash,
  })] as const));
  const targetPreferences = new Map(db.select().from(userPreferences).all().map((preference) => [preference.userId, stableStringify(preference)] as const));
  const targetFolders = new Map(db.select().from(folders).all().map((folder) => [folder.id, stableStringify(folder)] as const));
  const targetSessions = new Map(db.select().from(sessions).all().map((session) => [session.id, stableStringify({
    userId: session.userId,
    sessionType: session.sessionType,
    campaignId: session.campaignId,
    folderId: session.folderId,
    name: session.name,
    modelId: session.modelId,
    temperature: session.temperature,
    thinkingMode: session.thinkingMode,
    thinkingBudget: session.thinkingBudget,
    effort: session.effort,
    cacheTtl: session.cacheTtl,
    systemPrompt: session.systemPrompt,
    autoScroll: session.autoScroll,
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    deletedAt: session.deletedAt,
  })] as const));
  const targetMessages = new Map(db.select().from(messages).all().map((message) => [message.id, stableStringify({
    id: message.id,
    sessionId: message.sessionId,
    userId: message.userId,
    role: message.role,
    content: message.content,
    thinking: message.thinking,
    modelId: message.modelId,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
    totalTokens: message.totalTokens,
    cacheReadTokens: message.cacheReadTokens,
    cacheWriteTokens: message.cacheWriteTokens,
    sortOrder: message.sortOrder,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  })] as const));
  const targetAttachments = new Map(db.select().from(messageAttachments).all().map((attachment) => [attachment.id, stableStringify(attachment)] as const));
  const targetPendingAssistantMessages = new Map(db.select().from(pendingAssistantMessages).all().map((message) => [message.id, stableStringify(message)] as const));
  const targetPipelineRuns = new Map(db.select().from(pipelineRuns).all().map((run) => [run.id, stableStringify({
    id: run.id,
    userId: run.userId,
    campaignId: run.campaignId,
    status: run.status,
    summary: run.summary,
    error: run.error,
    detailsJson: run.detailsJson ?? "",
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    approvedAt: run.approvedAt,
    updatedAt: run.updatedAt,
  })] as const));
  const targetGeneratedImages = new Map(db.select().from(generatedImages).all().map((image) => [image.id, stableStringify(image)] as const));
  const targetImageFiles = new Map(db.select().from(generatedImages).all().map((image) => [image.id, stableStringify({
    filePath: imageStore.getFilePath(image.id, image.mimeType),
    mimeType: image.mimeType,
    exists: fs.existsSync(imageStore.getFilePath(image.id, image.mimeType)),
  })] as const));
  const targetCampaigns = new Map(db.select().from(campaigns).all().map((campaign) => [campaign.id, stableStringify({
    id: campaign.id,
    userId: campaign.userId,
    name: campaign.name,
    folderId: campaign.folderId,
    pipelineModelId: campaign.pipelineModelId,
    systemPrompt: campaign.systemPrompt,
    version: campaign.version,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  })] as const));
  const targetCampaignVersions = new Map(db.select().from(campaignVersions).all().map((cv) => [cv.id, stableStringify({
    id: cv.id,
    campaignId: cv.campaignId,
    userId: cv.userId,
    version: cv.version,
    systemPrompt: cv.systemPrompt,
    createdAt: cv.createdAt,
  })] as const));
  const targetWizardTemplates = new Map(db.select().from(wizardTemplates).all().map((template) => [template.userId, stableStringify({
    userId: template.userId,
    exampleSystemPrompt: template.exampleSystemPrompt,
  })] as const));
  const targetProviderKeys = new Map(db.select().from(providerKeys).all().map((providerKey) => [`${providerKey.userId}:${providerKey.provider}`, stableStringify({
    userId: providerKey.userId,
    provider: providerKey.provider,
    apiKey: providerKey.apiKey,
  })] as const));
  const targetCustomEndpoints = new Map(db.select().from(customEndpoints).all().map((endpoint) => [endpoint.id, stableStringify({
    id: endpoint.id,
    userId: endpoint.userId,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    apiFormat: endpoint.apiFormat,
    authHeader: endpoint.authHeader,
    modelsJson: endpoint.modelsJson,
  })] as const));

  const sections = {
    users: compareEntries(sourceUsers, targetUsers),
    userPreferences: compareEntries(sourcePreferences, targetPreferences),
    folders: compareEntries(sourceFolders, targetFolders),
    sessions: compareEntries(sourceSessions, targetSessions),
    messages: compareEntries(sourceMessages, targetMessages),
    attachments: compareEntries(sourceAttachments, targetAttachments),
    pendingAssistantMessages: compareEntries(sourcePendingAssistantMessages, targetPendingAssistantMessages),
    pipelineRuns: compareEntries(sourcePipelineRuns, targetPipelineRuns),
    generatedImages: compareEntries(sourceGeneratedImages, targetGeneratedImages),
    imageFiles: compareEntries(sourceImageFiles, targetImageFiles),
    campaigns: compareEntries(sourceCampaigns, targetCampaigns),
    campaignVersions: compareEntries(sourceCampaignVersions, targetCampaignVersions),
    wizardTemplates: compareEntries(sourceWizardTemplates, targetWizardTemplates),
    providerKeys: compareEntries(sourceProviderKeys, targetProviderKeys),
    customEndpoints: compareEntries(sourceCustomEndpoints, targetCustomEndpoints),
  };
  return {
    matches: Object.values(sections).every((section) => !section.missing.length && !section.extra.length && !section.changed.length),
    sections,
  };
}

function compareEntries(source: Map<string, string>, target: Map<string, string>): V1ImportReportSection {
  const missing = [...source.keys()].filter((key) => !target.has(key)).sort();
  const extra = [...target.keys()].filter((key) => !source.has(key)).sort();
  const changed = [...source.keys()].filter((key) => target.has(key) && target.get(key) !== source.get(key)).sort();
  return {
    sourceCount: source.size,
    targetCount: target.size,
    missing,
    extra,
    changed,
  };
}

function insertRows(db: ReturnType<typeof createDatabaseClient>["db"], table: Parameters<typeof db.insert>[0], rows: unknown[]) {
  if (!rows.length) return;
  for (let index = 0; index < rows.length; index += SQLITE_BATCH_SIZE) {
    db.insert(table).values(rows.slice(index, index + SQLITE_BATCH_SIZE) as never[]).run();
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry));
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = sortJson((value as Record<string, unknown>)[key]);
    return acc;
  }, {});
}

function readSourceData(sourceDir: string, importedAt: string, warnings: string[]) {
  const usersFile = path.join(sourceDir, "users.json");
  if (!fs.existsSync(usersFile)) throw new Error(`users.json not found under ${sourceDir}`);
  const usersJson = readJson<Array<JsonRecord>>(usersFile, []);
  const importedUsers: ImportedUser[] = [];
  for (const sourceUser of usersJson) {
    if (!sourceUser || typeof sourceUser.id !== "string" || typeof sourceUser.username !== "string") {
      warnings.push("Skipped malformed user entry in users.json.");
      continue;
    }
    const userId = sourceUser.id;
    const username = sourceUser.username;
    const userDir = path.join(sourceDir, "users", userId);
    const meta = readJson<JsonRecord>(path.join(userDir, "meta.json"), {});
    const sessionsMeta = readJson<Record<string, JsonRecord>>(path.join(userDir, "sessions_meta.json"), {});
    const campaignsJson = readJson<Array<JsonRecord>>(path.join(userDir, "campaigns.json"), []);
    const wizardTemplatesJson = readJson<JsonRecord | null>(path.join(userDir, "wizard_templates.json"), null);
    const apiKeys = readJson<JsonRecord>(path.join(userDir, "apikeys.json"), {});
    const endpointMap = buildImportedCustomEndpoints(sourceUser.id, apiKeys, importedAt, warnings);
    const campaignIds = new Set(campaignsJson.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []));
    const folderIds = new Set(Array.isArray(meta.folders) ? meta.folders.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as JsonRecord).id === "string" ? [(entry as JsonRecord).id as string] : []) : []);
    const userUpdatedAt = normalizeTimestamp(sourceUser.updatedAt, importedAt);
    const userCreatedAt = normalizeTimestamp(sourceUser.createdAt, userUpdatedAt);
    const importedSessions = buildImportedSessions({
      sourceDir,
      userDir,
      userId,
      sessionsMeta,
      folderIds,
      campaignIds,
      customEndpointIds: new Set(endpointMap.map((endpoint) => endpoint.id)),
      importedAt,
      warnings,
    });
    const importedCampaigns = campaignsJson.flatMap((entry) => buildImportedCampaign(userId, entry, folderIds, new Set(endpointMap.map((endpoint) => endpoint.id)), importedAt, warnings));
    const importedCampaignVersions = importedCampaigns.flatMap((campaign) => buildImportedCampaignVersions(userDir, userId, campaign.id, warnings));
    const activeSessionId = typeof meta.activeId === "string" && importedSessions.some((session) => session.id === meta.activeId) ? meta.activeId : null;
    const importedUser: ImportedUser = {
      id: userId,
      username,
      email: typeof sourceUser.email === "string" && sourceUser.email.trim() ? sourceUser.email.trim() : null,
      emailVerified: truthyNumber(sourceUser.emailVerified),
      agreedToTerms: truthyNumber(sourceUser.agreedToTerms),
      trustedDevices: JSON.stringify(Array.isArray(sourceUser.trustedDevices) ? sourceUser.trustedDevices : []),
      role: typeof sourceUser.role === "string" && sourceUser.role.trim() ? sourceUser.role : "user",
      passwordHash: typeof sourceUser.passwordHash === "string" ? sourceUser.passwordHash : "",
      createdAt: userCreatedAt,
      updatedAt: userUpdatedAt,
      preferences: {
        userId,
        activeSessionId,
        fontSize: normalizeInt(meta.fontSize, 14),
        sidebarOpen: 1,
        statusBarOpen: 1,
        ctrlBarOpen: 1,
        updatedAt: userUpdatedAt,
      },
      folders: Array.isArray(meta.folders)
        ? meta.folders.flatMap((entry, index) => {
            if (!entry || typeof entry !== "object" || typeof (entry as JsonRecord).id !== "string" || typeof (entry as JsonRecord).name !== "string") return [];
            const record = entry as JsonRecord;
            return [{
              id: String(record.id),
              userId,
              name: String(record.name),
              parentId: typeof record.parentId === "string" ? record.parentId : null,
              position: index,
              collapsed: truthyNumber(record.collapsed),
              createdAt: userCreatedAt,
              updatedAt: userUpdatedAt,
            }];
          })
        : [],
      sessions: importedSessions,
      pendingAssistantMessages: buildImportedPendingAssistantMessages(userDir, userId, importedSessions, new Set(endpointMap.map((endpoint) => endpoint.id)), importedAt, warnings),
      pipelineRuns: buildImportedPipelineRuns(userDir, userId, importedCampaigns, importedAt, warnings),
      campaigns: importedCampaigns,
      campaignVersions: importedCampaignVersions,
      wizardTemplates: wizardTemplatesJson && typeof wizardTemplatesJson === "object"
        ? {
            userId,
            exampleSystemPrompt: stringValue(wizardTemplatesJson.exampleSystemPrompt),
            updatedAt: importedAt,
          }
        : null,
      providerKeys: buildImportedProviderKeys(userId, apiKeys, importedAt),
      customEndpoints: endpointMap.map((endpoint) => ({
        id: endpoint.id,
        userId,
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        apiFormat: endpoint.apiFormat,
        authHeader: endpoint.authHeader,
        modelsJson: JSON.stringify(endpoint.models),
        createdAt: importedAt,
        updatedAt: importedAt,
      })),
      deferred: {
        pendingFiles: 0,
        pipelineFiles: 0,
      },
    };
    importedUsers.push(importedUser);
  }
  return { users: importedUsers };
}

function buildImportedSessions(input: {
  sourceDir: string;
  userDir: string;
  userId: string;
  sessionsMeta: Record<string, JsonRecord>;
  folderIds: Set<string>;
  campaignIds: Set<string>;
  customEndpointIds: Set<string>;
  importedAt: string;
  warnings: string[];
}) {
  const sessionsDir = path.join(input.userDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".json")).sort().flatMap((filename) => {
    const sessionJson = readJson<JsonRecord | null>(path.join(sessionsDir, filename), null);
    if (!sessionJson || typeof sessionJson.id !== "string") return [];
    const sessionId = sessionJson.id;
    const meta = input.sessionsMeta[sessionJson.id] ?? {};
    const rawMessages = Array.isArray(sessionJson.messages) ? sessionJson.messages as JsonRecord[] : [];
    const sessionCreatedAt = normalizeTimestamp(sessionJson.createdAt ?? meta.createdAt, input.importedAt);
    const importedMessages = rawMessages.map((message, index) => {
      const createdAt = normalizeTimestamp(message.timestamp, index === 0 ? sessionCreatedAt : input.importedAt);
      const inputTokens = normalizeNullableInt((message.usage as JsonRecord | undefined)?.input);
      const outputTokens = normalizeNullableInt((message.usage as JsonRecord | undefined)?.output);
      return {
        id: `v1msg_${sessionId}_${index}`,
        sessionId,
        userId: input.userId,
        role: normalizeRole(message.role),
        content: typeof message.content === "string" ? message.content : "",
        thinking: typeof message.thinking === "string" && message.thinking ? message.thinking : null,
        modelId: normalizeModelId(typeof message.model === "string" ? message.model : null, input.customEndpointIds, input.warnings, `message ${sessionJson.id}#${index}`),
        inputTokens,
        outputTokens,
        totalTokens: normalizeNullableInt((message.usage as JsonRecord | undefined)?.total) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
        cacheReadTokens: normalizeNullableInt((message.usage as JsonRecord | undefined)?.cacheRead),
        cacheWriteTokens: normalizeNullableInt((message.usage as JsonRecord | undefined)?.cacheCreation),
        sortOrder: index,
        createdAt,
        updatedAt: createdAt,
      };
    });
    const importedAttachments = rawMessages.flatMap((message, messageIndex) => {
      if (!Array.isArray(message.files)) return [];
      const createdAt = importedMessages[messageIndex]?.createdAt ?? sessionCreatedAt;
      return message.files.flatMap((file, fileIndex) => {
        if (!file || typeof file !== "object") return [];
        const record = file as JsonRecord;
        const normalized = normalizeAttachment(record);
        if (!normalized) return [];
        return [{
          id: `v1att_${sessionId}_${messageIndex}_${fileIndex}`,
          messageId: `v1msg_${sessionId}_${messageIndex}`,
          sessionId,
          userId: input.userId,
          filename: normalized.filename,
          mimeType: normalized.mimeType,
          contentMode: normalized.contentMode,
          content: normalized.content,
          createdAt,
        }];
      });
    });
    const importedImages = rawMessages.flatMap((message, messageIndex) => {
      if (typeof message.generatedImage !== "string" || !message.generatedImage.trim()) return [];
      const imageId = message.generatedImage.trim();
      const sourcePath = findSourceImagePath(input.sourceDir, imageId);
      if (!sourcePath) {
        input.warnings.push(`Generated image ${imageId} referenced by session ${sessionId} is missing on disk; skipping image import.`);
        return [];
      }
      const mimeType = mimeTypeFromFilename(sourcePath);
      return [{
        id: imageId,
        messageId: `v1msg_${sessionId}_${messageIndex}`,
        sessionId,
        userId: input.userId,
        prompt: typeof message.content === "string" && message.content.trim() ? message.content.trim() : "Imported image",
        mimeType,
        createdAt: importedMessages[messageIndex]?.createdAt ?? sessionCreatedAt,
        sourcePath,
      }];
    });
    const lastMessageAt = importedMessages[importedMessages.length - 1]?.createdAt ?? normalizeNullableTimestamp(meta.lastActivity);
    const updatedAt = lastMessageAt ?? sessionCreatedAt;
    return [{
      id: sessionId,
      userId: input.userId,
      sessionType: typeof sessionJson.sessionType === "string" && sessionJson.sessionType.trim() ? sessionJson.sessionType : "standard",
      campaignId: typeof sessionJson.campaignId === "string" && input.campaignIds.has(sessionJson.campaignId) ? sessionJson.campaignId : null,
      folderId: typeof sessionJson.folderId === "string" && input.folderIds.has(sessionJson.folderId) ? sessionJson.folderId : null,
      name: typeof sessionJson.name === "string" && sessionJson.name.trim() ? sessionJson.name : stringValue(meta.name, "Imported Session"),
      modelId: normalizeModelId(typeof sessionJson.selectedModel === "string" ? sessionJson.selectedModel : (typeof meta.selectedModel === "string" ? meta.selectedModel : null), input.customEndpointIds, input.warnings, `session ${sessionId}`),
      temperature: normalizeTemperature(sessionJson.temperature),
      thinkingMode: normalizeThinkingMode(sessionJson.thinkingMode),
      thinkingBudget: normalizeNullableInt(sessionJson.thinkingBudget),
      effort: normalizeEffort(sessionJson.effort),
      cacheTtl: normalizeCacheTtl(sessionJson.cacheTTL),
      systemPrompt: stringValue(sessionJson.systemPrompt),
      autoScroll: 0,
      messageCount: importedMessages.length,
      createdAt: sessionCreatedAt,
      updatedAt,
      lastMessageAt,
      deletedAt: normalizeNullableTimestamp(sessionJson.deletedAt ?? meta.deletedAt),
      messages: importedMessages,
      attachments: importedAttachments,
      generatedImages: importedImages,
    }];
  });
}

function buildImportedCampaign(userId: string, campaign: JsonRecord, folderIds: Set<string>, customEndpointIds: Set<string>, importedAt: string, warnings: string[]) {
  if (typeof campaign.id !== "string" || typeof campaign.name !== "string") return [];
  const updatedAt = normalizeTimestamp(campaign.lastUpdated, importedAt);
  return [{
    id: campaign.id,
    userId,
    name: campaign.name.trim() || "Imported Campaign",
    folderId: typeof campaign.folderId === "string" && folderIds.has(campaign.folderId) ? campaign.folderId : null,
    pipelineModelId: normalizeModelId(typeof campaign.pipelineModel === "string" ? campaign.pipelineModel : null, customEndpointIds, warnings, `campaign ${campaign.id}`),
    systemPrompt: stringValue(campaign.systemPrompt),
    version: typeof campaign.stateSeedVersion === "number" ? Math.max(0, Math.trunc(campaign.stateSeedVersion)) : 0,
    createdAt: normalizeTimestamp(campaign.createdAt, updatedAt),
    updatedAt,
  }];
}

function buildImportedPendingAssistantMessages(userDir: string, userId: string, importedSessions: ImportedSession[], customEndpointIds: Set<string>, importedAt: string, warnings: string[]) {
  const pendingDir = path.join(userDir, "pending");
  if (!fs.existsSync(pendingDir)) return [];
  const sessionsById = new Map(importedSessions.map((session) => [session.id, session] as const));
  return fs.readdirSync(pendingDir).filter((name) => name.endsWith(".json")).sort().flatMap((filename) => {
    const sessionId = filename.slice(0, -".json".length);
    const session = sessionsById.get(sessionId);
    if (!session) {
      warnings.push(`Pending assistant message for session ${sessionId} was skipped because the session was not imported.`);
      return [];
    }
    const sourceUserMessageId = [...session.messages].reverse().find((message) => message.role === "user")?.id;
    if (!sourceUserMessageId) {
      warnings.push(`Pending assistant message for session ${sessionId} was skipped because no source user message was available.`);
      return [];
    }
    const pendingJson = readJson<JsonRecord | null>(path.join(pendingDir, filename), null);
    if (!pendingJson || typeof pendingJson.content !== "string") {
      warnings.push(`Pending assistant message for session ${sessionId} was malformed and was skipped.`);
      return [];
    }
    const createdAt = normalizeTimestamp(pendingJson.timestamp, session.lastMessageAt ?? session.updatedAt ?? importedAt);
    const inputTokens = normalizeNullableInt((pendingJson.usage as JsonRecord | undefined)?.input);
    const outputTokens = normalizeNullableInt((pendingJson.usage as JsonRecord | undefined)?.output);
    return [{
      id: `v1pending_${sessionId}`,
      sessionId,
      userId,
      sourceUserMessageId,
      modelId: normalizeModelId(typeof pendingJson.model === "string" ? pendingJson.model : session.modelId, customEndpointIds, warnings, `pending ${sessionId}`),
      content: pendingJson.content,
      thinking: typeof pendingJson.thinking === "string" && pendingJson.thinking ? pendingJson.thinking : null,
      inputTokens,
      outputTokens,
      totalTokens: normalizeNullableInt((pendingJson.usage as JsonRecord | undefined)?.total) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      cacheReadTokens: normalizeNullableInt((pendingJson.usage as JsonRecord | undefined)?.cacheRead),
      cacheWriteTokens: normalizeNullableInt((pendingJson.usage as JsonRecord | undefined)?.cacheCreation),
      reasoningTokens: null,
      // 0058 parity columns — V1 pending files predate these features.
      stopReason: null,
      stopDetailsJson: null,
      fastMode: false,
      servedModel: null,
      sceneData: null,
      overheadJson: null,
      createdAt,
      updatedAt: createdAt,
    }];
  });
}

function buildImportedPipelineRuns(
  userDir: string,
  userId: string,
  importedCampaigns: ImportedUser["campaigns"],
  importedAt: string,
  warnings: string[],
) {
  const pipelinesDir = path.join(userDir, "pipelines");
  if (!fs.existsSync(pipelinesDir)) return [];
  const campaignIds = new Set(importedCampaigns.map((campaign) => campaign.id));
  return fs.readdirSync(pipelinesDir).filter((name) => name.endsWith(".json")).sort().flatMap((filename) => {
    const pipelineJson = readJson<JsonRecord | null>(path.join(pipelinesDir, filename), null);
    if (!pipelineJson || typeof pipelineJson.id !== "string" || typeof pipelineJson.campaignId !== "string") {
      warnings.push(`Pipeline file ${filename} was skipped because it was missing an id or campaignId.`);
      return [];
    }
    if (!campaignIds.has(pipelineJson.campaignId)) {
      warnings.push(`Pipeline file ${filename} was skipped because campaign ${pipelineJson.campaignId} was not imported.`);
      return [];
    }
    const status = normalizePipelineRunStatus(pipelineJson.status);
    const requestedAt = normalizeTimestamp(pipelineJson.requestedAt ?? pipelineJson.createdAt, importedAt);
    const updatedAt = normalizeTimestamp(pipelineJson.updatedAt ?? pipelineJson.completedAt ?? pipelineJson.startedAt ?? requestedAt, requestedAt);
    const startedAt = normalizeNullableTimestamp(pipelineJson.startedAt) ?? (status !== "queued" ? requestedAt : null);
    const completedAt = normalizeNullableTimestamp(pipelineJson.completedAt) ?? (status === "completed" || status === "failed" || status === "canceled" ? updatedAt : null);
    const approvedAt = normalizeNullableTimestamp(pipelineJson.approvedAt);
    const details = createDefaultPipelineRunDetails();
    details.steps.analysis = buildImportedPipelineStep(pipelineJson.step1);
    details.steps.syspromptUpdate = buildImportedPipelineStep(pipelineJson.step3);
    details.review.systemPromptDraft = nullableString((pipelineJson.step3 as JsonRecord | undefined)?.appliedResult);
    details.review.retriedFromRunId = nullableString(pipelineJson.retriedFromRunId);
    details.review.approvedSessionId = nullableString(pipelineJson.approvedSessionId ?? pipelineJson.startedSessionId);
    return [{
      id: pipelineJson.id,
      userId,
      campaignId: pipelineJson.campaignId,
      status,
      summary: nullableString(pipelineJson.summary) ?? defaultPipelineSummary(status),
      error: nullableString(pipelineJson.error) ?? (status === "failed" || status === "canceled" ? defaultPipelineSummary(status) : null),
      detailsJson: JSON.stringify(details),
      requestedAt,
      startedAt,
      completedAt,
      approvedAt,
      updatedAt,
    }];
  });
}

function buildImportedPipelineStep(value: unknown): StoredPipelineRunStep {
  const record = value && typeof value === "object" ? value as JsonRecord : {};
  return {
    status: normalizePipelineStepStatus(record.status),
    result: nullableString(record.result),
    error: nullableString(record.error),
  };
}

function buildImportedCampaignVersions(userDir: string, userId: string, campaignId: string, warnings: string[]) {
  const versionsDir = path.join(userDir, "campaign_versions", campaignId);
  const manifest = readJson<Array<JsonRecord>>(path.join(versionsDir, "manifest.json"), []);
  return manifest.flatMap((entry) => {
    if (typeof entry.version !== "number") return [];
    const version = Math.max(0, Math.trunc(entry.version));
    const systemPrompt = readOptionalText(path.join(versionsDir, `system_prompt_v${version}.md`));
    if (!systemPrompt) warnings.push(`Campaign version ${campaignId} v${version} has no archived system prompt; importing an empty archive row.`);
    return [{
      id: `v1cv_${campaignId}_${version}`,
      campaignId,
      userId,
      version,
      systemPrompt,
      createdAt: normalizeTimestamp(entry.timestamp, new Date().toISOString()),
    }];
  });
}

function buildImportedProviderKeys(userId: string, apiKeys: JsonRecord, importedAt: string) {
  return ["anthropic", "deepseek", "google", "openai", "xai", "zai"].flatMap((provider) => {
    const value = typeof apiKeys[provider] === "string" ? apiKeys[provider].trim() : "";
    if (!value) return [];
    return [{
      userId,
      provider,
      apiKey: value,
      createdAt: importedAt,
      updatedAt: importedAt,
    }];
  });
}

function buildImportedCustomEndpoints(userId: string, apiKeys: JsonRecord, importedAt: string, warnings: string[]): V1CustomEndpoint[] {
  if (!Array.isArray(apiKeys.customEndpoints)) return [];
  return apiKeys.customEndpoints.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as JsonRecord;
    const candidate = customEndpointInputSchema.safeParse({
      id: record.id,
      name: record.name,
      baseUrl: record.baseUrl,
      apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
      apiFormat: record.apiFormat,
      authHeader: record.authHeader,
      models: Array.isArray(record.models) ? record.models.flatMap((model: unknown) => {
        const parsed = customEndpointModelSchema.safeParse(model);
        return parsed.success ? [parsed.data] : [];
      }) : [],
    });
    if (!candidate.success) {
      warnings.push(`Skipped malformed custom endpoint for user ${userId}.`);
      return [];
    }
    return [{
      id: candidate.data.id ?? `ep_imported_${importedAt.replace(/[^0-9]/g, "").slice(-8)}`,
      name: candidate.data.name,
      baseUrl: candidate.data.baseUrl,
      apiKey: candidate.data.apiKey ?? "",
      apiFormat: candidate.data.apiFormat,
      authHeader: candidate.data.authHeader,
      models: candidate.data.models.map((model) => ({
        id: model.id,
        label: model.label || model.id,
        maxOut: model.maxOut,
        ctx: model.ctx,
      })),
    }];
  });
}

// Retired/renamed ids -> current catalog successors (mirrors migration 0060) so
// V1 imports never mint dead model ids.
const LEGACY_MODEL_REMAPS: Record<string, string> = {
  "grok-4.20-reasoning": "grok-4.20-0309-reasoning",
  "grok-4.20-non-reasoning": "grok-4.20-0309-non-reasoning",
  "grok-4.20-beta-0309-reasoning": "grok-4.20-0309-reasoning",
  "grok-4.20-beta-0309-non-reasoning": "grok-4.20-0309-non-reasoning",
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "grok-4": "grok-4.3",
  "grok-4-fast-reasoning": "grok-4.3",
  "grok-4-fast-non-reasoning": "grok-4.3",
  "grok-4-1-fast-reasoning": "grok-4.3",
  "grok-4-1-fast-non-reasoning": "grok-4.3",
  "grok-3": "grok-4.3",
  "grok-3-mini": "grok-4.3",
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-flash",
  "o3": "gpt-5.4",
  "o4-mini": "gpt-5.4-mini",
  "gpt-4.1-nano": "gpt-5.4-nano",
  "gpt-5-5": "gpt-5.5",
};

function normalizeModelId(modelId: string | null, customEndpointIds: Set<string>, warnings: string[], label: string) {
  const trimmed = (modelId ?? "").trim();
  if (!trimmed) return getDefaultChatModelId();
  const normalized = LEGACY_MODEL_REMAPS[trimmed] ?? trimmed;
  if (getChatModel(normalized)) return normalized;
  const customMatch = /^custom:([^:]+):(.+)$/.exec(normalized);
  if (customMatch && customEndpointIds.has(customMatch[1]!)) return normalized;
  warnings.push(`Unsupported model '${trimmed}' on ${label}; defaulted to ${getDefaultChatModelId()}.`);
  return getDefaultChatModelId();
}

function normalizeAttachment(file: JsonRecord) {
  const filename = typeof file.name === "string" && file.name.trim() ? file.name.trim() : "attachment";
  const kind = typeof file.kind === "string" ? file.kind : "text";
  if (kind === "text") return { filename, mimeType: guessTextMimeType(filename), contentMode: "text" as const, content: stringValue(file.content) };
  if (kind === "image") return { filename, mimeType: typeof file.mimeType === "string" && file.mimeType ? file.mimeType : mimeTypeFromFilename(filename), contentMode: "base64" as const, content: stringValue(file.data) };
  if (kind === "pdf") return { filename, mimeType: "application/pdf", contentMode: "base64" as const, content: stringValue(file.data) };
  return null;
}

function normalizeRole(value: unknown): "user" | "assistant" {
  return value === "user" ? "user" : "assistant";
}

function normalizeThinkingMode(value: unknown): "off" | "enabled" | "adaptive" {
  return value === "adaptive" || value === "enabled" ? value : "off";
}

function normalizeEffort(value: unknown): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  return null;
}

function normalizeCacheTtl(value: unknown): "off" | "5m" | "1h" {
  return value === "5m" || value === "1h" ? value : "off";
}

function normalizePipelineRunStatus(value: unknown): "queued" | "running" | "completed" | "failed" | "canceled" {
  if (value === "queued" || value === "pending") return "queued";
  if (value === "running" || value === "running_step1" || value === "running_step2" || value === "running_step3") return "running";
  if (value === "complete" || value === "completed" || value === "approved") return "completed";
  if (value === "failed") return "failed";
  if (value === "canceled" || value === "cancelled") return "canceled";
  return "failed";
}

function normalizePipelineStepStatus(value: unknown): StoredPipelineRunStep["status"] {
  if (value === "running") return "running";
  if (value === "complete" || value === "completed") return "completed";
  if (value === "failed") return "failed";
  return "pending";
}


function normalizeTemperature(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(2, value));
}

function normalizeInt(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return fallback;
}

function normalizeNullableInt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function normalizeTimestamp(value: unknown, fallback: string) {
  const parsed = normalizeNullableTimestamp(value);
  return parsed ?? fallback;
}

function normalizeNullableTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const iso = new Date(value).toISOString();
    return iso === "Invalid Date" ? null : iso;
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && /^\d+$/.test(value.trim())) {
      const iso = new Date(asNumber).toISOString();
      return iso === "Invalid Date" ? null : iso;
    }
    const iso = new Date(value).toISOString();
    return iso === "Invalid Date" ? null : iso;
  }
  return null;
}

function truthyNumber(value: unknown) {
  return value ? 1 : 0;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function defaultPipelineSummary(status: "queued" | "running" | "completed" | "failed" | "canceled") {
  if (status === "queued") return "Imported queued pipeline run.";
  if (status === "running") return "Imported running pipeline run.";
  if (status === "completed") return "Imported completed pipeline run.";
  if (status === "canceled") return "Imported canceled pipeline run.";
  return "Imported failed pipeline run.";
}

function guessTextMimeType(filename: string) {
  if (filename.endsWith(".md")) return "text/markdown";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".html")) return "text/html";
  if (filename.endsWith(".css")) return "text/css";
  if (filename.endsWith(".xml")) return "application/xml";
  return "text/plain";
}

function readOptionalText(filePath: string) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function findSourceImagePath(sourceDir: string, imageId: string) {
  const imageDir = path.join(sourceDir, "images");
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bin"]) {
    const candidate = path.join(imageDir, `${imageId}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function mimeTypeFromFilename(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function readJson<T>(filePath: string, fallback: T) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}
