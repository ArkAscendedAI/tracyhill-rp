import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabaseClient, campaigns, customEndpoints, messages, migrateDatabase, pipelineRuns, sessions, users } from "@tracyhill-rp/db";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { PipelineWorker } from "./pipelineWorker";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function seedSessionWithMessages(db: ReturnType<typeof createDatabaseClient>["db"], userId: string, campaignId: string, sessionId: string) {
  const now = new Date().toISOString();
  const userExists = db.select().from(users).all().some(u => u.id === userId);
  if (!userExists) {
    db.insert(users).values({ id: userId, username: userId, passwordHash: "x", role: "user", createdAt: now, updatedAt: now }).run();
  }
  db.insert(sessions).values({
    id: sessionId,
    userId,
    sessionType: "standard",
    campaignId,
    name: "Part 1",
    modelId: "claude-opus-4-6",
    messageCount: 2,
    createdAt: now,
    updatedAt: now,
  }).run();
  db.insert(messages).values([
    { id: "msg-1", sessionId, userId, role: "user", content: "The ranger approached the tavern.", sortOrder: 0, createdAt: now, updatedAt: now },
    { id: "msg-2", sessionId, userId, role: "assistant", content: "The wooden door creaked as you pushed it open.", sortOrder: 1, createdAt: now, updatedAt: now },
  ]).run();
}

