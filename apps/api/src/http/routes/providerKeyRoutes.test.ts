import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { minimalUser } from "@tracyhill-rp/test-fixtures";

import { createApp } from "../../app/createApp";
import { createSeededTestDb } from "../../test/testDb";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  while (cleanups.length) cleanups.pop()?.();
});

describe("provider key routes", () => {
  it("lists, saves, and clears per-user provider-key overrides with server fallback visibility", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    process.env.OPENAI_API_KEY = "server-openai-key";
    process.env.DEEPSEEK_API_KEY = "server-deepseek-key";
    const { app } = createApp();
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const initial = await agent.get("/api/provider-keys").expect(200);
    expect(initial.body.providers.openai.source).toBe("server");
    expect(initial.body.providers.openai.configured).toBe(true);
    expect(initial.body.providers.openai.keyPreview).toBeNull();
    expect(initial.body.providers.deepseek.source).toBe("server");
    expect(initial.body.providers.deepseek.configured).toBe(true);
    expect(initial.body.providers.anthropic.source).toBe("none");
    expect(initial.body.customEndpoints).toEqual([]);

    const saved = await agent.put("/api/provider-keys").send({
      openai: "user-openai-secret",
      anthropic: "user-anthropic-secret",
      deepseek: "user-deepseek-secret",
      customEndpoints: [{
        id: "ep_abc12345",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiFormat: "chat-completions",
        authHeader: "Bearer",
        apiKey: "openrouter-secret",
        models: [{
          id: "openrouter/sonnet",
          label: "OpenRouter Sonnet",
          maxOut: 16384,
          ctx: 200000,
        }],
      }],
    }).expect(200);
    expect(saved.body.providers.openai.source).toBe("user");
    expect(saved.body.providers.openai.keyPreview).toBe("••••cret");
    expect(saved.body.providers.anthropic.source).toBe("user");
    expect(saved.body.providers.anthropic.keyPreview).toBe("••••cret");
    expect(saved.body.providers.deepseek.source).toBe("user");
    expect(saved.body.providers.deepseek.keyPreview).toBe("••••cret");
    expect(saved.body.customEndpoints).toHaveLength(1);
    expect(saved.body.customEndpoints[0].name).toBe("OpenRouter");
    expect(saved.body.customEndpoints[0].hasKey).toBe(true);
    expect(saved.body.customEndpoints[0].models[0].id).toBe("openrouter/sonnet");

    const cleared = await agent.put("/api/provider-keys").send({
      openai: null,
      deepseek: null,
      customEndpoints: [],
    }).expect(200);
    expect(cleared.body.providers.openai.source).toBe("server");
    expect(cleared.body.providers.deepseek.source).toBe("server");
    expect(cleared.body.providers.anthropic.source).toBe("user");
    expect(cleared.body.customEndpoints).toEqual([]);

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    const providerUpdate = audit.body.events.find((event: { action: string }) => event.action === "provider_keys.updated");
    expect(providerUpdate).toBeTruthy();
    expect(providerUpdate.metadata.customEndpointIds).toEqual([]);
    expect(providerUpdate.metadata.configuredProviders).toContain("anthropic");
  });
});
