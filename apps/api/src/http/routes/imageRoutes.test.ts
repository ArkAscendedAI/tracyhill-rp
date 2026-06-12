import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createMockImageGenerationRuntime } from "@tracyhill-rp/provider-runtime";
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

describe("image routes", () => {
  it("generates a mocked image and returns it through the session detail + image route", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp({ imageRuntime: createMockImageGenerationRuntime() });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const workspace = await agent.post("/api/workspace/sessions").send({ name: "Part 1" }).expect(201);
    const sessionId = String(workspace.body.sessions[0].id);

    const generated = await agent.post(`/api/images/sessions/${sessionId}/generate`).send({
      prompt: "A red orb in darkness",
      modelId: "glm-image",
    }).expect(201);
    expect(generated.body.messages).toHaveLength(1);
    expect(generated.body.messages[0].modelId).toBe("glm-image");
    expect(generated.body.messages[0].generatedImages).toHaveLength(1);

    const imageId = String(generated.body.messages[0].generatedImages[0].id);
    const image = await agent.get(`/api/images/${imageId}`).expect(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.body.length).toBeGreaterThan(0);
  });
});
