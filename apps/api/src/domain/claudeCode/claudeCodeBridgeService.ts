import { readFileSync } from "node:fs";
import * as https from "node:https";

import type { ServerResponse } from "node:http";

import type {
  ClaudeCodeAnswerRequest,
  ClaudeCodeCommandsResponse,
  ClaudeCodeContextResponse,
  ClaudeCodeDoctorResponse,
  ClaudeCodeForkRequest,
  ClaudeCodeForkResponse,
  ClaudeCodeFsTreeResponse,
  ClaudeCodeMemoryListResponse,
  ClaudeCodeMemoryReadResponse,
  ClaudeCodeMemoryWriteRequest,
  ClaudeCodeMemoryWriteResponse,
  ClaudeCodeMessagesResponse,
  ClaudeCodeModeRequest,
  ClaudeCodeModelRequest,
  ClaudeCodeOkResponse,
  ClaudeCodePatchRequest,
  ClaudeCodePatchResponse,
  ClaudeCodeRejectPlanRequest,
  ClaudeCodeRewindRequest,
  ClaudeCodeRewindResponse,
  ClaudeCodeSendRequest,
  ClaudeCodeSendResponse,
  ClaudeCodeSessionsResponse,
  ClaudeCodeStatusResponse,
  ClaudeCodeSuggestionsResponse,
  ClaudeCodeTasksResponse,
  ClaudeCodeUploadRequest,
  ClaudeCodeUploadResponse,
} from "@tracyhill-rp/contracts";
import {
  claudeCodeAnswerRequestSchema,
  claudeCodeCommandsResponseSchema,
  claudeCodeContextResponseSchema,
  claudeCodeDoctorResponseSchema,
  claudeCodeForkRequestSchema,
  claudeCodeForkResponseSchema,
  claudeCodeFsTreeResponseSchema,
  claudeCodeMemoryListResponseSchema,
  claudeCodeMemoryReadResponseSchema,
  claudeCodeMemoryWriteRequestSchema,
  claudeCodeMemoryWriteResponseSchema,
  claudeCodeMessagesResponseSchema,
  claudeCodeModeRequestSchema,
  claudeCodeModelRequestSchema,
  claudeCodeOkResponseSchema,
  claudeCodePatchRequestSchema,
  claudeCodePatchResponseSchema,
  claudeCodeRejectPlanRequestSchema,
  claudeCodeRewindRequestSchema,
  claudeCodeRewindResponseSchema,
  claudeCodeSendRequestSchema,
  claudeCodeSendResponseSchema,
  claudeCodeSessionsResponseSchema,
  claudeCodeStatusResponseSchema,
  claudeCodeSuggestionsResponseSchema,
  claudeCodeTasksResponseSchema,
  claudeCodeUploadRequestSchema,
  claudeCodeUploadResponseSchema,
} from "@tracyhill-rp/contracts";

export type ClaudeCodeBridgeConfig = {
  host: string;
  port: number;
  secret: string;
  servername: string;
  caPath?: string;
};

export interface ClaudeCodeBridge {
  listSessions(): Promise<ClaudeCodeSessionsResponse>;
  getMessages(sessionId: string): Promise<ClaudeCodeMessagesResponse>;
  getStatus(sessionId: string): Promise<ClaudeCodeStatusResponse>;
  upload(payload: ClaudeCodeUploadRequest): Promise<ClaudeCodeUploadResponse>;
  send(payload: ClaudeCodeSendRequest): Promise<ClaudeCodeSendResponse>;
  interrupt(sessionId: string): Promise<ClaudeCodeOkResponse>;
  deleteSession(sessionId: string): Promise<ClaudeCodeOkResponse>;
  patchSession(sessionId: string, patch: ClaudeCodePatchRequest): Promise<ClaudeCodePatchResponse>;
  exportSession(sessionId: string, res: ServerResponse): Promise<void>;
  fsTree(path?: string): Promise<ClaudeCodeFsTreeResponse>;
  stream(sessionId: string, after: number, res: ServerResponse): Promise<void>;
  answer(sessionId: string, payload: ClaudeCodeAnswerRequest): Promise<ClaudeCodeOkResponse>;
  doctor(sessionId: string): Promise<ClaudeCodeDoctorResponse>;
  memoryList(): Promise<ClaudeCodeMemoryListResponse>;
  memoryRead(path: string): Promise<ClaudeCodeMemoryReadResponse>;
  memoryWrite(payload: ClaudeCodeMemoryWriteRequest): Promise<ClaudeCodeMemoryWriteResponse>;
  rewind(sessionId: string, payload: ClaudeCodeRewindRequest): Promise<ClaudeCodeRewindResponse>;
  executePlan(sessionId: string): Promise<ClaudeCodeOkResponse>;
  // v2 control surface
  setMode(sessionId: string, payload: ClaudeCodeModeRequest): Promise<ClaudeCodeOkResponse>;
  approvePlan(sessionId: string): Promise<ClaudeCodeOkResponse>;
  rejectPlan(sessionId: string, payload: ClaudeCodeRejectPlanRequest): Promise<ClaudeCodeOkResponse>;
  context(sessionId: string): Promise<ClaudeCodeContextResponse>;
  compact(sessionId: string): Promise<ClaudeCodeOkResponse>;
  setModel(sessionId: string, payload: ClaudeCodeModelRequest): Promise<ClaudeCodeOkResponse>;
  fork(sessionId: string, payload: ClaudeCodeForkRequest): Promise<ClaudeCodeForkResponse>;
  tasks(sessionId: string): Promise<ClaudeCodeTasksResponse>;
  commands(sessionId?: string): Promise<ClaudeCodeCommandsResponse>;
  suggestions(sessionId: string): Promise<ClaudeCodeSuggestionsResponse>;
}

