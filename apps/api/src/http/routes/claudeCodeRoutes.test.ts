import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerResponse } from "node:http";

import { minimalUser } from "@tracyhill-rp/test-fixtures";

import type { ClaudeCodeBridge } from "../../domain/claudeCode/claudeCodeBridgeService";
import { createApp } from "../../app/createApp";
import { createSeededTestDb } from "../../test/testDb";

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DB_FILE;
  delete process.env.IMAGE_DIR;
  delete process.env.SESSION_SECRET;
  while (cleanups.length) cleanups.pop()?.();
});

class MockClaudeCodeBridge implements ClaudeCodeBridge {
  async listSessions() { return [{ sessionId: "cc-1", title: "Story parity", active: false }]; }
  async getMessages() { return [{ type: "user", content: "Inspect the bridge" }, { type: "text", content: "Working on it" }]; }
  async getStatus() { return { active: true, queryKey: "query-1" }; }
  async upload() { return { path: "/tmp/cc.txt", name: "cc.txt" }; }
  async send() { return { queryKey: "query-1" }; }
  async interrupt() { return { ok: true as const }; }
  async deleteSession() { return { ok: true as const }; }
  async patchSession() { return { ok: true as const, title: "renamed" }; }
  async fsTree() { return { path: "/workspace", entries: [{ name: "projects", path: "/workspace/projects", kind: "dir" as const }] }; }
  async exportSession(_sessionId: string, res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end("# transcript");
  }
  async answer() { return { ok: true as const }; }
  async doctor(sessionId: string) {
    return {
      sessionId, found: true, status: "running", mode: "normal" as const,
      model: "claude-opus-4-7", effort: "max", cwd: "/workspace",
      additionalDirectories: ["/tmp"], disallowedTools: [], permissionMode: "bypassPermissions",
      thinking: "adaptive", sdkVersion: "0.2.117", startedAt: null, lastEventAt: null,
      eventCount: 0, lastError: null, subscribers: 0, pinned: false, title: null,
      researchAllowedTools: ["Read", "Glob", "Grep"],
    };
  }
  async memoryList() { return { files: [{ path: "/workspace/NOTES.md", name: "NOTES.md", size: 100 }] }; }
  async memoryRead(path: string) { return { path, content: "# doc" }; }
  async memoryWrite(payload: { path: string; content: string }) { return { ok: true as const, path: payload.path, size: payload.content.length }; }
  async rewind() { return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }; }
  async executePlan() { return { ok: true as const }; }
  async setMode() { return { ok: true as const }; }
  async approvePlan() { return { ok: true as const }; }
  async rejectPlan() { return { ok: true as const }; }
  async context() { return { totalTokens: 1000, maxTokens: 200000, categories: [{ name: "messages", tokens: 1000 }] }; }
  async compact() { return { ok: true as const }; }
  async setModel() { return { ok: true as const }; }
  async fork() { return { sessionId: "cc-fork-1" }; }
  async tasks() { return { tasks: [] }; }
  async commands() { return { commands: [], skills: [] }; }
  async suggestions() { return { suggestions: [] }; }
  async stream(_sessionId: string, _after: number, res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: system\ndata: {\"type\":\"system\",\"sessionId\":\"cc-1\",\"model\":\"claude-sonnet\",\"cwd\":\"/tmp/work\"}\n\n");
    res.write("event: text_delta\ndata: {\"type\":\"text_delta\",\"text\":\"Working\"}\n\n");
    res.write("event: done\ndata: {\"type\":\"done\"}\n\n");
    res.end();
  }
}

