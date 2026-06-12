import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createDatabaseClient, messages, sessions } from "@tracyhill-rp/db";
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

describe("admin routes", () => {
  it("reports storage stats and purges generated images across sessions", async () => {
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

    await agent.post(`/api/images/sessions/${sessionId}/generate`).send({
      prompt: "A red orb in darkness",
      modelId: "glm-image",
    }).expect(201);

    const before = await agent.get("/api/admin/storage").expect(200);
    expect(before.body.dataDir.imageCount).toBe(1);
    expect(before.body.dataDir.images).toBeGreaterThan(0);
    expect(before.body.dataDir.users).toBeGreaterThan(0);

    const purged = await agent.delete("/api/admin/images").expect(200);
    expect(purged.body.ok).toBe(true);
    expect(purged.body.deleted).toBe(1);

    const after = await agent.get("/api/admin/storage").expect(200);
    expect(after.body.dataDir.imageCount).toBe(0);
    expect(after.body.dataDir.images).toBe(0);

    const detail = await agent.get(`/api/chat/sessions/${sessionId}`).expect(200);
    expect(detail.body.messages[0].generatedImages).toEqual([]);

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string }) => event.action === "admin.storage.viewed")).toBe(true);
    expect(audit.body.events.some((event: { action: string; metadata: { deleted?: number } }) => event.action === "admin.images.purged" && event.metadata.deleted === 1)).toBe(true);
  });

  it("supports admin user management plus user session inspection", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp({ imageRuntime: createMockImageGenerationRuntime() });
    const adminAgent = request.agent(app);

    await adminAgent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    const listedBefore = await adminAgent.get("/api/admin/users").expect(200);
    expect(listedBefore.body.users).toHaveLength(1);

    const created = await adminAgent.post("/api/admin/users").send({
      username: "writer",
      password: "WriterPass9A",
      role: "user",
    }).expect(200);
    const createdUserId = String(created.body.user.id);
    expect(created.body.user.username).toBe("writer");
    expect(created.body.user.role).toBe("user");

    const userAgent = request.agent(app);
    await userAgent.post("/api/auth/login").send({
      username: "writer",
      password: "WriterPass9A",
    }).expect(200);
    const workspace = await userAgent.post("/api/workspace/sessions").send({ name: "Writer Session" }).expect(201);
    const sessionId = String(workspace.body.sessions[0].id);

    const { db, sqlite } = createDatabaseClient(seeded.dbFile);
    const now = new Date().toISOString();
    db.insert(messages).values({
      id: "message-admin-view",
      sessionId,
      userId: createdUserId,
      role: "user",
      content: "A hidden city wakes beneath the ash.",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    }).run();
    db.update(sessions).set({
      messageCount: 1,
      lastMessageAt: now,
      updatedAt: now,
    }).where(eq(sessions.id, sessionId)).run();
    sqlite.close();

    const listedAfter = await adminAgent.get("/api/admin/users").expect(200);
    const listedUser = listedAfter.body.users.find((entry: { id: string }) => entry.id === createdUserId);
    expect(listedUser.sessionCount).toBe(1);

    const sessionsResponse = await adminAgent.get(`/api/admin/users/${createdUserId}/sessions`).expect(200);
    expect(sessionsResponse.body.username).toBe("writer");
    expect(sessionsResponse.body.sessions).toHaveLength(1);
    expect(sessionsResponse.body.sessions[0].name).toBe("Writer Session");

    const detail = await adminAgent.get(`/api/admin/users/${createdUserId}/sessions/${sessionId}`).expect(200);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0].content).toContain("hidden city");

    await adminAgent.put(`/api/admin/users/${createdUserId}/role`).send({ role: "admin" }).expect(200);
    const elevated = await adminAgent.get("/api/admin/users").expect(200);
    expect(elevated.body.users.find((entry: { id: string }) => entry.id === createdUserId).role).toBe("admin");

    await adminAgent.put(`/api/admin/users/${createdUserId}/password`).send({ password: "ChangedPass9A" }).expect(200);
    await userAgent.post("/api/auth/logout").expect(200);
    await userAgent.post("/api/auth/login").send({
      username: "writer",
      password: "ChangedPass9A",
    }).expect(200);

    await adminAgent.delete(`/api/admin/users/${createdUserId}`).expect(200);
    await userAgent.post("/api/auth/logout").expect(200);
    await userAgent.post("/api/auth/login").send({
      username: "writer",
      password: "ChangedPass9A",
    }).expect(401);

    const audit = await adminAgent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "admin.user.created" && event.targetId === createdUserId)).toBe(true);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "admin.user.session_viewed" && event.targetId === sessionId)).toBe(true);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "admin.user.role_updated" && event.targetId === createdUserId)).toBe(true);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "admin.user.password_reset" && event.targetId === createdUserId)).toBe(true);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "admin.user.deleted" && event.targetId === createdUserId)).toBe(true);
  });
});
