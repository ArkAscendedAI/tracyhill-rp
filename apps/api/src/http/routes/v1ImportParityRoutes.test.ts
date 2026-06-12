import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabaseClient, users } from "@tracyhill-rp/db";
import { createV1ImportProductionFixture } from "@tracyhill-rp/test-fixtures";
import type { ChatRuntime } from "@tracyhill-rp/provider-runtime";

import { createApp } from "../../app/createApp";
import { runV1Import } from "../../importer/v1Importer";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  while (cleanups.length) cleanups.pop()?.();
});

describe("imported-data parity routes", () => {
  it("verifies imported production-shaped data through authenticated route surfaces", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trp-v1-route-parity-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fixture = createV1ImportProductionFixture(dir);
    const dbFile = path.join(dir, "imported.sqlite");
    const imageDir = path.join(dir, "imported-images");

    runV1Import({ sourceDir: fixture.sourceDir, dbFile, imageDir });

    const seeded = createDatabaseClient(dbFile);
    cleanups.push(() => seeded.sqlite.close());
    seeded.db.update(users).set({
      passwordHash: bcrypt.hashSync("import-pass", 10),
      email: null,
      emailVerified: 0,
    }).where(eq(users.id, fixture.userId)).run();

    process.env.DB_FILE = dbFile;
    process.env.IMAGE_DIR = imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const seenPrompts: Array<string | null | undefined> = [];
    const runtime: ChatRuntime = {
      async streamChat(input, callbacks) {
        seenPrompts.push(input.systemPrompt);
        callbacks.onStart();
        callbacks.onDelta("Imported route reply.");
        callbacks.onComplete({
          usage: {
            inputTokens: 4,
            outputTokens: 5,
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
    const { app } = createApp({ chatRuntime: runtime });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: "legacy-admin",
      password: "import-pass",
    }).expect(200);

    const workspace = await agent.get("/api/workspace").expect(200);
    expect(workspace.body.preferences.activeSessionId).toBe(fixture.standaloneSessionId);
    expect(workspace.body.folders).toHaveLength(2);
    expect(workspace.body.sessions).toHaveLength(2);
    expect(workspace.body.sessions).toEqual(expect.arrayContaining([expect.objectContaining({
      id: fixture.standaloneSessionId,
      folderId: fixture.folderChildId,
      modelId: "gpt-4.1",
    })]));

    const campaigns = await agent.get("/api/campaigns").expect(200);
    expect(campaigns.body.campaigns).toEqual([expect.objectContaining({
      id: fixture.campaignId,
      folderId: fixture.folderRootId,
      version: 4,
      pipelineModelId: `custom:${fixture.customEndpointId}:openrouter/sonnet`,
    })]);

    const versions = await agent.get(`/api/campaigns/${fixture.campaignId}/versions`).expect(200);
    expect(versions.body.versions.map((version: { version: number }) => version.version)).toEqual([4, 3]);

    const runs = await agent.get(`/api/pipeline/campaigns/${fixture.campaignId}/runs`).expect(200);
    expect(runs.body.runs).toEqual([expect.objectContaining({
      id: fixture.pipelineRunId,
      status: "completed",
      review: expect.objectContaining({
        systemPromptDraft: "Applied prompt draft",
      }),
    })]);

    const providerKeys = await agent.get("/api/provider-keys").expect(200);
    expect(providerKeys.body.providers.anthropic.source).toBe("user");
    expect(providerKeys.body.providers.openai.source).toBe("user");
    expect(providerKeys.body.customEndpoints).toEqual([expect.objectContaining({
      id: fixture.customEndpointId,
      name: "Legacy Endpoint",
      hasKey: true,
    })]);

    const standaloneDetail = await agent.get(`/api/chat/sessions/${fixture.standaloneSessionId}`).expect(200);
    expect(standaloneDetail.body.messages[0].attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ filename: "notes.md", mimeType: "text/markdown" }),
      expect.objectContaining({ filename: "scene.pdf", mimeType: "application/pdf" }),
    ]));
    expect(standaloneDetail.body.messages[1].generatedImages).toEqual([expect.objectContaining({
      id: fixture.imageId,
      mimeType: "image/png",
    })]);

    const importedCampaignDetail = await agent.get(`/api/chat/sessions/${fixture.campaignSessionId}`).expect(200);
    expect(importedCampaignDetail.body.campaign).toEqual(expect.objectContaining({
      id: fixture.campaignId,
      systemPrompt: "Campaign prompt",
    }));
    expect(importedCampaignDetail.body.messages).toHaveLength(1);

    const streamed = await agent.post(`/api/chat/sessions/${fixture.campaignSessionId}/stream`).send({
      prompt: "Continue imported route campaign.",
      modelId: `custom:${fixture.customEndpointId}:openrouter/sonnet`,
      attachments: [],
    }).expect(200);
    expect(streamed.text).toContain("response.started");
    expect(streamed.text).toContain("Imported route reply.");
    expect(seenPrompts).toHaveLength(1);
    expect(seenPrompts[0]).toContain("<<<TR_CACHE_BOUNDARY>>>\nCampaign prompt");
    expect(seenPrompts[0]).not.toContain("Campaign seed");

    const afterStream = await agent.get(`/api/chat/sessions/${fixture.campaignSessionId}`).expect(200);
    expect(afterStream.body.messages).toHaveLength(3);
    expect(afterStream.body.messages[2]).toEqual(expect.objectContaining({
      role: "assistant",
      content: "Imported route reply.",
      modelId: `custom:${fixture.customEndpointId}:openrouter/sonnet`,
    }));
  });
});