describe("claude code routes", () => {
  it("exposes admin-only Claude Code bridge routes", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const { app } = createApp({ claudeCodeBridge: new MockClaudeCodeBridge() });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    await agent.get("/api/claude-code/sessions").expect(200).expect(({ body }) => {
      expect(body[0].sessionId).toBe("cc-1");
    });
    await agent.get("/api/claude-code/sessions/cc-1/messages").expect(200).expect(({ body }) => {
      expect(body[1].content).toContain("Working");
    });
    await agent.get("/api/claude-code/sessions/cc-1/status").expect(200).expect(({ body }) => {
      expect(body.queryKey).toBe("query-1");
    });
    await agent.post("/api/claude-code/upload").send({ name: "notes.txt", data: "aGVsbG8=" }).expect(200);
    await agent.post("/api/claude-code/send").send({ prompt: "Inspect the bridge" }).expect(200).expect(({ body }) => {
      expect(body.queryKey).toBe("query-1");
    });
    const streamed = await agent.get("/api/claude-code/sessions/cc-1/stream?after=-1").expect(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    expect(streamed.text).toContain("text_delta");
    await agent.post("/api/claude-code/sessions/cc-1/interrupt").expect(200);
    await agent.delete("/api/claude-code/sessions/cc-1").expect(200);

    const audit = await agent.get("/api/admin/audit-events").expect(200);
    expect(audit.body.events.some((event: { action: string }) => event.action === "claude_code.uploaded")).toBe(true);
    expect(audit.body.events.some((event: { action: string }) => event.action === "claude_code.sent")).toBe(true);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "claude_code.interrupted" && event.targetId === "cc-1")).toBe(true);
    expect(audit.body.events.some((event: { action: string; targetId: string }) => event.action === "claude_code.deleted" && event.targetId === "cc-1")).toBe(true);
  });

  it("surfaces Claude bridge failures without crashing the route", async () => {
    const seeded = await createSeededTestDb();
    cleanups.push(seeded.cleanup);
    process.env.DB_FILE = seeded.dbFile;
    process.env.IMAGE_DIR = seeded.imageDir;
    process.env.SESSION_SECRET = "test-secret";
    const brokenBridge: ClaudeCodeBridge = {
      listSessions: async () => { throw new Error("Claude Code bridge unavailable"); },
      getMessages: async () => { throw new Error("Claude Code bridge unavailable"); },
      getStatus: async () => { throw new Error("Claude Code bridge unavailable"); },
      upload: async () => { throw new Error("Claude Code bridge unavailable"); },
      send: async () => { throw new Error("Claude Code bridge unavailable"); },
      interrupt: async () => { throw new Error("Claude Code bridge unavailable"); },
      deleteSession: async () => { throw new Error("Claude Code bridge unavailable"); },
      patchSession: async () => { throw new Error("Claude Code bridge unavailable"); },
      exportSession: async () => { throw new Error("Claude Code bridge unavailable"); },
      fsTree: async () => { throw new Error("Claude Code bridge unavailable"); },
      stream: async () => { throw new Error("Claude Code bridge unavailable"); },
      answer: async () => { throw new Error("Claude Code bridge unavailable"); },
      doctor: async () => { throw new Error("Claude Code bridge unavailable"); },
      memoryList: async () => { throw new Error("Claude Code bridge unavailable"); },
      memoryRead: async () => { throw new Error("Claude Code bridge unavailable"); },
      memoryWrite: async () => { throw new Error("Claude Code bridge unavailable"); },
      rewind: async () => { throw new Error("Claude Code bridge unavailable"); },
      executePlan: async () => { throw new Error("Claude Code bridge unavailable"); },
      setMode: async () => { throw new Error("Claude Code bridge unavailable"); },
      approvePlan: async () => { throw new Error("Claude Code bridge unavailable"); },
      rejectPlan: async () => { throw new Error("Claude Code bridge unavailable"); },
      context: async () => { throw new Error("Claude Code bridge unavailable"); },
      compact: async () => { throw new Error("Claude Code bridge unavailable"); },
      setModel: async () => { throw new Error("Claude Code bridge unavailable"); },
      fork: async () => { throw new Error("Claude Code bridge unavailable"); },
      tasks: async () => { throw new Error("Claude Code bridge unavailable"); },
      commands: async () => { throw new Error("Claude Code bridge unavailable"); },
      suggestions: async () => { throw new Error("Claude Code bridge unavailable"); },
    };
    const { app } = createApp({ claudeCodeBridge: brokenBridge });
    const agent = request.agent(app);

    await agent.post("/api/auth/login").send({
      username: minimalUser.username,
      password: minimalUser.password,
    }).expect(200);

    await agent.get("/api/claude-code/sessions").expect(503);
    await agent.post("/api/claude-code/send").send({ prompt: "Inspect the bridge" }).expect(400);
    await agent.get("/api/claude-code/sessions/cc-1/stream?after=-1").expect(502);
  });
});
