import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";
import { createMockChatRuntime } from "@tracyhill-rp/provider-runtime";
import { minimalUser } from "@tracyhill-rp/test-fixtures";

import { createApp } from "../../app/createApp";
import { createSeededTestDb } from "../../test/testDb";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  while (cleanups.length) cleanups.pop()?.();
});

describe("chat routes", () => {
  it("streams a mocked assistant response and persists both messages", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const runtime: ChatRuntime = {
      async streamChat(_input, callbacks) {
        callbacks.onStart();
        callbacks.onThinkingDelta("Drafting the next move.");
        callbacks.onDelta("Echo: Hello from test");
        callbacks.onComplete({
          usage: {
            inputTokens: 10,
            outputTokens: 21,
            totalTokens: 31,
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
    const { app } = createApp({ chatRuntime: runtime });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const campaign = await agent.post("/api/campaigns").send({
      name: "Ashenmoor",
      systemPrompt: "You are the chronicler of Ashenmoor.",
    }).expect(201);
    const campaignId = String(campaign.body.campaigns[0].id);

    const workspace = await agent.post(`/api/workspace/sessions/from-campaign/${campaignId}`).expect(201);
    const sessionId = String(workspace.body.sessions[0].id);

    const stream = await agent.post(`/api/chat/sessions/${sessionId}/stream`).send({
      prompt: "Hello from test",
      modelId: "grok-4.3",
      attachments: [
        {
          filename: "notes.txt",
          mimeType: "text/plain",
          contentMode: "text",
          content: "Attachment payload",
        },
        {
          filename: "map.png",
          mimeType: "image/png",
          contentMode: "base64",
          content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII=",
        },
      ],
    }).expect(200);
    expect(stream.text).toContain("response.started");
    expect(stream.text).toContain("response.thinking.delta");
    expect(stream.text).toContain("Echo: Hello from test");

    const detail = await agent.get(`/api/chat/sessions/${sessionId}`).expect(200);
    expect(detail.body.session.campaignId).toBe(campaignId);
    expect(detail.body.campaign.name).toBe("Ashenmoor");
    expect(detail.body.campaign.systemPrompt).toBe("You are the chronicler of Ashenmoor.");
    expect(detail.body.messages).toHaveLength(2);
    expect(detail.body.messages[0].content).toBe("Hello from test");
    expect(detail.body.messages[0].attachments).toHaveLength(2);
    expect(detail.body.messages[0].attachments[0].filename).toBe("notes.txt");
    expect(detail.body.messages[0].attachments[1].contentMode).toBe("base64");
    expect(detail.body.messages[1].content).toContain("Echo: Hello from test");
    expect(detail.body.messages[1].thinking).toBe("Drafting the next move.");
    expect(detail.body.messages[1].role).toBe("assistant");
    expect(detail.body.messages[1].modelId).toBe("grok-4.3");
    expect(detail.body.messages[1].usage.inputTokens).toBeGreaterThan(0);
    expect(detail.body.messages[1].usage.outputTokens).toBeGreaterThan(0);
    expect(detail.body.messages[1].usage.totalTokens).toBeGreaterThan(0);

    const exported = await agent.get(`/api/chat/sessions/${sessionId}/export`).expect(200);
    expect(exported.body.filename).toBe("ashenmoor-part-1.md");
    expect(exported.body.mimeType).toBe("text/markdown");
    expect(exported.body.content).toContain("# Ashenmoor Part 1");
    expect(exported.body.content).toContain("## You");
    expect(exported.body.content).toContain("Hello from test");
    expect(exported.body.content).toContain("notes.txt");
    expect(exported.body.content).toContain("map.png");
    expect(exported.body.content).toContain("## Assistant");
  });

  it("updates, truncates, and deletes persisted messages", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp({ chatRuntime: createMockChatRuntime() });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const created = await agent.post("/api/workspace/sessions").send({ name: "Lifecycle Session" }).expect(201);
    const createdSession = created.body.sessions.find((session: { name: string }) => session.name === "Lifecycle Session");
    if (!createdSession) throw new Error("created session not found");
    const sessionId = String(createdSession.id);

    await agent.post(`/api/chat/sessions/${sessionId}/stream`).send({
      prompt: "First draft",
      modelId: "gpt-5.4",
      attachments: [],
    }).expect(200);

    await agent.post(`/api/chat/sessions/${sessionId}/stream`).send({
      prompt: "Second draft",
      modelId: "gpt-5.4",
      attachments: [],
    }).expect(200);

    const before = await agent.get(`/api/chat/sessions/${sessionId}`).expect(200);
    expect(before.body.messages).toHaveLength(4);
    const firstUserId = String(before.body.messages[0].id);
    const firstAssistantId = String(before.body.messages[1].id);

    const updated = await agent.put(`/api/chat/sessions/${sessionId}/messages/${firstUserId}`).send({
      content: "First draft revised",
    }).expect(200);
    expect(updated.body.messages[0].content).toBe("First draft revised");

    const truncated = await agent.post(`/api/chat/sessions/${sessionId}/messages/truncate`).send({
      messageId: firstAssistantId,
    }).expect(200);
    expect(truncated.body.messages).toHaveLength(2);
    expect(truncated.body.session.messageCount).toBe(2);
    expect(truncated.body.messages[1].role).toBe("assistant");

    const deleted = await agent.delete(`/api/chat/sessions/${sessionId}/messages/${firstAssistantId}`).expect(200);
    expect(deleted.body.messages).toHaveLength(1);
    expect(deleted.body.session.messageCount).toBe(1);
    expect(deleted.body.messages[0].content).toBe("First draft revised");
  });

  it("accepts configured custom-endpoint model ids for chat persistence", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp({ chatRuntime: createMockChatRuntime() });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    await agent.put("/api/provider-keys").send({
      customEndpoints: [{
        id: "ep_custom02",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiFormat: "chat-completions",
        authHeader: "Bearer",
        apiKey: "openrouter-secret",
        models: [{
          id: "openrouter/sonnet",
          label: "OpenRouter Sonnet",
          maxOut: 8192,
          ctx: 200000,
        }],
      }],
    }).expect(200);

    const created = await agent.post("/api/workspace/sessions").send({ name: "Custom Runtime Session" }).expect(201);
    const sessionId = String(created.body.sessions[0].id);

    await agent.patch(`/api/workspace/sessions/${sessionId}`).send({
      modelId: "custom:ep_custom02:openrouter/sonnet",
    }).expect(200);

    const stream = await agent.post(`/api/chat/sessions/${sessionId}/stream`).send({
      prompt: "Custom model prompt",
      modelId: "custom:ep_custom02:openrouter/sonnet",
      attachments: [],
    }).expect(200);
    expect(stream.text).toContain("response.started");

    const detail = await agent.get(`/api/chat/sessions/${sessionId}`).expect(200);
    expect(detail.body.messages[1].modelId).toBe("custom:ep_custom02:openrouter/sonnet");
    expect(detail.body.messages[1].content).toContain("Echo: Custom model prompt");
  });

  it("returns a typed inactive result when a stop request targets no active stream", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp({ chatRuntime: createMockChatRuntime() });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const created = await agent.post("/api/workspace/sessions").send({ name: "Stop Route Session" }).expect(201);
    const sessionId = String(created.body.sessions[0].id);
    const stopped = await agent.post(`/api/chat/sessions/${sessionId}/stream/stop`).send({
      requestId: "route-stop-1",
    }).expect(200);
    expect(stopped.body).toEqual({ stopped: false });
  });

  it("keeps stored attachments in later runtime conversation context", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const calls: Array<{ messages: Array<{ role: string; content: string; attachments?: Array<{ filename: string; mimeType: string; contentMode: string; content: string }> }> }> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        calls.push({
          messages: input.messages.map((message) => ({
            role: message.role,
            content: message.content,
            attachments: message.attachments?.map((attachment) => ({ ...attachment })),
          })),
        });
        callbacks.onStart();
        callbacks.onDelta(`Echo: ${input.messages[input.messages.length - 1]?.content ?? ""}`);
        callbacks.onComplete({
          usage: {
            inputTokens: 12,
            outputTokens: 24,
            totalTokens: 36,
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
    const { app } = createApp({ chatRuntime: runtime });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const created = await agent.post("/api/workspace/sessions").send({ name: "Attachment Memory Session" }).expect(201);
    const sessionId = String(created.body.sessions[0].id);

    await agent.post(`/api/chat/sessions/${sessionId}/stream`).send({
      prompt: "First turn with files",
      modelId: "claude-sonnet-4-6",
      attachments: [
        {
          filename: "notes.txt",
          mimeType: "text/plain",
          contentMode: "text",
          content: "The duke fears the harbor.",
        },
        {
          filename: "seal.png",
          mimeType: "image/png",
          contentMode: "base64",
          content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII=",
        },
      ],
    }).expect(200);

    await agent.post(`/api/chat/sessions/${sessionId}/stream`).send({
      prompt: "Second turn should still see them",
      modelId: "claude-sonnet-4-6",
      attachments: [],
    }).expect(200);

    expect(calls).toHaveLength(2);
    const secondCall = calls[1];
    const firstUserMessage = secondCall?.messages.find((message) => message.role === "user" && message.content === "First turn with files");
    expect(firstUserMessage?.attachments).toHaveLength(2);
    expect(firstUserMessage?.attachments?.[0]?.filename).toBe("notes.txt");
    expect(firstUserMessage?.attachments?.[1]?.mimeType).toBe("image/png");
    const secondUserMessage = secondCall?.messages.find((message) => message.role === "user" && message.content === "Second turn should still see them");
    expect(secondUserMessage?.attachments ?? []).toHaveLength(0);
  });
});
