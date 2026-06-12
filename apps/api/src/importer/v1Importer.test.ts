import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEncryptionKey } from "../lib/crypto";

import {
  campaigns,
  createDatabaseClient,
  customEndpoints,
  folders,
  generatedImages,
  messageAttachments,
  messages,
  pendingAssistantMessages,
  pipelineRuns,
  providerKeys,
  sessions,
  userPreferences,
  users,
  wizardTemplates,
} from "@tracyhill-rp/db";
import { createV1ImportFixture, createV1ImportProductionFixture } from "@tracyhill-rp/test-fixtures";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { CampaignService } from "../domain/campaigns/campaignService";
import { CampaignRepository } from "../domain/campaigns/campaignRepository";
import { CampaignVersionRepository } from "../domain/campaigns/campaignVersionRepository";
import { ChatService } from "../domain/chat/chatService";
import { GeneratedImageRepository } from "../domain/images/generatedImageRepository";
import { ImageStore } from "../domain/images/imageStore";
import { CustomEndpointRepository } from "../domain/providerKeys/customEndpointRepository";
import { ProviderKeyRepository } from "../domain/providerKeys/providerKeyRepository";
import { ProviderKeyService } from "../domain/providerKeys/providerKeyService";
import { PipelineRunRepository } from "../domain/pipeline/pipelineRunRepository";
import { PipelineService } from "../domain/pipeline/pipelineService";
import { UserRepository } from "../domain/users/userRepository";
import { MessageAttachmentRepository } from "../domain/chat/messageAttachmentRepository";
import { MessageRepository } from "../domain/chat/messageRepository";
import { PendingAssistantMessageRepository } from "../domain/chat/pendingAssistantMessageRepository";
import { FolderRepository } from "../domain/workspace/folderRepository";
import { SessionRepository } from "../domain/workspace/sessionRepository";
import { UserPreferencesRepository } from "../domain/workspace/userPreferencesRepository";
import { WorkspaceService } from "../domain/workspace/workspaceService";
import { WizardTemplateRepository } from "../domain/wizard/wizardTemplateRepository";
import { runV1Import } from "./v1Importer";

