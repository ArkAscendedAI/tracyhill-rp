import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabaseClient, customEndpoints, migrateDatabase, wizardRuns, wizardTemplates } from "@tracyhill-rp/db";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { WizardWorker } from "./wizardWorker";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("wizard worker", () => {
  it("claims a queued run and completes all wizard documents", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-wizard-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(wizardTemplates).values({
      userId: "user-1",
      exampleSystemPrompt: "Reference system prompt structure",
      updatedAt: now,
    }).run();
    db.insert(wizardRuns).values({
      id: "wizard-run-1",
      userId: "user-1",
      modelId: "gemini-2.5-flash",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: JSON.stringify({
        steps: {
          systemPrompt: { status: "pending", result: null, error: null },
          lorebookCorpus: { status: "pending", result: null, error: null },
        },
        review: {
          campaignName: "Ashenmoor Wizard",
          brief: "A haunted heir returns to an ash-choked city.",
          wizardTranscript: "### User\n\nA haunted heir returns to an ash-choked city.\n\n### Assistant\n\nThe court is full of dangerous allies.",
          systemPromptDraft: null,
          approvedCampaignId: null,
          approvedSessionId: null,
          retriedFromRunId: null,
        },
      }),
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      approvedAt: null,
      updatedAt: now,
    }).run();
    sqlite.close();

    const worker = new WizardWorker(dbFile);
    const ran = await worker.runNext();
    expect(ran).toBe(true);

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const completed = verifyDb.select().from(wizardRuns).get();
    expect(completed?.status).toBe("completed");
    expect(completed?.summary).toContain("Wizard review prepared for Ashenmoor Wizard");
    expect(completed?.summary).toContain("Gemini 2.5 Flash");
    const details = JSON.parse(String(completed?.detailsJson)) as {
      steps: {
        systemPrompt: { status: string };
        lorebookCorpus: { status: string };
      };
      review: {
        wizardTranscript: string;
        systemPromptDraft: string;
      };
    };
    expect(details.steps.systemPrompt.status).toBe("completed");
    expect(details.steps.lorebookCorpus.status).toBe("completed");
    expect(details.review.wizardTranscript).toContain("dangerous allies");
    expect(details.review.systemPromptDraft).toContain("# Ashenmoor Wizard");
    verifySqlite.close();
  });

  it("cancels a running wizard run when aborted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-wizard-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(wizardTemplates).values({
      userId: "user-2",
      exampleSystemPrompt: "Reference system prompt structure",
      updatedAt: now,
    }).run();
    db.insert(wizardRuns).values({
      id: "wizard-run-2",
      userId: "user-2",
      modelId: "gemini-2.5-flash",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: JSON.stringify({
        steps: {
          systemPrompt: { status: "pending", result: null, error: null },
          lorebookCorpus: { status: "pending", result: null, error: null },
        },
        review: {
          campaignName: "Blackglass Wizard",
          brief: "A black harbor and a cursed court.",
          wizardTranscript: "### User\n\nA black harbor and a cursed court.\n",
          systemPromptDraft: null,
          approvedCampaignId: null,
          approvedSessionId: null,
          retriedFromRunId: null,
        },
      }),
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

    const worker = new WizardWorker(dbFile, { runtime });
    const running = worker.runNext();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(worker.cancelRun("wizard-run-2")).toBe(true);
    await running;

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const canceled = verifyDb.select().from(wizardRuns).all().find((run) => run.id === "wizard-run-2");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.summary).toContain("wizard run canceled");
    verifySqlite.close();
  });

  it("uses configured custom-endpoint wizard models in completion summaries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-wizard-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(customEndpoints).values({
      id: "ep_wizard1",
      userId: "user-3",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "openrouter-secret",
      apiFormat: "chat-completions",
      authHeader: "Bearer",
      modelsJson: JSON.stringify([{ id: "openrouter/sonnet", label: "OpenRouter Sonnet", maxOut: 8192, ctx: 200000 }]),
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(wizardTemplates).values({
      userId: "user-3",
      exampleSystemPrompt: "Reference system prompt structure",
      updatedAt: now,
    }).run();
    db.insert(wizardRuns).values({
      id: "wizard-run-3",
      userId: "user-3",
      modelId: "custom:ep_wizard1:openrouter/sonnet",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: JSON.stringify({
        steps: {
          systemPrompt: { status: "pending", result: null, error: null },
          lorebookCorpus: { status: "pending", result: null, error: null },
        },
        review: {
          campaignName: "Custom Wizard",
          brief: "A custom endpoint wizard run.",
          wizardTranscript: "### User\n\nA custom endpoint wizard run.\n",
          systemPromptDraft: null,
          approvedCampaignId: null,
          approvedSessionId: null,
          retriedFromRunId: null,
        },
      }),
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
        callbacks.onDelta("Custom endpoint wizard draft.");
        callbacks.onComplete({
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, speed: null },
          outputTruncated: false,
          stopReason: null,
          stopDetails: null,
        });
      },
    };

    const worker = new WizardWorker(dbFile, { runtime });
    const ran = await worker.runNext();
    expect(ran).toBe(true);

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const completed = verifyDb.select().from(wizardRuns).all().find((run) => run.id === "wizard-run-3");
    expect(completed?.status).toBe("completed");
    expect(completed?.summary).toContain("OpenRouter Sonnet");
    verifySqlite.close();
  });

  it("honors a database-backed cancel request from an external controller", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-wizard-worker-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbFile = path.join(dir, "test.sqlite");
    migrateDatabase(dbFile);
    const { db, sqlite } = createDatabaseClient(dbFile);
    const now = new Date().toISOString();
    db.insert(wizardTemplates).values({
      userId: "user-4",
      exampleSystemPrompt: "Reference system prompt structure",
      updatedAt: now,
    }).run();
    db.insert(wizardRuns).values({
      id: "wizard-run-4",
      userId: "user-4",
      modelId: "gemini-2.5-flash",
      status: "queued",
      summary: null,
      error: null,
      detailsJson: JSON.stringify({
        steps: {
          systemPrompt: { status: "pending", result: null, error: null },
          lorebookCorpus: { status: "pending", result: null, error: null },
        },
        review: {
          campaignName: "Greywake Wizard",
          brief: "A black tide rises.",
          wizardTranscript: "### User\n\nA black tide rises.\n",
          systemPromptDraft: null,
          approvedCampaignId: null,
          approvedSessionId: null,
          retriedFromRunId: null,
        },
      }),
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

    const worker = new WizardWorker(dbFile, { runtime });
    const running = worker.runNext();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { db: cancelDb, sqlite: cancelSqlite } = createDatabaseClient(dbFile);
    cancelDb.update(wizardRuns)
      .set({ status: "canceled", summary: "wizard run canceled", error: "wizard run canceled", completedAt: now, updatedAt: now })
      .where(eq(wizardRuns.id, "wizard-run-4"))
      .run();
    cancelSqlite.close();
    await running;

    const { db: verifyDb, sqlite: verifySqlite } = createDatabaseClient(dbFile);
    const canceled = verifyDb.select().from(wizardRuns).all().find((run) => run.id === "wizard-run-4");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.summary).toContain("wizard run canceled");
    verifySqlite.close();
  });
});
