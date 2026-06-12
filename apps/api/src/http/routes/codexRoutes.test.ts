import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerResponse } from "node:http";

import { minimalUser } from "@tracyhill-rp/test-fixtures";

import type { CodexBridge } from "../../domain/codex/codexBridgeService";
import { createApp } from "../../app/createApp";
import { createSeededTestDb } from "../../test/testDb";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  while (cleanups.length) cleanups.pop()?.();
});

class MockCodexBridge implements CodexBridge {
  isConfigured() { return true; }
  async getStatus() { return { ok: true as const, workspaces: [{ id: "default", name: "Home", cwd: "/tmp/work" }] }; }
  async upload() { return { path: "/tmp/work/upload.txt", name: "upload.txt" }; }
  async listSessions() { return [{ sessionId: "session-1", title: "Bridge Session", workspaceName: "Home", running: false }]; }
  async getMessages() { return [{ id: "user-1", type: "user" as const, content: "Inspect the repo", createdAt: new Date().toISOString() }]; }
  async getOutput() { return { output: "full command output" }; }
  async interrupt() { return { ok: true as const }; }
  async deleteSession() { return { ok: true as const }; }
  async streamSend(_payload: { prompt?: string }, res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: system\ndata: {\"type\":\"system\",\"sessionId\":\"session-1\",\"cwd\":\"/tmp/work\",\"workspaceId\":\"default\",\"workspaceName\":\"Home\",\"resumed\":false}\n\n");
    res.write("event: text\ndata: {\"type\":\"text\",\"id\":\"item-1\",\"content\":\"Working on it\"}\n\n");
    res.write("event: result\ndata: {\"type\":\"result\",\"sessionId\":\"session-1\",\"usage\":{\"input_tokens\":12,\"output_tokens\":34}}\n\n");
    res.end();
  }
}

describe("codex routes", () => {
  it("exposes admin-only codex bridge routes", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp({ codexBridge: new MockCodexBridge() });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    await agent.get("/api/codex/status").expect(200).expect(({ body }) => {
      expect(body.workspaces[0].id).toBe("default");
    });
    await agent.get("/api/codex/sessions").expect(200).expect(({ body }) => {
      expect(body[0].sessionId).toBe("session-1");
    });
    await agent.get("/api/codex/sessions/session-1/messages").expect(200).expect(({ body }) => {
      expect(body[0].content).toContain("Inspect");
    });
    await agent.get("/api/codex/sessions/session-1/output/item-1").expect(200).expect(({ body }) => {
      expect(body.output).toContain("full command output");
    });
    await agent.post("/api/codex/upload").send({ name: "notes.txt", data: "aGVsbG8=" }).expect(200);
    await agent.post("/api/codex/sessions/session-1/interrupt").expect(200);
    await agent.delete("/api/codex/sessions/session-1").expect(200);

    const streamed = await agent.post("/api/codex/send").send({ prompt: "Inspect the repo", workspaceId: "default" }).expect(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    expect(streamed.text).toContain("\"type\":\"system\"");
    expect(streamed.text).toContain("\"type\":\"result\"");

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string }) => event.action === "codex.uploaded")).toBe(true);
    expect(audit.body.events.some((event: { action: string }) => event.action === "codex.send_started")).toBe(true);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "codex.interrupted" && event.targetId === "session-1")).toBe(true);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "codex.deleted" && event.targetId === "session-1")).toBe(true);
  });

  it("surfaces bridge failures without crashing the route", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const brokenBridge: CodexBridge = {
      isConfigured: () => true,
      getStatus: async () => { throw new Error("Codex bridge unavailable"); },
      upload: async () => { throw new Error("Codex bridge unavailable"); },
      listSessions: async () => { throw new Error("Codex bridge unavailable"); },
      getMessages: async () => { throw new Error("Codex bridge unavailable"); },
      getOutput: async () => { throw new Error("Codex bridge unavailable"); },
      interrupt: async () => { throw new Error("Codex bridge unavailable"); },
      deleteSession: async () => { throw new Error("Codex bridge unavailable"); },
      streamSend: async () => { throw new Error("Codex bridge unavailable"); },
    };
    const { app } = createApp({ codexBridge: brokenBridge });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    await agent.get("/api/codex/status").expect(503).expect(({ body }) => {
      expect(body.error).toContain("unavailable");
    });
    await agent.post("/api/codex/send").send({ prompt: "Inspect the repo", workspaceId: "default" }).expect(502);
  });
});