beforeAll(() => { initEncryptionKey("test-secret-for-encryption"); });

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("v1 importer", () => {
  it("supports dry-run plus idempotent import of core v1 data into v2", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-v1-import-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fixture = createV1ImportFixture(dir);
    const dbFile = path.join(dir, "imported.sqlite");
    const imageDir = path.join(dir, "imported-images");

    const dryRun = runV1Import({ sourceDir: fixture.sourceDir, dryRun: true });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.counts.users).toBe(1);
    expect(dryRun.counts.sessions).toBe(2);
    expect(dryRun.counts.messages).toBe(3);
    expect(dryRun.counts.attachments).toBe(2);
    expect(dryRun.counts.pendingAssistantMessages).toBe(1);
    expect(dryRun.counts.pipelineRuns).toBe(1);
    expect(dryRun.counts.generatedImages).toBe(1);
    expect(dryRun.counts.campaigns).toBe(1);
    expect(dryRun.counts.campaignVersions).toBe(1);
    expect(dryRun.counts.providerKeys).toBe(2);
    expect(dryRun.counts.customEndpoints).toBe(1);
    expect(dryRun.deferred.pendingFiles).toBe(0);
    expect(dryRun.deferred.pipelineFiles).toBe(0);

    const imported = runV1Import({ sourceDir: fixture.sourceDir, dbFile, imageDir });
    expect(imported.mode).toBe("import");
    expect(imported.counts.generatedImages).toBe(1);
    expect(imported.report).toBeNull();

    const { db, sqlite } = createDatabaseClient(dbFile);
    cleanups.push(() => sqlite.close());
    expect(db.select().from(users).all()).toHaveLength(1);
    expect(db.select().from(userPreferences).all()).toEqual([expect.objectContaining({
      userId: fixture.userId,
      activeSessionId: fixture.standaloneSessionId,
      fontSize: 16,
    })]);
    expect(db.select().from(folders).all()).toHaveLength(2);
    expect(db.select().from(campaigns).all()).toEqual([expect.objectContaining({
      id: fixture.campaignId,
      pipelineModelId: `custom:${fixture.customEndpointId}:openrouter/sonnet`,
      version: 4,
    })]);
    expect(db.select().from(wizardTemplates).all()).toHaveLength(1);
    expect(db.select().from(providerKeys).all()).toHaveLength(2);
    expect(db.select().from(customEndpoints).all()).toHaveLength(1);
    expect(db.select().from(pipelineRuns).all()).toEqual([expect.objectContaining({
      id: fixture.pipelineRunId,
      campaignId: fixture.campaignId,
      status: "completed",
      summary: "Imported completed pipeline run.",
    })]);
    expect(db.select().from(sessions).all()).toHaveLength(2);
    expect(db.select().from(messages).all()).toHaveLength(3);
    expect(db.select().from(messageAttachments).all()).toHaveLength(2);
    expect(db.select().from(pendingAssistantMessages).all()).toEqual([expect.objectContaining({
      id: `v1pending_${fixture.standaloneSessionId}`,
      sessionId: fixture.standaloneSessionId,
      sourceUserMessageId: "v1msg_session-standalone_0",
      modelId: "gpt-4.1",
      content: "Pending reply",
      outputTokens: 2,
      totalTokens: 3,
    })]);
    expect(db.select().from(generatedImages).all()).toEqual([expect.objectContaining({
      id: fixture.imageId,
      sessionId: fixture.standaloneSessionId,
      messageId: "v1msg_session-standalone_1",
    })]);
    expect(fs.existsSync(path.join(imageDir, `${fixture.imageId}.png`))).toBe(true);

    const importedStandalone = db.select().from(sessions).where(eq(sessions.id, fixture.standaloneSessionId)).get();
    expect(importedStandalone).toEqual(expect.objectContaining({
      systemPrompt: "Standalone prompt context",
      temperature: 0.7,
    }));

    const seenPrompts: Array<string | null | undefined> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        seenPrompts.push(input.systemPrompt);
        callbacks.onStart();
        callbacks.onDelta("Imported.");
        callbacks.onComplete({
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
            speed: null,
          },
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
        });
      },
    };
    const chat = new ChatService(
      new UserRepository(db),
      new SessionRepository(db),
      new CampaignRepository(db),
      new MessageRepository(db),
      new MessageAttachmentRepository(db),
      new PendingAssistantMessageRepository(db),
      new GeneratedImageRepository(db),
      new ImageStore(imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );

    const detail = chat.getSessionDetail(fixture.userId, fixture.standaloneSessionId);
    expect(detail.messages[detail.messages.length - 1]).toEqual(expect.objectContaining({
      id: `v1pending_${fixture.standaloneSessionId}`,
      role: "assistant",
      content: "Pending reply",
    }));
    expect(db.select().from(pendingAssistantMessages).all()).toHaveLength(0);

    await chat.streamResponse(fixture.userId, fixture.standaloneSessionId, {
      prompt: "Continue the standalone import.",
      modelId: "gpt-4.1",
      attachments: [],
    }, "req-import-standalone", () => {}, {
      isClientConnected: () => true,
    });
    expect(seenPrompts).toEqual(["<<<TR_CACHE_BOUNDARY>>>\nStandalone prompt context"]);

    const rerun = runV1Import({ sourceDir: fixture.sourceDir, dbFile, imageDir });
    expect(rerun.counts.sessions).toBe(2);
    expect(db.select().from(users).all()).toHaveLength(1);
    expect(db.select().from(sessions).all()).toHaveLength(2);
    expect(db.select().from(messages).all()).toHaveLength(3);
    expect(db.select().from(messageAttachments).all()).toHaveLength(2);
    expect(db.select().from(pendingAssistantMessages).all()).toHaveLength(1);
    expect(db.select().from(generatedImages).all()).toHaveLength(1);
  });

  it("reports normalized target drift after import", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-v1-report-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fixture = createV1ImportFixture(dir);
    const dbFile = path.join(dir, "imported.sqlite");
    const imageDir = path.join(dir, "imported-images");

    runV1Import({ sourceDir: fixture.sourceDir, dbFile, imageDir });

    const cleanReport = runV1Import({ sourceDir: fixture.sourceDir, dbFile, imageDir, report: true });
    expect(cleanReport.mode).toBe("report");
    expect(cleanReport.report?.matches).toBe(true);
    expect(cleanReport.report?.sections.sessions.changed).toEqual([]);
    expect(cleanReport.report?.sections.pendingAssistantMessages.changed).toEqual([]);
    expect(cleanReport.report?.sections.pipelineRuns.changed).toEqual([]);
    expect(cleanReport.report?.sections.imageFiles.missing).toEqual([]);

    const { db, sqlite } = createDatabaseClient(dbFile);
    cleanups.push(() => sqlite.close());
    db.update(sessions).set({ systemPrompt: "Drifted prompt context" }).where(eq(sessions.id, fixture.standaloneSessionId)).run();
    db.delete(pendingAssistantMessages).where(eq(pendingAssistantMessages.sessionId, fixture.standaloneSessionId)).run();
    db.delete(pipelineRuns).where(eq(pipelineRuns.id, fixture.pipelineRunId)).run();
    fs.rmSync(path.join(imageDir, `${fixture.imageId}.png`), { force: true });

    const driftReport = runV1Import({ sourceDir: fixture.sourceDir, dbFile, imageDir, report: true });
    expect(driftReport.report?.matches).toBe(false);
    expect(driftReport.report?.sections.sessions.changed).toContain(fixture.standaloneSessionId);
    expect(driftReport.report?.sections.pendingAssistantMessages.missing).toContain(`v1pending_${fixture.standaloneSessionId}`);
    expect(driftReport.report?.sections.pipelineRuns.missing).toContain(fixture.pipelineRunId);
    expect(driftReport.report?.sections.imageFiles.changed).toContain(fixture.imageId);
  });

  it("repeats dry-run/import/report cleanly on production-shaped fixture copies", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-v1-production-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fixture = createV1ImportProductionFixture(dir);
    const dbFileA = path.join(dir, "imported-a.sqlite");
    const imageDirA = path.join(dir, "imported-images-a");
    const dbFileB = path.join(dir, "imported-b.sqlite");
    const imageDirB = path.join(dir, "imported-images-b");

    const dryRun = runV1Import({ sourceDir: fixture.sourceDir, dryRun: true });
    expect(dryRun.counts.users).toBe(2);
    expect(dryRun.counts.sessions).toBe(3);
    expect(dryRun.counts.messages).toBe(5);
    expect(dryRun.counts.pendingAssistantMessages).toBe(1);
    expect(dryRun.counts.pipelineRuns).toBe(2);
    expect(dryRun.counts.generatedImages).toBe(2);
    expect(dryRun.counts.campaigns).toBe(2);
    expect(dryRun.counts.campaignVersions).toBe(2);
    expect(dryRun.counts.wizardTemplates).toBe(2);
    expect(dryRun.counts.providerKeys).toBe(4);

    const firstImport = runV1Import({ sourceDir: fixture.sourceDir, dbFile: dbFileA, imageDir: imageDirA });
    expect(firstImport.counts.users).toBe(2);
    expect(firstImport.counts.pipelineRuns).toBe(2);
    const firstReport = runV1Import({ sourceDir: fixture.sourceDir, dbFile: dbFileA, imageDir: imageDirA, report: true });
    expect(firstReport.report?.matches).toBe(true);
    expect(firstReport.report?.sections.users.changed).toEqual([]);
    expect(firstReport.report?.sections.pipelineRuns.changed).toEqual([]);
    expect(firstReport.report?.sections.imageFiles.changed).toEqual([]);

    const secondImport = runV1Import({ sourceDir: fixture.sourceDir, dbFile: dbFileB, imageDir: imageDirB });
    expect(secondImport.counts.users).toBe(2);
    const secondReport = runV1Import({ sourceDir: fixture.sourceDir, dbFile: dbFileB, imageDir: imageDirB, report: true });
    expect(secondReport.report?.matches).toBe(true);

    const rerun = runV1Import({ sourceDir: fixture.sourceDir, dbFile: dbFileA, imageDir: imageDirA });
    expect(rerun.counts.users).toBe(2);
    const rerunReport = runV1Import({ sourceDir: fixture.sourceDir, dbFile: dbFileA, imageDir: imageDirA, report: true });
    expect(rerunReport.report?.matches).toBe(true);

    const { db, sqlite } = createDatabaseClient(dbFileA);
    cleanups.push(() => sqlite.close());
    expect(db.select().from(users).all()).toHaveLength(2);
    expect(db.select().from(campaigns).all()).toHaveLength(2);
    expect(db.select().from(wizardTemplates).all()).toHaveLength(2);
    expect(db.select().from(pipelineRuns).all().map((run) => run.status).sort()).toEqual(["completed", "failed"]);
    expect(fs.existsSync(path.join(imageDirA, `${fixture.imageId}.png`))).toBe(true);
    expect(fs.existsSync(path.join(imageDirA, `${fixture.secondImageId}.bin`))).toBe(true);
  });

  it("verifies imported production-shaped data through core v2 services", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-v1-parity-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fixture = createV1ImportProductionFixture(dir);
    const dbFile = path.join(dir, "imported.sqlite");
    const imageDir = path.join(dir, "imported-images");

    runV1Import({ sourceDir: fixture.sourceDir, dbFile, imageDir });

    const { db, sqlite } = createDatabaseClient(dbFile);
    cleanups.push(() => sqlite.close());
    const usersRepo = new UserRepository(db);
    const preferencesRepo = new UserPreferencesRepository(db);
    const foldersRepo = new FolderRepository(db);
    const sessionsRepo = new SessionRepository(db);
    const campaignsRepo = new CampaignRepository(db);
    const campaignVersionsRepo = new CampaignVersionRepository(db);
    const messagesRepo = new MessageRepository(db);
    const attachmentsRepo = new MessageAttachmentRepository(db);
    const pendingRepo = new PendingAssistantMessageRepository(db);
    const generatedImagesRepo = new GeneratedImageRepository(db);
    const customEndpointsRepo = new CustomEndpointRepository(db);
    const imageStore = new ImageStore(imageDir);

    const workspace = new WorkspaceService(
      usersRepo,
      preferencesRepo,
      foldersRepo,
      sessionsRepo,
      campaignsRepo,
      messagesRepo,
      attachmentsRepo,
      pendingRepo,
      generatedImagesRepo,
      imageStore,
      customEndpointsRepo,
    );
    const campaignService = new CampaignService(
      usersRepo,
      campaignsRepo,
      campaignVersionsRepo,
      customEndpointsRepo,
      foldersRepo,
    );
    const pipelineService = new PipelineService(
      usersRepo,
      campaignsRepo,
      campaignVersionsRepo,
      new PipelineRunRepository(db),
      sessionsRepo,
    );
    const providerKeyService = new ProviderKeyService(
      usersRepo,
      new ProviderKeyRepository(db),
      customEndpointsRepo,
      {
        anthropicApiKey: "",
        claudeCodeBridgeUrl: "",
        claudeCodeBridgeSecret: "",
        deepseekApiKey: "",
        googleApiKey: "",
        openaiApiKey: "",
        xaiApiKey: "",
        xiaomiApiKey: "",
        zaiApiKey: "",
      },
    );

    const workspaceState = workspace.getState(fixture.userId);
    expect(workspaceState.preferences.activeSessionId).toBe(fixture.standaloneSessionId);
    expect(workspaceState.folders.map((folder) => folder.id)).toEqual([fixture.folderRootId, fixture.folderChildId]);
    expect(workspaceState.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fixture.standaloneSessionId,
        folderId: fixture.folderChildId,
        modelId: "gpt-4.1",
      }),
      expect.objectContaining({
        id: fixture.campaignSessionId,
        campaignId: fixture.campaignId,
        modelId: `custom:${fixture.customEndpointId}:openrouter/sonnet`,
      }),
    ]));

    const secondaryWorkspaceState = workspace.getState(fixture.secondUserId);
    expect(secondaryWorkspaceState.preferences.activeSessionId).toBe(fixture.secondSessionId);
    expect(secondaryWorkspaceState.sessions).toEqual([expect.objectContaining({
      id: fixture.secondSessionId,
      campaignId: fixture.secondCampaignId,
      modelId: "claude-opus-4-6",
      cacheTtl: "1h",
      thinkingMode: "adaptive",
      effort: "max",
    })]);

    const listedCampaigns = campaignService.list(fixture.userId);
    expect(listedCampaigns.campaigns).toEqual([expect.objectContaining({
      id: fixture.campaignId,
      folderId: fixture.folderRootId,
      version: 4,
    })]);
    const primaryVersions = campaignService.listVersions(fixture.userId, fixture.campaignId);
    expect(primaryVersions.versions.map((version) => version.version)).toEqual([4, 3]);
    const secondaryVersions = campaignService.listVersions(fixture.secondUserId, fixture.secondCampaignId);
    expect(secondaryVersions.versions.map((version) => version.version)).toEqual([2, 1]);

    const primaryPipelineRuns = pipelineService.listCampaignRuns(fixture.userId, fixture.campaignId);
    expect(primaryPipelineRuns.runs).toEqual([expect.objectContaining({
      id: fixture.pipelineRunId,
      status: "completed",
      review: expect.objectContaining({
        systemPromptDraft: "Applied prompt draft",
      }),
    })]);
    const secondaryPipelineRuns = pipelineService.listCampaignRuns(fixture.secondUserId, fixture.secondCampaignId);
    expect(secondaryPipelineRuns.runs).toEqual([expect.objectContaining({
      id: fixture.secondPipelineRunId,
      status: "failed",
    })]);

    const primaryKeys = providerKeyService.listKeys(fixture.userId);
    expect(primaryKeys.providers.anthropic.source).toBe("user");
    expect(primaryKeys.providers.openai.source).toBe("user");
    expect(primaryKeys.customEndpoints).toEqual([expect.objectContaining({
      id: fixture.customEndpointId,
      name: "Legacy Endpoint",
    })]);
    const secondaryKeys = providerKeyService.listKeys(fixture.secondUserId);
    expect(secondaryKeys.providers.anthropic.source).toBe("user");
    expect(secondaryKeys.providers.google.source).toBe("user");
    expect(secondaryKeys.providers.openai.source).toBe("none");

    const seenPrompts: Array<string | null | undefined> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        seenPrompts.push(input.systemPrompt);
        callbacks.onStart();
        callbacks.onDelta("Imported parity response.");
        callbacks.onComplete({
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
            speed: null,
          },
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
        });
      },
    };
    const chat = new ChatService(
      usersRepo,
      sessionsRepo,
      campaignsRepo,
      messagesRepo,
      attachmentsRepo,
      pendingRepo,
      generatedImagesRepo,
      imageStore,
      new WizardTemplateRepository(db),
      customEndpointsRepo,
      () => runtime,
    );

    const importedStandaloneDetail = chat.getSessionDetail(fixture.userId, fixture.standaloneSessionId);
    expect(importedStandaloneDetail.messages[0]).toEqual(expect.objectContaining({
      id: "v1msg_session-standalone_0",
      attachments: expect.arrayContaining([
        expect.objectContaining({ filename: "notes.md", mimeType: "text/markdown" }),
        expect.objectContaining({ filename: "scene.pdf", mimeType: "application/pdf" }),
      ]),
    }));
    const importedCampaignDetail = chat.getSessionDetail(fixture.secondUserId, fixture.secondSessionId);
    expect(importedCampaignDetail.campaign).toEqual(expect.objectContaining({
      id: fixture.secondCampaignId,
      systemPrompt: "Operations prompt",
    }));
    expect(importedCampaignDetail.messages[1]).toEqual(expect.objectContaining({
      generatedImages: [expect.objectContaining({ id: fixture.secondImageId, mimeType: "image/jpeg" })],
    }));

    await chat.streamResponse(fixture.secondUserId, fixture.secondSessionId, {
      prompt: "Continue imported campaign state.",
      modelId: "claude-opus-4-6",
      attachments: [],
    }, "req-imported-parity", () => {}, {
      isClientConnected: () => true,
    });
    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]).toContain("<<<TR_CACHE_BOUNDARY>>>\nOperations prompt");
    expect(seenPrompts[0]).not.toContain("Operations seed");
  });
});
