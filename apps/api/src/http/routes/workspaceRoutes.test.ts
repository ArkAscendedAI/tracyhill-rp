import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { campaigns, createDatabaseClient, sessions } from "@tracyhill-rp/db";
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

describe("workspace routes", () => {
  it("supports folder and session sidebar lifecycle", async () => {
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

    const initial = await agent.get("/api/workspace").expect(200);
    expect(initial.body.folders).toEqual([]);
    expect(initial.body.sessions).toEqual([]);
    expect(initial.body.preferences.activeSessionId).toBeNull();

    const wizard = await agent.post("/api/workspace/sessions").send({ sessionType: "wizard" }).expect(201);
    expect(wizard.body.sessions[0].sessionType).toBe("wizard");
    expect(wizard.body.sessions[0].name).toBe("Campaign Wizard");
    expect(wizard.body.sessions[0].messageCount).toBe(2);
    const wizardSessionId = String(wizard.body.sessions[0].id);

    await agent.post("/api/workspace/sessions").send({ sessionType: "wizard" }).expect(409);

    const hiddenWizardFromSearch = await agent.get("/api/workspace/search").query({ q: "campaign wizard" }).expect(200);
    expect(hiddenWizardFromSearch.body.results).toEqual([]);

    const discardedWizard = await agent.delete(`/api/workspace/sessions/${wizardSessionId}`).expect(200);
    expect(discardedWizard.body.sessions.some((session: { id: string }) => session.id === wizardSessionId)).toBe(false);

    const folder = await agent.post("/api/workspace/folders").send({ name: "Ashenmoor" }).expect(201);
    expect(folder.body.folders).toHaveLength(1);
    const folderId = String(folder.body.folders[0].id);

    const childFolder = await agent.post("/api/workspace/folders").send({ name: "Archive", parentId: folderId }).expect(201);
    const childFolderId = String(childFolder.body.folders.find((entry: { name: string }) => entry.name === "Archive").id);
    expect(childFolder.body.folders.find((entry: { id: string }) => entry.id === childFolderId)?.parentId).toBe(folderId);

    const grandchildFolder = await agent.post("/api/workspace/folders").send({ name: "Archive Annex", parentId: childFolderId }).expect(201);
    const grandchildFolderId = String(grandchildFolder.body.folders.find((entry: { name: string }) => entry.name === "Archive Annex").id);
    expect(grandchildFolder.body.folders.find((entry: { id: string }) => entry.id === grandchildFolderId)?.parentId).toBe(childFolderId);

    await agent.patch(`/api/workspace/folders/${folderId}`).send({ parentId: grandchildFolderId }).expect(400);

    const campaign = await agent.post("/api/campaigns").send({
      name: "Ashenmoor",
      folderId: childFolderId,
      systemPrompt: "You are the chronicler of Ashenmoor.",
    }).expect(201);
    const campaignId = String(campaign.body.campaigns[0].id);

    const launched = await agent.post(`/api/workspace/sessions/from-campaign/${campaignId}`).expect(201);
    expect(launched.body.sessions).toHaveLength(1);
    expect(launched.body.sessions[0].campaignId).toBe(campaignId);
    expect(launched.body.sessions[0].name).toBe("Ashenmoor Part 1");
    expect(launched.body.sessions[0].folderId).toBe(childFolderId);

    const launchedAgain = await agent.post(`/api/workspace/sessions/from-campaign/${campaignId}`).expect(201);
    expect(launchedAgain.body.sessions[0].name).toBe("Ashenmoor Part 2");

    const session = await agent.post("/api/workspace/sessions").send({ name: "Part 1", folderId: childFolderId }).expect(201);
    expect(session.body.sessions).toHaveLength(3);
    expect(session.body.preferences.activeSessionId).toBe(session.body.sessions[0].id);
    expect(session.body.sessions[0].folderId).toBe(childFolderId);
    expect(session.body.sessions[0].campaignId).toBeNull();
    expect(session.body.sessions[0].modelId).toBe("claude-opus-4-6");
    expect(session.body.sessions[0].temperature).toBe(1);
    expect(session.body.sessions[0].thinkingMode).toBe("adaptive");
    expect(session.body.sessions[0].thinkingBudget).toBe(127999);
    expect(session.body.sessions[0].effort).toBe("max");
    expect(session.body.sessions[0].cacheTtl).toBe("1h");
    expect(session.body.sessions[0].autoScroll).toBe(false);
    const sessionId = String(session.body.sessions[0].id);

    const folderDeleted = await agent.delete(`/api/workspace/folders/${childFolderId}`).expect(200);
    expect(folderDeleted.body.folders).toHaveLength(2);
    expect(folderDeleted.body.folders.find((entry: { id: string }) => entry.id === folderId)?.parentId).toBeNull();
    expect(folderDeleted.body.folders.find((entry: { id: string }) => entry.id === grandchildFolderId)?.parentId).toBe(folderId);
    expect(folderDeleted.body.sessions.find((entry: { id: string }) => entry.id === sessionId)?.folderId).toBe(folderId);
    expect(folderDeleted.body.sessions.find((entry: { id: string; campaignId: string | null; folderId: string | null }) => entry.campaignId === campaignId)?.folderId).toBe(folderId);
    const reloaded = createDatabaseClient(seeded.dbFile);
    expect(reloaded.db.select().from(sessions).where(eq(sessions.id, sessionId)).get()?.folderId).toBe(folderId);
    expect(reloaded.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).get()?.folderId).toBe(folderId);
    reloaded.sqlite.close();

    const renamed = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ name: "Part 1 Revised" }).expect(200);
    expect(renamed.body.sessions[0].name).toBe("Part 1 Revised");

    const updatedModel = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "grok-4.3" }).expect(200);
    expect(updatedModel.body.sessions[0].modelId).toBe("grok-4.3");
    expect(updatedModel.body.sessions[0].temperature).toBe(1);
    expect(updatedModel.body.sessions[0].thinkingMode).toBe("off");
    expect(updatedModel.body.sessions[0].thinkingBudget).toBeNull();
    expect(updatedModel.body.sessions[0].cacheTtl).toBe("off");

    const switchedDeepSeek = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "deepseek-v4-flash" }).expect(200);
    expect(switchedDeepSeek.body.sessions[0].modelId).toBe("deepseek-v4-flash");
    expect(switchedDeepSeek.body.sessions[0].temperature).toBe(1);
    // deepseek branch (2026-06-12): default ON — matches the server-side default
    expect(switchedDeepSeek.body.sessions[0].thinkingMode).toBe("enabled");
    expect(switchedDeepSeek.body.sessions[0].thinkingBudget).toBeNull();
    expect(switchedDeepSeek.body.sessions[0].effort).toBeNull();
    expect(switchedDeepSeek.body.sessions[0].cacheTtl).toBe("off");

    await agent.put("/api/provider-keys").send({
      customEndpoints: [{
        id: "ep_custom01",
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

    const switchedCustom = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "custom:ep_custom01:openrouter/sonnet" }).expect(200);
    expect(switchedCustom.body.sessions[0].modelId).toBe("custom:ep_custom01:openrouter/sonnet");
    expect(switchedCustom.body.sessions[0].temperature).toBe(1);
    expect(switchedCustom.body.sessions[0].thinkingMode).toBe("off");
    expect(switchedCustom.body.sessions[0].thinkingBudget).toBeNull();
    expect(switchedCustom.body.sessions[0].effort).toBeNull();
    expect(switchedCustom.body.sessions[0].cacheTtl).toBe("off");

    const switchedBack = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "claude-sonnet-4-6" }).expect(200);
    expect(switchedBack.body.sessions[0].modelId).toBe("claude-sonnet-4-6");
    expect(switchedBack.body.sessions[0].temperature).toBe(1);
    expect(switchedBack.body.sessions[0].thinkingMode).toBe("adaptive");
    expect(switchedBack.body.sessions[0].thinkingBudget).toBe(63999);
    expect(switchedBack.body.sessions[0].effort).toBe("high");
    expect(switchedBack.body.sessions[0].cacheTtl).toBe("1h");

    const switchedZai = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "glm-4.5" }).expect(200);
    expect(switchedZai.body.sessions[0].modelId).toBe("glm-4.5");
    expect(switchedZai.body.sessions[0].temperature).toBe(1);
    expect(switchedZai.body.sessions[0].thinkingMode).toBe("enabled");
    expect(switchedZai.body.sessions[0].thinkingBudget).toBeNull();
    expect(switchedZai.body.sessions[0].cacheTtl).toBe("off");

    const switchedGoogle = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "gemini-2.5-flash" }).expect(200);
    expect(switchedGoogle.body.sessions[0].modelId).toBe("gemini-2.5-flash");
    expect(switchedGoogle.body.sessions[0].temperature).toBe(1);
    expect(switchedGoogle.body.sessions[0].thinkingMode).toBe("enabled");
    expect(switchedGoogle.body.sessions[0].thinkingBudget).toBe(24576);
    expect(switchedGoogle.body.sessions[0].cacheTtl).toBe("off");

    const switchedGoogle25Pro = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "gemini-2.5-pro" }).expect(200);
    expect(switchedGoogle25Pro.body.sessions[0].modelId).toBe("gemini-2.5-pro");
    expect(switchedGoogle25Pro.body.sessions[0].temperature).toBe(1);
    // 2.5 Pro is thinkingAlwaysOn since 2026-06-12 (budget flags removed): the
    // session default falls through to off/null, which the runtime ignores —
    // it always requests visible dynamic thinking; the UI control is locked.
    expect(switchedGoogle25Pro.body.sessions[0].thinkingMode).toBe("off");
    expect(switchedGoogle25Pro.body.sessions[0].thinkingBudget).toBeNull();
    expect(switchedGoogle25Pro.body.sessions[0].cacheTtl).toBe("off");

    const switchedGoogle31 = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "gemini-3.1-pro-preview" }).expect(200);
    expect(switchedGoogle31.body.sessions[0].modelId).toBe("gemini-3.1-pro-preview");
    expect(switchedGoogle31.body.sessions[0].temperature).toBe(1);
    expect(switchedGoogle31.body.sessions[0].thinkingMode).toBe("enabled");
    expect(switchedGoogle31.body.sessions[0].thinkingBudget).toBeNull();
    expect(switchedGoogle31.body.sessions[0].effort).toBe("high");
    expect(switchedGoogle31.body.sessions[0].cacheTtl).toBe("off");

    const switchedOpenAi54 = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "gpt-5.4" }).expect(200);
    expect(switchedOpenAi54.body.sessions[0].modelId).toBe("gpt-5.4");
    expect(switchedOpenAi54.body.sessions[0].temperature).toBe(1);
    expect(switchedOpenAi54.body.sessions[0].thinkingMode).toBe("off");
    expect(switchedOpenAi54.body.sessions[0].thinkingBudget).toBeNull();
    expect(switchedOpenAi54.body.sessions[0].effort).toBe("xhigh");
    expect(switchedOpenAi54.body.sessions[0].cacheTtl).toBe("off");

    const switchedOpenAi5 = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "gpt-5" }).expect(200);
    expect(switchedOpenAi5.body.sessions[0].modelId).toBe("gpt-5");
    expect(switchedOpenAi5.body.sessions[0].temperature).toBe(1);
    expect(switchedOpenAi5.body.sessions[0].thinkingMode).toBe("off");
    expect(switchedOpenAi5.body.sessions[0].thinkingBudget).toBeNull();
    expect(switchedOpenAi5.body.sessions[0].effort).toBe("high");
    expect(switchedOpenAi5.body.sessions[0].cacheTtl).toBe("off");

    const updatedControls = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({
      temperature: 0.65,
      thinkingMode: "off",
      thinkingBudget: 2048,
      cacheTtl: "1h",
      autoScroll: true,
    }).expect(200);
    expect(updatedControls.body.sessions[0].temperature).toBe(0.65);
    expect(updatedControls.body.sessions[0].thinkingMode).toBe("off");
    expect(updatedControls.body.sessions[0].thinkingBudget).toBe(2048);
    expect(updatedControls.body.sessions[0].cacheTtl).toBe("off");
    expect(updatedControls.body.sessions[0].autoScroll).toBe(true);

    const switchedAnthropic = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "claude-haiku-4-5-20251001" }).expect(200);
    expect(switchedAnthropic.body.sessions[0].modelId).toBe("claude-haiku-4-5-20251001");
    expect(switchedAnthropic.body.sessions[0].temperature).toBe(0.65);
    expect(switchedAnthropic.body.sessions[0].thinkingMode).toBe("enabled");
    expect(switchedAnthropic.body.sessions[0].thinkingBudget).toBe(63999);
    expect(switchedAnthropic.body.sessions[0].effort).toBeNull();
    expect(switchedAnthropic.body.sessions[0].cacheTtl).toBe("1h");

    const updatedAnthropicCache = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ cacheTtl: "5m" }).expect(200);
    expect(updatedAnthropicCache.body.sessions[0].cacheTtl).toBe("5m");

    const switchedOpusBridge = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "claude-opus-4-8-bridge" }).expect(200);
    expect(switchedOpusBridge.body.sessions[0].modelId).toBe("claude-opus-4-8-bridge");
    expect(switchedOpusBridge.body.sessions[0].thinkingMode).toBe("adaptive");
    expect(switchedOpusBridge.body.sessions[0].effort).toBe("max");
    expect(switchedOpusBridge.body.sessions[0].cacheTtl).toBe("off");

    const switchedSonnetBridge = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "claude-sonnet-4-6-bridge" }).expect(200);
    expect(switchedSonnetBridge.body.sessions[0].modelId).toBe("claude-sonnet-4-6-bridge");
    expect(switchedSonnetBridge.body.sessions[0].thinkingMode).toBe("adaptive");
    expect(switchedSonnetBridge.body.sessions[0].thinkingBudget).toBe(63999);
    expect(switchedSonnetBridge.body.sessions[0].effort).toBe("max");
    expect(switchedSonnetBridge.body.sessions[0].cacheTtl).toBe("off");

    const switchedHaikuBridge = await agent.patch(`/api/workspace/sessions/${sessionId}`).send({ modelId: "claude-haiku-4-5-bridge" }).expect(200);
    expect(switchedHaikuBridge.body.sessions[0].modelId).toBe("claude-haiku-4-5-bridge");
    expect(switchedHaikuBridge.body.sessions[0].thinkingMode).toBe("enabled");
    expect(switchedHaikuBridge.body.sessions[0].thinkingBudget).toBe(63999);
    expect(switchedHaikuBridge.body.sessions[0].effort).toBeNull();
    expect(switchedHaikuBridge.body.sessions[0].cacheTtl).toBe("off");

    await agent.post(`/api/chat/sessions/${sessionId}/stream`).send({
      prompt: "Lantern oath in Ashenmoor",
      modelId: "gemini-2.5-flash",
    }).expect(200);

    const sessionSearch = await agent.get("/api/workspace/search").query({ q: "Revised" }).expect(200);
    expect(sessionSearch.body.results.some((result: { type: string; sessionId: string }) => result.type === "session" && result.sessionId === sessionId)).toBe(true);

    const messageSearch = await agent.get("/api/workspace/search").query({ q: "lantern" }).expect(200);
    expect(messageSearch.body.results.some((result: { type: string; sessionId: string; excerpt: string }) => result.type === "message" && result.sessionId === sessionId && result.excerpt.toLowerCase().includes("lantern"))).toBe(true);

    const deleted = await agent.delete(`/api/workspace/sessions/${sessionId}`).expect(200);
    expect(deleted.body.sessions.find((session: { id: string }) => session.id === sessionId)?.deletedAt).toBeTruthy();
    expect(deleted.body.preferences.activeSessionId).not.toBe(sessionId);

    const hiddenFromSearch = await agent.get("/api/workspace/search").query({ q: "lantern" }).expect(200);
    expect(hiddenFromSearch.body.results).toEqual([]);

    const restored = await agent.post(`/api/workspace/sessions/${sessionId}/restore`).expect(200);
    expect(restored.body.sessions[0].deletedAt).toBeNull();

    const cleared = await agent.patch("/api/workspace/preferences").send({ activeSessionId: null }).expect(200);
    expect(cleared.body.preferences.activeSessionId).toBeNull();

    await agent.delete(`/api/workspace/sessions/${sessionId}`).expect(200);
    const removed = await agent.delete(`/api/workspace/sessions/${sessionId}/permanent`).expect(200);
    expect(removed.body.sessions.some((session: { id: string }) => session.id === sessionId)).toBe(false);
    expect(removed.body.preferences.activeSessionId).not.toBe(sessionId);

    const secondSession = await agent.post("/api/workspace/sessions").send({ name: "Part 2" }).expect(201);
    const secondSessionId = String(secondSession.body.sessions[0].id);
    await agent.delete(`/api/workspace/sessions/${secondSessionId}`).expect(200);
    const emptied = await agent.delete("/api/workspace/recycle-bin").expect(200);
    expect(emptied.body.sessions.filter((session: { deletedAt: string | null }) => session.deletedAt)).toEqual([]);

    const expiredSession = await agent.post("/api/workspace/sessions").send({ name: "Expired Part" }).expect(201);
    const expiredSessionId = String(expiredSession.body.sessions[0].id);
    await agent.delete(`/api/workspace/sessions/${expiredSessionId}`).expect(200);
    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const expiredDeletedAt = new Date(Date.now() - (31 * 24 * 60 * 60 * 1000)).toISOString();
    db.update(sessions).set({ deletedAt: expiredDeletedAt, updatedAt: expiredDeletedAt }).where(eq(sessions.id, expiredSessionId)).run();
    sqlite.close();

    const autoPurged = await agent.get("/api/workspace").expect(200);
    expect(autoPurged.body.sessions.some((session: { id: string }) => session.id === expiredSessionId)).toBe(false);
  });
});
