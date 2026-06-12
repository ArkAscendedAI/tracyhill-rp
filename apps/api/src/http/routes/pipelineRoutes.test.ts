import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { campaigns, createDatabaseClient, messages } from "@tracyhill-rp/db";
import { minimalUser } from "@tracyhill-rp/test-fixtures";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { createApp } from "../../app/createApp";
import { createSeededTestDb } from "../../test/testDb";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  delete process.env.MOCK_PROVIDER;
  while (cleanups.length) cleanups.pop()?.();
});

function seedMessages(dbFile: string, sessionId: string, userId: string) {
  const { db, sqlite } = createDatabaseClient(dbFile);
  const now = new Date().toISOString();
  db.insert(messages).values([
    { id: "msg-1", sessionId, userId, role: "user", content: "The ranger entered the tavern.", sortOrder: 0, createdAt: now, updatedAt: now },
    { id: "msg-2", sessionId, userId, role: "assistant", content: "The wooden door creaked open, revealing a dim interior.", sortOrder: 1, createdAt: now, updatedAt: now },
  ]).run();
  sqlite.close();
}

describe("pipeline routes", () => {
  it("enqueues, completes, and approves a campaign pipeline run", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.MOCK_PROVIDER = "1";
    const { app } = createApp();
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const folder = await agent.post("/api/workspace/folders").send({ name: "Ashenmoor Folder" }).expect(201);
    const folderId = String(folder.body.folders[0].id);

    const createdCampaign = await agent.post("/api/campaigns").send({
      name: "Ashenmoor",
      folderId,
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "You are the chronicler of Ashenmoor.",
    }).expect(201);
    const campaignId = String(createdCampaign.body.campaigns[0].id);
    expect(createdCampaign.body.campaigns[0].pipelineModelId).toBe("gemini-2.5-flash");
    const database = createDatabaseClient(seeded.dbFile);
    database.db.update(campaigns).set({ folderId }).where(eq(campaigns.id, campaignId)).run();

    const sourceSession = await agent.post(`/api/workspace/sessions/from-campaign/${campaignId}`).expect(201);
    const sourceSessionId = String(sourceSession.body.preferences.activeSessionId);
    seedMessages(seeded.dbFile, sourceSessionId, minimalUser.id);

    const enqueued = await agent.post(`/api/pipeline/campaigns/${campaignId}/runs`).expect(201);
    expect(enqueued.body.runs).toHaveLength(1);
    expect(["queued", "running", "completed"]).toContain(enqueued.body.runs[0].status);
    const activeDuringRun = await agent.get("/api/pipeline/active").expect(200);
    expect(activeDuringRun.body.runs).toHaveLength(1);
    expect(activeDuringRun.body.runs[0].campaignId).toBe(campaignId);
    expect(activeDuringRun.body.runs[0].campaignName).toBe("Ashenmoor");

    let latest = enqueued.body.runs[0];
    for (let attempt = 0; attempt < 20 && latest.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const next = await agent.get(`/api/pipeline/campaigns/${campaignId}/runs`).expect(200);
      latest = next.body.runs[0];
    }

    expect(latest.status).toBe("completed");
    expect(String(latest.summary)).toContain("Audit completed for Ashenmoor");
    expect(latest.review.systemPromptDraft).toBe("You are the chronicler of Ashenmoor.");
    expect(latest.review.watermarkAfter).toBe(1);
    expect(latest.approvedAt).toBeNull();

    const approved = await agent.post(`/api/pipeline/campaigns/${campaignId}/runs/${latest.id}/approve`).send({}).expect(200);
    expect(approved.body.runs[0].approvedAt).toBeTruthy();
    const activeAfterApproval = await agent.get("/api/pipeline/active").expect(200);
    expect(activeAfterApproval.body.runs).toHaveLength(0);

    const campaignsList = await agent.get("/api/campaigns").expect(200);
    expect(campaignsList.body.campaigns[0].version).toBe(1);
    const workspace = await agent.get("/api/workspace").expect(200);
    const session = workspace.body.sessions.find((s: { id: string }) => s.id === sourceSessionId);
    expect(session).toBeTruthy();
    expect(session.pipelineWatermark).toBe(1);

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string; runId: string }) => event.action === "pipeline.run.enqueued" && event.runId === latest.id)).toBe(true);
    expect(audit.body.events.some((event: { action: string; runId: string }) => event.action === "pipeline.run.approved" && event.runId === latest.id)).toBe(true);
  });

  it("captures auto-fix output and supports retrying a pipeline run", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.MOCK_PROVIDER = "1";
    const pipelineRuntime: ChatRuntime = {
      async streamChat(input, callbacks) {
        callbacks.onStart();
        const prompt = input.messages.at(-1)?.content ?? "";
        const text = prompt.includes("<current_system_prompt>")
          ? "ADD continuity rule about verified ash storms."
          : prompt.includes("<existing_lorebook_entries>")
            ? '[{"op":"NOOP"}]'
            : prompt.includes("<existing_anti_repetition_rules>")
              ? "[]"
              : "Analysis: multiple narrative drifts detected.";
        callbacks.onDelta(text);
        callbacks.onComplete({
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null },
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
        });
      },
    };
    const { app } = createApp({ pipelineRuntime });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const campaign = await agent.post("/api/campaigns").send({
      name: "Ashenmoor",
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "You are the chronicler of Ashenmoor.",
    }).expect(201);
    const campaignId = String(campaign.body.campaigns[0].id);

    const sourceSession = await agent.post(`/api/workspace/sessions/from-campaign/${campaignId}`).expect(201);
    const sourceSessionId = String(sourceSession.body.preferences.activeSessionId);
    seedMessages(seeded.dbFile, sourceSessionId, minimalUser.id);

    const enqueued = await agent.post(`/api/pipeline/campaigns/${campaignId}/runs`).expect(201);
    let latest = enqueued.body.runs[0];
    for (let attempt = 0; attempt < 20 && latest.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const next = await agent.get(`/api/pipeline/campaigns/${campaignId}/runs`).expect(200);
      latest = next.body.runs[0];
    }

    await agent.post(`/api/pipeline/campaigns/${campaignId}/runs/${latest.id}/approve`).expect(200);

    const retried = await agent.post(`/api/pipeline/campaigns/${campaignId}/runs/${latest.id}/retry`).send({ fromStep: "fromSysprompt" }).expect(201);
    expect(retried.body.runs).toHaveLength(2);
    expect(retried.body.runs[0].review.retriedFromRunId).toBe(latest.id);
    expect(retried.body.runs[0].review.retriedFromStep).toBe("fromSysprompt");
    let retriedLatest = retried.body.runs[0];
    for (let attempt = 0; attempt < 20 && retriedLatest.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const next = await agent.get(`/api/pipeline/campaigns/${campaignId}/runs`).expect(200);
      retriedLatest = next.body.runs[0];
    }
    expect(retriedLatest.summary).toContain("Retried from fromSysprompt");
    expect(retriedLatest.steps.syspromptUpdate.result).toContain("ADD continuity rule");
    expect(retriedLatest.review.systemPromptDraft).toContain("ADD continuity rule");

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string; runId: string }) => event.action === "pipeline.run.retried" && event.runId === retriedLatest.id)).toBe(true);
  });

  it("cancels a running pipeline run", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.MOCK_PROVIDER = "1";
    const delayedRuntime: ChatRuntime = {
      async streamChat(input, callbacks) {
        callbacks.onStart();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          input.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        callbacks.onDelta("unreachable");
        callbacks.onComplete({
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null },
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
        });
      },
    };
    const { app } = createApp({ pipelineRuntime: delayedRuntime });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const campaign = await agent.post("/api/campaigns").send({
      name: "Ashenmoor",
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "You are the chronicler of Ashenmoor.",
    }).expect(201);
    const campaignId = String(campaign.body.campaigns[0].id);

    const sourceSession = await agent.post(`/api/workspace/sessions/from-campaign/${campaignId}`).expect(201);
    const sourceSessionId = String(sourceSession.body.preferences.activeSessionId);
    seedMessages(seeded.dbFile, sourceSessionId, minimalUser.id);

    const enqueued = await agent.post(`/api/pipeline/campaigns/${campaignId}/runs`).expect(201);
    const runId = String(enqueued.body.runs[0].id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const canceled = await agent.post(`/api/pipeline/campaigns/${campaignId}/runs/${runId}/cancel`).expect(200);
    expect(["running", "canceled"]).toContain(canceled.body.runs[0].status);

    let latest = canceled.body.runs[0];
    for (let attempt = 0; attempt < 20 && latest.status !== "canceled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const next = await agent.get(`/api/pipeline/campaigns/${campaignId}/runs`).expect(200);
      latest = next.body.runs[0];
    }

    expect(latest.status).toBe("canceled");
    expect(String(latest.summary)).toContain("pipeline run canceled");
    const active = await agent.get("/api/pipeline/active").expect(200);
    expect(active.body.runs).toHaveLength(0);

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string; runId: string }) => event.action === "pipeline.run.canceled" && event.runId === runId)).toBe(true);
  });
});
