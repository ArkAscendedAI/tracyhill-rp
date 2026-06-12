import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

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

describe("wizard routes", () => {
  it("persists templates, completes runs, approves campaigns, and supports retry", { timeout: 15000 }, async () => {
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

    const wizardSession = await agent.post("/api/workspace/sessions").send({ sessionType: "wizard" }).expect(201);
    const wizardSessionId = String(wizardSession.body.sessions[0].id);
    await agent.post(`/api/chat/sessions/${wizardSessionId}/stream`).send({
      prompt: "Call the campaign Ashenmoor Wizard. It should center on a grim city of ash and a haunted heir.",
      modelId: "gemini-2.5-flash",
    }).expect(200);

    const initialTemplates = await agent.get("/api/wizard/templates").expect(200);
    expect(String(initialTemplates.body.templates.exampleSystemPrompt)).toBeTruthy();

    const savedTemplates = await agent.put("/api/wizard/templates").send({
      exampleSystemPrompt: "Reference system prompt structure",
    }).expect(200);
    expect(savedTemplates.body.templates.exampleSystemPrompt).toBe("Reference system prompt structure");

    const enqueued = await agent.post("/api/wizard/runs").send({
      campaignName: "Ashenmoor Wizard",
      modelId: "gemini-2.5-flash",
      wizardSessionId,
    }).expect(201);
    expect(enqueued.body.runs).toHaveLength(1);
    expect(["queued", "running", "completed"]).toContain(enqueued.body.runs[0].status);
    expect(String(enqueued.body.runs[0].review.wizardTranscript)).toContain("Start the campaign wizard");
    expect(enqueued.body.runs[0].review.wizardSessionId).toBe(wizardSessionId);

    let latest = enqueued.body.runs[0];
    for (let attempt = 0; attempt < 20 && latest.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const next = await agent.get("/api/wizard/runs").expect(200);
      latest = next.body.runs[0];
    }

    expect(latest.status).toBe("completed");
    expect(String(latest.summary)).toContain("Wizard review prepared for Ashenmoor Wizard");
    expect(String(latest.summary)).toContain("Gemini 2.5 Flash");
    expect(String(latest.review.systemPromptDraft)).toContain("# Ashenmoor Wizard");
    expect(String(latest.review.wizardTranscript)).toContain("haunted heir");

    const approved = await agent.post(`/api/wizard/runs/${latest.id}/approve`).send({
      campaignName: "Ashenmoor Wizard Edited",
      systemPromptDraft: "# Ashenmoor Wizard System Prompt\n\nEdited system prompt for approval.",
    }).expect(200);
    expect(approved.body.runs[0].approvedAt).toBeTruthy();
    expect(String(approved.body.runs[0].summary)).toContain("created with Part 1 ready");
    expect(approved.body.runs[0].review.campaignName).toBe("Ashenmoor Wizard Edited");

    const campaigns = await agent.get("/api/campaigns").expect(200);
    expect(campaigns.body.campaigns).toHaveLength(1);
    expect(campaigns.body.campaigns[0].name).toBe("Ashenmoor Wizard Edited");
    expect(campaigns.body.campaigns[0].folderId).toBeTruthy();
    expect(campaigns.body.campaigns[0].systemPrompt).toContain("Edited system prompt for approval.");

    const workspace = await agent.get("/api/workspace").expect(200);
    expect(workspace.body.preferences.activeSessionId).toBeTruthy();
    expect(workspace.body.folders).toHaveLength(1);
    expect(workspace.body.folders[0].name).toBe("Ashenmoor Wizard Edited");
    expect(workspace.body.sessions[0].name).toBe("Ashenmoor Wizard Edited Part 1");
    expect(workspace.body.sessions[0].folderId).toBe(workspace.body.folders[0].id);
    expect(workspace.body.sessions.some((session: { id: string }) => session.id === wizardSessionId)).toBe(false);

    const retried = await agent.post(`/api/wizard/runs/${latest.id}/retry`).expect(201);
    expect(retried.body.runs).toHaveLength(2);
    expect(retried.body.runs[0].review.retriedFromRunId).toBe(latest.id);
    expect(String(retried.body.runs[0].review.wizardTranscript)).toContain("grim city of ash");

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string }) => event.action === "wizard.templates.updated")).toBe(true);
    expect(audit.body.events.some((event: { action: string; runId: string }) => event.action === "wizard.run.enqueued" && event.runId === latest.id)).toBe(true);
    expect(audit.body.events.some((event: { action: string; runId: string }) => event.action === "wizard.run.approved" && event.runId === latest.id)).toBe(true);
    expect(audit.body.events.some((event: { action: string; runId: string }) => event.action === "wizard.run.retried" && event.runId === retried.body.runs[0].id)).toBe(true);
  });

  it("lists active wizard runs and cancels a running wizard run", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const runtime: ChatRuntime = {
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
    const { app } = createApp({ wizardRuntime: runtime });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const enqueued = await agent.post("/api/wizard/runs").send({
      campaignName: "Cancel Wizard",
      modelId: "gemini-2.5-flash",
      brief: "A cursed harbor waits for dawn.",
      wizardTranscript: "### User\n\nA cursed harbor waits for dawn.\n",
    }).expect(201);
    const runId = String(enqueued.body.runs[0].id);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const active = await agent.get("/api/wizard/active").expect(200);
    expect(active.body.runs[0].id).toBe(runId);
    expect(["queued", "running"]).toContain(active.body.runs[0].status);

    const canceled = await agent.post(`/api/wizard/runs/${runId}/cancel`).expect(200);
    expect(["running", "canceled"]).toContain(canceled.body.runs[0].status);

    let latest = canceled.body.runs[0];
    for (let attempt = 0; attempt < 20 && latest.status !== "canceled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const next = await agent.get("/api/wizard/runs").expect(200);
      latest = next.body.runs[0];
    }

    expect(latest.status).toBe("canceled");
    expect(String(latest.summary)).toContain("wizard run canceled");

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string; runId: string }) => event.action === "wizard.run.canceled" && event.runId === runId)).toBe(true);
  });
});
