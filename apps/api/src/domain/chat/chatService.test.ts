import { afterEach, describe, expect, it } from "vitest";

import { createDatabaseClient } from "@tracyhill-rp/db";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { minimalUser } from "@tracyhill-rp/test-fixtures";

import { createSeededTestDb } from "../../test/testDb";
import { CampaignRepository } from "../campaigns/campaignRepository";
import { GeneratedImageRepository } from "../images/generatedImageRepository";
import { ImageStore } from "../images/imageStore";
import { CustomEndpointRepository } from "../providerKeys/customEndpointRepository";
import { UserRepository } from "../users/userRepository";
import { SessionRepository } from "../workspace/sessionRepository";
import { WizardTemplateRepository } from "../wizard/wizardTemplateRepository";
import { MessageAttachmentRepository } from "./messageAttachmentRepository";
import { MessageRepository } from "./messageRepository";
import { PendingAssistantMessageRepository } from "./pendingAssistantMessageRepository";
import { ChatService } from "./chatService";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("chat service recovery", () => {
  it("stores disconnected assistant output as pending and merges it once on the next load", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    cleanups.push(() => sqlite.close());
    const now = new Date().toISOString();
    const runtime: ChatRuntime = {
      async streamChat(_input, callbacks) {
        callbacks.onStart();
        callbacks.onThinkingDelta("Reasoning trace.");
        callbacks.onDelta("Recovered with cache.");
        callbacks.onComplete({
          usage: {
            inputTokens: 120,
            outputTokens: 45,
            totalTokens: 165,
            cacheReadTokens: 80,
            cacheWriteTokens: 240,
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
      new ImageStore(seeded.imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );
    const sessions = new SessionRepository(db);
    const messages = new MessageRepository(db);
    const pending = new PendingAssistantMessageRepository(db);

    sessions.createSession({
      id: "session-1",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: null,
      folderId: null,
      name: "Recovery Session",
      modelId: "gpt-5.4",
      thinkingMode: "off",
      thinkingBudget: null,
      effort: "medium",
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      deletedAt: null,
    });

    let connected = true;
    const seenEvents: string[] = [];
    await chat.streamResponse(minimalUser.id, "session-1", {
      prompt: "Recover this reply",
      modelId: "gpt-5.4",
      attachments: [],
    }, "req-1", (event) => {
      seenEvents.push(event.type);
      if (event.type === "response.delta") connected = false;
    }, {
      isClientConnected: () => connected,
    });

    expect(seenEvents).toContain("response.started");
    expect(seenEvents).toContain("response.delta");
    expect(seenEvents).not.toContain("response.completed");
    expect(messages.listForSession(minimalUser.id, "session-1")).toHaveLength(1);
    expect(pending.listForSession(minimalUser.id, "session-1")).toHaveLength(1);

    const recovered = chat.getSessionDetail(minimalUser.id, "session-1");
    expect(recovered.messages).toHaveLength(2);
    expect(recovered.messages[1]?.role).toBe("assistant");
    expect(recovered.messages[1]?.content).toContain("Recovered with cache.");
    expect(recovered.messages[1]?.thinking).toBe("Reasoning trace.");
    expect(recovered.messages[1]?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
      cacheReadTokens: 80,
      cacheWriteTokens: 240,
      reasoningTokens: null,
      speed: null,
    });
    expect(recovered.session.messageCount).toBe(2);
    expect(pending.listForSession(minimalUser.id, "session-1")).toHaveLength(0);

    const secondLoad = chat.getSessionDetail(minimalUser.id, "session-1");
    expect(secondLoad.messages).toHaveLength(2);
    expect(secondLoad.messages[1]?.content).toContain("Recovered with cache.");
    expect(secondLoad.messages[1]?.thinking).toBe("Reasoning trace.");
    expect(secondLoad.messages[1]?.usage?.cacheReadTokens).toBe(80);
    expect(secondLoad.messages[1]?.usage?.cacheWriteTokens).toBe(240);
  });
});

describe("chat service runtime normalization", () => {
  it("persists a stopped assistant message when an active stream is explicitly aborted", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    cleanups.push(() => sqlite.close());
    const now = new Date().toISOString();
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        callbacks.onStart();
        callbacks.onDelta("Partial reply");
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => {
            const error = new Error("request aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
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
      new ImageStore(seeded.imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );
    const sessions = new SessionRepository(db);

    sessions.createSession({
      id: "session-stop",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: null,
      folderId: null,
      name: "Stop Session",
      modelId: "gpt-5.4",
      temperature: 1,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: "medium",
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      deletedAt: null,
    });

    const streamPromise = chat.streamResponse(minimalUser.id, "session-stop", {
      prompt: "Stop this reply",
      modelId: "gpt-5.4",
      attachments: [],
    }, "req-stop", () => {}, {
      isClientConnected: () => true,
    });

    expect(chat.stopResponse(minimalUser.id, "session-stop", "req-stop")).toBe(true);
    await streamPromise;

    const detail = chat.getSessionDetail(minimalUser.id, "session-stop");
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1]?.role).toBe("assistant");
    expect(detail.messages[1]?.content).toBe("Partial reply\n\n*[Stopped]*");
    expect(detail.messages[1]?.thinking).toBeNull();
  });

  it("coalesces consecutive same-role messages before runtime dispatch", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    cleanups.push(() => sqlite.close());
    const now = new Date().toISOString();
    const captured: Array<{ role: string; content: string; attachments: Array<{ filename: string }> }> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        captured.push(...input.messages.map((message) => ({
          role: message.role,
          content: message.content,
          attachments: (message.attachments ?? []).map((attachment) => ({ filename: attachment.filename })),
        })));
        callbacks.onStart();
        callbacks.onDelta("Merged.");
        callbacks.onComplete({
          usage: {
            inputTokens: 9,
            outputTokens: 3,
            totalTokens: 12,
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
      new ImageStore(seeded.imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );
    const sessions = new SessionRepository(db);
    const messages = new MessageRepository(db);

    sessions.createSession({
      id: "session-merge",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: null,
      folderId: null,
      name: "Merge Session",
      modelId: "gpt-5.4",
      thinkingMode: "off",
      thinkingBudget: null,
      effort: "medium",
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 4,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      deletedAt: null,
    });
    messages.createMessage({
      id: "msg-user-1",
      sessionId: "session-merge",
      userId: minimalUser.id,
      role: "user",
      content: "Opening move",
      modelId: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    messages.createMessage({
      id: "msg-user-2",
      sessionId: "session-merge",
      userId: minimalUser.id,
      role: "user",
      content: "Second move",
      modelId: null,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
    messages.createMessage({
      id: "msg-assistant-1",
      sessionId: "session-merge",
      userId: minimalUser.id,
      role: "assistant",
      content: "Reply one",
      modelId: "gpt-5.4",
      sortOrder: 2,
      createdAt: now,
      updatedAt: now,
    });
    messages.createMessage({
      id: "msg-assistant-2",
      sessionId: "session-merge",
      userId: minimalUser.id,
      role: "assistant",
      content: "Reply two",
      modelId: "gpt-5.4",
      sortOrder: 3,
      createdAt: now,
      updatedAt: now,
    });

    await chat.streamResponse(minimalUser.id, "session-merge", {
      prompt: "Latest move",
      modelId: "gpt-5.4",
      attachments: [],
    }, "req-merge", () => {});

    expect(captured).toEqual([
      {
        role: "user",
        content: "Opening move\n\nSecond move",
        attachments: [],
      },
      {
        role: "assistant",
        content: "Reply one\n\nReply two",
        attachments: [],
      },
      {
        role: "user",
        content: "Latest move",
        attachments: [],
      },
    ]);
  });

  it("preserves provider turn boundaries for consecutive user messages when attachments are present", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    cleanups.push(() => sqlite.close());
    const now = new Date().toISOString();
    const captured: Array<{ role: string; content: string; attachments: Array<{ filename: string }> }> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        captured.push(...input.messages.map((message) => ({
          role: message.role,
          content: message.content,
          attachments: (message.attachments ?? []).map((attachment) => ({ filename: attachment.filename })),
        })));
        callbacks.onStart();
        callbacks.onDelta("Boundaries.");
        callbacks.onComplete({
          usage: {
            inputTokens: 11,
            outputTokens: 4,
            totalTokens: 15,
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
      new ImageStore(seeded.imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );
    const sessions = new SessionRepository(db);
    const messages = new MessageRepository(db);
    const attachments = new MessageAttachmentRepository(db);

    sessions.createSession({
      id: "session-boundaries",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: null,
      folderId: null,
      name: "Boundary Session",
      modelId: "gpt-5.4",
      temperature: 1,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: "medium",
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 2,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      deletedAt: null,
    });
    messages.createMessage({
      id: "msg-user-media",
      sessionId: "session-boundaries",
      userId: minimalUser.id,
      role: "user",
      content: "Prompt with image",
      modelId: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    attachments.createAttachment({
      id: "att-user-media",
      messageId: "msg-user-media",
      sessionId: "session-boundaries",
      userId: minimalUser.id,
      filename: "portrait.png",
      mimeType: "image/png",
      contentMode: "base64",
      content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII=",
      createdAt: now,
    });
    messages.createMessage({
      id: "msg-user-text",
      sessionId: "session-boundaries",
      userId: minimalUser.id,
      role: "user",
      content: "Follow-up text",
      modelId: null,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });

    await chat.streamResponse(minimalUser.id, "session-boundaries", {
      prompt: "Latest move",
      modelId: "gpt-5.4",
      attachments: [],
    }, "req-boundaries", () => {}, {
      isClientConnected: () => true,
    });

    expect(captured).toEqual([
      {
        role: "user",
        content: "Prompt with image",
        attachments: [{ filename: "portrait.png" }],
      },
      {
        role: "user",
        content: "Follow-up text\n\nLatest move",
        attachments: [],
      },
    ]);
  });

  it("strips replay-only transport markers and skips persisted meta messages before runtime dispatch", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    cleanups.push(() => sqlite.close());
    const now = new Date().toISOString();
    const captured: Array<{ role: string; content: string }> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        captured.push(...input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })));
        callbacks.onStart();
        callbacks.onDelta("Clean.");
        callbacks.onComplete({
          usage: {
            inputTokens: 7,
            outputTokens: 2,
            totalTokens: 9,
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
      new ImageStore(seeded.imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );
    const sessions = new SessionRepository(db);
    const messages = new MessageRepository(db);

    sessions.createSession({
      id: "session-sanitize",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: null,
      folderId: null,
      name: "Sanitize Session",
      modelId: "gpt-5.4",
      thinkingMode: "off",
      thinkingBudget: null,
      effort: "medium",
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 4,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      deletedAt: null,
    });
    messages.createMessage({
      id: "msg-user-a",
      sessionId: "session-sanitize",
      userId: minimalUser.id,
      role: "user",
      content: "Prompt one",
      modelId: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    messages.createMessage({
      id: "msg-assistant-a",
      sessionId: "session-sanitize",
      userId: minimalUser.id,
      role: "assistant",
      content: "Reply one\n\n*[Stopped]*",
      modelId: "gpt-5.4",
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
    messages.createMessage({
      id: "msg-assistant-b",
      sessionId: "session-sanitize",
      userId: minimalUser.id,
      role: "assistant",
      content: "**API Error:** upstream timeout",
      modelId: "gpt-5.4",
      sortOrder: 2,
      createdAt: now,
      updatedAt: now,
    });
    messages.createMessage({
      id: "msg-user-b",
      sessionId: "session-sanitize",
      userId: minimalUser.id,
      role: "user",
      content: "Prompt two",
      modelId: null,
      sortOrder: 3,
      createdAt: now,
      updatedAt: now,
    });

    await chat.streamResponse(minimalUser.id, "session-sanitize", {
      prompt: "Prompt three",
      modelId: "gpt-5.4",
      attachments: [],
    }, "req-sanitize", () => {}, {
      isClientConnected: () => true,
    });

    expect(captured).toEqual([
      { role: "user", content: "Prompt one" },
      { role: "assistant", content: "Reply one" },
      { role: "user", content: "Prompt two\n\nPrompt three" },
    ]);
  });

  it("appends the v1 truncation warning when the runtime reports a max-output cutoff", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    cleanups.push(() => sqlite.close());
    const now = new Date().toISOString();
    const runtime: ChatRuntime = {
      async streamChat(_input, callbacks) {
        callbacks.onStart();
        callbacks.onDelta("Long reply");
        callbacks.onComplete({
          usage: {
            inputTokens: 90,
            outputTokens: 128000,
            totalTokens: 128090,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
            speed: null,
          },
          outputTruncated: true,
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
      new ImageStore(seeded.imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );
    const sessions = new SessionRepository(db);

    sessions.createSession({
      id: "session-truncated",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: null,
      folderId: null,
      name: "Truncated Session",
      modelId: "gpt-5.4",
      temperature: 1,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: "medium",
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      deletedAt: null,
    });

    await chat.streamResponse(minimalUser.id, "session-truncated", {
      prompt: "Give me the full answer",
      modelId: "gpt-5.4",
      attachments: [],
    }, "req-truncated", () => {}, {
      isClientConnected: () => true,
    });

    const detail = chat.getSessionDetail(minimalUser.id, "session-truncated");
    expect(detail.messages[1]?.content).toBe("Long reply\n\n---\n\n**⚠ Output truncated** — hit the model's max output token limit (128,000). The response was cut off.");
  });

  it("forwards the persisted session temperature to the runtime", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    cleanups.push(() => sqlite.close());
    const now = new Date().toISOString();
    const seen: Array<number | null | undefined> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        seen.push(input.temperature);
        callbacks.onStart();
        callbacks.onDelta("Temp.");
        callbacks.onComplete({
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            totalTokens: 7,
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
      new ImageStore(seeded.imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );
    const sessions = new SessionRepository(db);

    sessions.createSession({
      id: "session-temp",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: null,
      folderId: null,
      name: "Temp Session",
      modelId: "gpt-4.1",
      temperature: 0.55,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: "medium",
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      deletedAt: null,
    });

    await chat.streamResponse(minimalUser.id, "session-temp", {
      prompt: "Send with temp",
      modelId: "gpt-4.1",
      attachments: [],
    }, "req-temp", () => {}, {
      isClientConnected: () => true,
    });

    expect(seen).toEqual([0.55]);
  });

  it("uses the v1 campaign runtime system-prompt shape for campaign-backed sessions", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    cleanups.push(() => sqlite.close());
    const now = new Date().toISOString();
    const seen: Array<string | null | undefined> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        seen.push(input.systemPrompt);
        callbacks.onStart();
        callbacks.onDelta("Campaign.");
        callbacks.onComplete({
          usage: {
            inputTokens: 8,
            outputTokens: 2,
            totalTokens: 10,
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
      new ImageStore(seeded.imageDir),
      new WizardTemplateRepository(db),
      new CustomEndpointRepository(db),
      () => runtime,
    );
    const sessions = new SessionRepository(db);
    const campaigns = new CampaignRepository(db);

    campaigns.createCampaign({
      id: "campaign-runtime",
      userId: minimalUser.id,
      name: "Campaign Runtime",
      folderId: null,
      systemPrompt: "Keep the tone severe.",
      version: 3,
      pipelineModelId: "claude-opus-4-6",
      createdAt: now,
      updatedAt: now,
    });
    sessions.createSession({
      id: "session-campaign-runtime",
      userId: minimalUser.id,
      sessionType: "standard",
      campaignId: "campaign-runtime",
      folderId: null,
      name: "Campaign Session",
      modelId: "gpt-4.1",
      temperature: 1,
      thinkingMode: "off",
      thinkingBudget: null,
      effort: "medium",
      cacheTtl: "off",
      autoScroll: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
      deletedAt: null,
    });

    await chat.streamResponse(minimalUser.id, "session-campaign-runtime", {
      prompt: "Continue the trek.",
      modelId: "gpt-4.1",
      attachments: [],
    }, "req-campaign-runtime", () => {}, {
      isClientConnected: () => true,
    });

    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("SCENE STATE TRACKING");
    expect(seen[0]).toContain("CHARACTER KNOWLEDGE ENFORCEMENT");
    expect(seen[0]).toContain("<<<TR_CACHE_BOUNDARY>>>\nKeep the tone severe.");
  });
});