describe("pipeline worker", () => {
  it("completes with no-op when no messages exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(campaigns).values({
      id: "campaign-1",
      userId: "user-1",
      name: "Ashenmoor",
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "Chronicle the kingdom.",
      version: 4,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(pipelineRuns).values({
      id: "run-1",
      userId: "user-1",
      campaignId: "campaign-1",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    }).run();
    sqlite.close();

    const worker = new PipelineWorker(dbFile);
    const ran = await worker.runNext();
    expect(ran).toBe(true);

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const completed = verifyDb.select().from(pipelineRuns).get();
    expect(completed?.status).toBe("completed");
    expect(completed?.summary).toBe("No new messages to audit.");
    verifySqlite.close();
  });

  it("produces analysis and lorebook operations when a runtime is provided", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(campaigns).values({
      id: "campaign-2",
      userId: "user-2",
      name: "Blackglass",
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "Chronicle Blackglass.",
      version: 2,
      createdAt: now,
      updatedAt: now,
    }).run();
    seedSessionWithMessages(db, "user-2", "campaign-2", "session-2");
    db.insert(pipelineRuns).values({
      id: "run-2",
      userId: "user-2",
      campaignId: "campaign-2",
      sessionId: "session-2",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    }).run();
    sqlite.close();

    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        callbacks.onStart();
        const prompt = input.messages.at(-1)?.content ?? "";
        const text = prompt.includes("<current_system_prompt>")
          ? "ADD continuity rule about Blackglass tides."
          : "Analysis complete.\n## Pipeline Update Draft\nBlackglass output.";
        callbacks.onDelta(text);
        callbacks.onComplete({
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null },
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
        });
      },
    };

    const worker = new PipelineWorker(dbFile, { runtime });
    const ran = await worker.runNext();
    expect(ran).toBe(true);

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const completed = verifyDb.select().from(pipelineRuns).all().find((run) => run.id === "run-2");
    const details = JSON.parse(String(completed?.detailsJson)) as {
      steps: { syspromptUpdate: { result: string } };
      review: { systemPromptDraft: string; watermarkAfter: number | null };
    };
    expect(details.steps.syspromptUpdate.result).toContain("ADD continuity rule");
    expect(details.review.systemPromptDraft).toContain("ADD continuity rule");
    expect(details.review.watermarkAfter).toBe(1);
    verifySqlite.close();
  });

  it("resolves configured custom-endpoint pipeline models for summaries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(customEndpoints).values({
      id: "ep_pipe001",
      userId: "user-custom",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "openrouter-secret",
      apiFormat: "chat-completions",
      authHeader: "Bearer",
      modelsJson: JSON.stringify([{ id: "openrouter/sonnet", label: "OpenRouter Sonnet", maxOut: 8192, ctx: 200000 }]),
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(campaigns).values({
      id: "campaign-custom",
      userId: "user-custom",
      name: "Custom Harbor",
      pipelineModelId: "custom:ep_pipe001:openrouter/sonnet",
      systemPrompt: "Chronicle the harbor.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    seedSessionWithMessages(db, "user-custom", "campaign-custom", "session-custom");
    db.insert(pipelineRuns).values({
      id: "run-custom",
      userId: "user-custom",
      campaignId: "campaign-custom",
      sessionId: "session-custom",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    }).run();
    sqlite.close();

    const runtime: ChatRuntime = {
      async streamChat(_input, callbacks) {
        callbacks.onStart();
        callbacks.onDelta("Custom endpoint draft.");
        callbacks.onComplete({
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null },
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
        });
      },
    };

    const worker = new PipelineWorker(dbFile, { runtime });
    const ran = await worker.runNext();
    expect(ran).toBe(true);

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const completed = verifyDb.select().from(pipelineRuns).all().find((run) => run.id === "run-custom");
    expect(completed?.status).toBe("completed");
    expect(completed?.summary).toContain("OpenRouter Sonnet");
    verifySqlite.close();
  });

  it("completes with partial-failure guidance when sysprompt step fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(campaigns).values({
      id: "campaign-4",
      userId: "user-4",
      name: "Gloamreach",
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "Chronicle Gloamreach.",
      version: 3,
      createdAt: now,
      updatedAt: now,
    }).run();
    seedSessionWithMessages(db, "user-4", "campaign-4", "session-4");
    db.insert(pipelineRuns).values({
      id: "run-4",
      userId: "user-4",
      campaignId: "campaign-4",
      sessionId: "session-4",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    }).run();
    sqlite.close();

    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        callbacks.onStart();
        const prompt = input.messages.at(-1)?.content ?? "";
        if (prompt.includes("<current_system_prompt>")) throw new Error("system prompt apply exploded");
        callbacks.onDelta("Analysis complete.");
        callbacks.onComplete({
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null },
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
        });
      },
    };

    const worker = new PipelineWorker(dbFile, { runtime });
    const ran = await worker.runNext();
    expect(ran).toBe(true);

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const completed = verifyDb.select().from(pipelineRuns).all().find((run) => run.id === "run-4");
    expect(completed?.status).toBe("completed");
    verifySqlite.close();
  });

  it("cancels a running pipeline run when aborted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(campaigns).values({
      id: "campaign-3",
      userId: "user-3",
      name: "Frostfall",
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "Chronicle Frostfall.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    seedSessionWithMessages(db, "user-3", "campaign-3", "session-3");
    db.insert(pipelineRuns).values({
      id: "run-3",
      userId: "user-3",
      campaignId: "campaign-3",
      sessionId: "session-3",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    }).run();
    sqlite.close();

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

    const worker = new PipelineWorker(dbFile, { runtime });
    const running = worker.runNext();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(worker.cancelRun("run-3")).toBe(true);
    await running;

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const canceled = verifyDb.select().from(pipelineRuns).all().find((run) => run.id === "run-3");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.summary).toContain("pipeline run canceled");
    verifySqlite.close();
  });

  it("honors a database-backed cancel request from an external controller", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(campaigns).values({
      id: "campaign-5",
      userId: "user-5",
      name: "Greywake",
      pipelineModelId: "gemini-2.5-flash",
      systemPrompt: "Chronicle Greywake.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    seedSessionWithMessages(db, "user-5", "campaign-5", "session-5");
    db.insert(pipelineRuns).values({
      id: "run-5",
      userId: "user-5",
      campaignId: "campaign-5",
      sessionId: "session-5",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    }).run();
    sqlite.close();

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

    const worker = new PipelineWorker(dbFile, { runtime });
    const running = worker.runNext();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { db: cancelDb, sqlite: cancelSqlite } = createDatabaseClient(dbFile);
    cancelDb.update(pipelineRuns)
      .set({ status: "canceled", summary: "pipeline run canceled", error: "pipeline run canceled", completedAt: now, updatedAt: now })
      .where(eq(pipelineRuns.id, "run-5"))
      .run();
    cancelSqlite.close();
    await running;

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const canceled = verifyDb.select().from(pipelineRuns).all().find((run) => run.id === "run-5");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.summary).toContain("pipeline run canceled");
    verifySqlite.close();
  });
});