export class ClaudeCodeBridgeService implements ClaudeCodeBridge {
  private readonly ca?: Buffer;

  constructor(private readonly config: ClaudeCodeBridgeConfig) {
    this.ca = config.caPath ? readFileSync(config.caPath) : undefined;
  }

  async listSessions() {
    return claudeCodeSessionsResponseSchema.parse(await this.jsonRequest("GET", "/sessions"));
  }

  async getMessages(sessionId: string) {
    return claudeCodeMessagesResponseSchema.parse(await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/messages`));
  }

  async getStatus(sessionId: string) {
    return claudeCodeStatusResponseSchema.parse(await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/status`));
  }

  async upload(payload: ClaudeCodeUploadRequest) {
    return claudeCodeUploadResponseSchema.parse(await this.jsonRequest("POST", "/upload", claudeCodeUploadRequestSchema.parse(payload)));
  }

  async send(payload: ClaudeCodeSendRequest) {
    return claudeCodeSendResponseSchema.parse(await this.jsonRequest("POST", "/sessions", claudeCodeSendRequestSchema.parse(payload)));
  }

  async interrupt(sessionId: string) {
    return claudeCodeOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/interrupt`));
  }

  async deleteSession(sessionId: string) {
    return claudeCodeOkResponseSchema.parse(await this.jsonRequest("DELETE", `/sessions/${encodeURIComponent(sessionId)}`));
  }

  async patchSession(sessionId: string, patch: ClaudeCodePatchRequest) {
    return claudeCodePatchResponseSchema.parse(
      await this.jsonRequest("PATCH", `/sessions/${encodeURIComponent(sessionId)}`, claudeCodePatchRequestSchema.parse(patch)),
    );
  }

  async fsTree(path?: string) {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    return claudeCodeFsTreeResponseSchema.parse(await this.jsonRequest("GET", `/fs/tree${qs}`));
  }

  async answer(sessionId: string, payload: ClaudeCodeAnswerRequest) {
    return claudeCodeOkResponseSchema.parse(
      await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/answer`, claudeCodeAnswerRequestSchema.parse(payload)),
    );
  }

  async doctor(sessionId: string) {
    return claudeCodeDoctorResponseSchema.parse(await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/doctor`));
  }

  async memoryList() {
    return claudeCodeMemoryListResponseSchema.parse(await this.jsonRequest("GET", "/memory"));
  }

  async memoryRead(path: string) {
    return claudeCodeMemoryReadResponseSchema.parse(await this.jsonRequest("GET", `/memory/read?path=${encodeURIComponent(path)}`));
  }

  async memoryWrite(payload: ClaudeCodeMemoryWriteRequest) {
    return claudeCodeMemoryWriteResponseSchema.parse(
      await this.jsonRequest("PUT", "/memory/write", claudeCodeMemoryWriteRequestSchema.parse(payload)),
    );
  }

  async rewind(sessionId: string, payload: ClaudeCodeRewindRequest) {
    return claudeCodeRewindResponseSchema.parse(
      await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/rewind`, claudeCodeRewindRequestSchema.parse(payload)),
    );
  }

  async executePlan(sessionId: string) {
    return claudeCodeOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/execute-plan`));
  }

  async setMode(sessionId: string, payload: ClaudeCodeModeRequest) {
    return claudeCodeOkResponseSchema.parse(
      await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/mode`, claudeCodeModeRequestSchema.parse(payload)),
    );
  }

  async approvePlan(sessionId: string) {
    return claudeCodeOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/approve-plan`));
  }

  async rejectPlan(sessionId: string, payload: ClaudeCodeRejectPlanRequest) {
    return claudeCodeOkResponseSchema.parse(
      await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/reject-plan`, claudeCodeRejectPlanRequestSchema.parse(payload)),
    );
  }

  async context(sessionId: string) {
    return claudeCodeContextResponseSchema.parse(await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/context`));
  }

  async compact(sessionId: string) {
    return claudeCodeOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/compact`));
  }

  async setModel(sessionId: string, payload: ClaudeCodeModelRequest) {
    return claudeCodeOkResponseSchema.parse(
      await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/model`, claudeCodeModelRequestSchema.parse(payload)),
    );
  }

  async fork(sessionId: string, payload: ClaudeCodeForkRequest) {
    return claudeCodeForkResponseSchema.parse(
      await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/fork`, claudeCodeForkRequestSchema.parse(payload)),
    );
  }

  async tasks(sessionId: string) {
    return claudeCodeTasksResponseSchema.parse(await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/tasks`));
  }

  async commands(sessionId?: string) {
    const path = sessionId ? `/sessions/${encodeURIComponent(sessionId)}/commands` : "/commands";
    return claudeCodeCommandsResponseSchema.parse(await this.jsonRequest("GET", path));
  }

  async suggestions(sessionId: string) {
    return claudeCodeSuggestionsResponseSchema.parse(await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/suggestions`));
  }

  async exportSession(sessionId: string, res: ServerResponse) {
    this.ensureConfigured();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const request = https.request({
        hostname: this.config.host,
        port: this.config.port,
        path: `/sessions/${encodeURIComponent(sessionId)}/export`,
        method: "GET",
        ca: this.ca,
        servername: this.config.servername,
        headers: { Authorization: `Bearer ${this.config.secret}` },
      }, (upstream) => {
        if (upstream.statusCode !== 200) {
          const chunks: Buffer[] = [];
          upstream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          upstream.on("end", () => {
            if (settled) return;
            settled = true;
            const raw = Buffer.concat(chunks).toString("utf8");
            try {
              const parsed = JSON.parse(raw) as { error?: string };
              reject(new Error(parsed.error || `export failed (${upstream.statusCode})`));
            } catch { reject(new Error(raw || `export failed (${upstream.statusCode})`)); }
          });
          upstream.on("error", reject);
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": upstream.headers["content-disposition"] ?? `attachment; filename="claude-code-${sessionId.slice(0, 8)}.md"`,
        });
        upstream.on("data", (chunk) => { try { res.write(chunk); } catch {} });
        upstream.on("end", () => {
          if (settled) return;
          settled = true;
          try { res.end(); } catch {}
          resolve();
        });
        upstream.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
      });
      request.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
      request.setTimeout(60_000, () => request.destroy(new Error("export timeout")));
      request.end();
    });
  }

  async stream(sessionId: string, after: number, res: ServerResponse) {
    this.ensureConfigured();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let browserGone = false;
      const request = https.request({
        hostname: this.config.host,
        port: this.config.port,
        path: `/sessions/${encodeURIComponent(sessionId)}/stream?after=${after}`,
        method: "GET",
        ca: this.ca,
        servername: this.config.servername,
        // TLS hostname verification uses Node's default (checks CN/SAN vs servername)
        headers: {
          Authorization: `Bearer ${this.config.secret}`,
          "Content-Type": "application/json",
        },
      }, (upstream) => {
        if (upstream.statusCode === 200) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
          });
          upstream.on("data", (chunk) => { if (!browserGone) try { res.write(chunk); } catch {} });
          upstream.on("end", () => {
            if (settled) return;
            settled = true;
            if (!browserGone) try { res.end(); } catch {}
            resolve();
          });
          upstream.on("error", (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
          return;
        }
        const chunks: Buffer[] = [];
        upstream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        upstream.on("end", () => {
          if (settled) return;
          settled = true;
          if (!browserGone) {
            try {
              res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store" });
              const raw = Buffer.concat(chunks).toString("utf8");
              let message = `Claude Code error (${upstream.statusCode})`;
              try {
                const parsed = JSON.parse(raw) as { error?: string };
                if (parsed.error) message = parsed.error;
              } catch {}
              res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
              res.end();
            } catch {}
          }
          resolve();
        });
        upstream.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
      res.once("close", () => {
        browserGone = true;
        try { request.destroy(); } catch {}
      });
      request.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.setTimeout(600_000, () => request.destroy(new Error("Claude Code bridge timeout (10min)")));
      request.end();
    });
  }

  private async jsonRequest(method: string, path: string, body?: unknown) {
    this.ensureConfigured();
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise<unknown>((resolve, reject) => {
      const request = https.request({
        hostname: this.config.host,
        port: this.config.port,
        path,
        method,
        ca: this.ca,
        servername: this.config.servername,
        // TLS hostname verification uses Node's default (checks CN/SAN vs servername)
        headers: {
          Authorization: `Bearer ${this.config.secret}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) return reject(this.buildError(response.statusCode, raw));
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            reject(new Error("Claude Code bridge returned invalid JSON"));
          }
        });
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(30_000, () => request.destroy(new Error("Claude Code bridge timeout")));
      if (payload) request.write(payload);
      request.end();
    });
  }

  private ensureConfigured() {
    if (!this.config.host || !this.config.port || !this.config.secret) throw new Error("Claude Code bridge unavailable");
  }

  private buildError(statusCode: number | undefined, raw: string) {
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error) return new Error(parsed.error);
    } catch {}
    return new Error(statusCode ? `Claude Code bridge error (${statusCode})` : "Claude Code bridge request failed");
  }
}
