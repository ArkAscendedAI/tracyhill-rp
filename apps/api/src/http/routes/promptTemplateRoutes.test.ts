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
  while (cleanups.length) cleanups.pop()?.();
});

describe("prompt template routes", () => {
  it("creates, updates, lists, and deletes per-user templates", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp();
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const initial = await agent.get("/api/prompt-templates").expect(200);
    expect(initial.body.templates).toEqual([]);

    const created = await agent.post("/api/prompt-templates").send({
      name: "Arrival Scene",
      content: "Describe the carriage arrival in second person.",
    }).expect(201);
    expect(created.body.templates).toHaveLength(1);
    expect(created.body.templates[0].name).toBe("Arrival Scene");
    const templateId = String(created.body.templates[0].id);

    const updated = await agent.put(`/api/prompt-templates/${templateId}`).send({
      name: "Arrival Scene Revised",
      content: "Describe the carriage arrival with sensory detail.",
    }).expect(200);
    expect(updated.body.templates[0].name).toBe("Arrival Scene Revised");
    expect(updated.body.templates[0].content).toContain("sensory detail");

    const listed = await agent.get("/api/prompt-templates").expect(200);
    expect(listed.body.templates).toHaveLength(1);
    expect(listed.body.templates[0].id).toBe(templateId);

    const removed = await agent.delete(`/api/prompt-templates/${templateId}`).expect(200);
    expect(removed.body.templates).toEqual([]);
  });
});
