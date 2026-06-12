import { readFileSync } from "node:fs";
import * as https from "node:https";

import type { ServerResponse } from "node:http";

import type {
  CodexMessagesResponse,
  CodexOutputResponse,
  CodexSendRequest,
  CodexSessionsResponse,
  CodexStatusResponse,
  CodexUploadRequest,
  CodexUploadResponse,
} from "@tracyhill-rp/contracts";
import {
  codexMessagesResponseSchema,
  codexOutputResponseSchema,
  codexSendRequestSchema,
  codexSessionsResponseSchema,
  codexStatusResponseSchema,
  codexUploadRequestSchema,
  codexUploadResponseSchema,
} from "@tracyhill-rp/contracts";

export type CodexBridgeConfig = {
  host: string;
  port: number;
  secret: string;
  servername: string;
  caPath?: string;
};

export interface CodexBridge {
  isConfigured(): boolean;
  getStatus(): Promise<CodexStatusResponse>;
  upload(payload: CodexUploadRequest): Promise<CodexUploadResponse>;
  listSessions(): Promise<CodexSessionsResponse>;
  getMessages(sessionId: string): Promise<CodexMessagesResponse>;
  getOutput(sessionId: string, itemId: string): Promise<CodexOutputResponse>;
  interrupt(sessionId: string): Promise<{ ok: true }>;
  deleteSession(sessionId: string): Promise<{ ok: true }>;
  streamSend(payload: CodexSendRequest, res: ServerResponse, onClose?: () => void): Promise<void>;
}

export class CodexBridgeService implements CodexBridge {
  private readonly ca?: Buffer;

  constructor(private readonly config: CodexBridgeConfig) {
    this.ca = config.caPath ? readFileSync(config.caPath) : undefined;
  }

  isConfigured() {
    return Boolean(this.config.host && this.config.port && this.config.secret);
  }

  async getStatus() {
    return codexStatusResponseSchema.parse(await this.jsonRequest("GET", "/status"));
  }

  async upload(payload: CodexUploadRequest) {
    return codexUploadResponseSchema.parse(await this.jsonRequest("POST", "/upload", codexUploadRequestSchema.parse(payload)));
  }

  async listSessions() {
    return codexSessionsResponseSchema.parse(await this.jsonRequest("GET", "/sessions"));
  }

  async getMessages(sessionId: string) {
    return codexMessagesResponseSchema.parse(await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/messages`));
  }

  async getOutput(sessionId: string, itemId: string) {
    return codexOutputResponseSchema.parse(await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}/output/${encodeURIComponent(itemId)}`));
  }

  async interrupt(sessionId: string) {
    await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/interrupt`);
    return { ok: true as const };
  }

  async deleteSession(sessionId: string) {
    await this.jsonRequest("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
    return { ok: true as const };
  }

  async streamSend(payload: CodexSendRequest, res: ServerResponse, onClose?: () => void) {
    this.ensureConfigured();
    const body = JSON.stringify(codexSendRequestSchema.parse(payload));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const request = https.request({
        hostname: this.config.host,
        port: this.config.port,
        path: "/sessions",
        method: "POST",
        ca: this.ca,
        servername: this.config.servername,
        // TLS hostname verification uses Node's default (checks CN/SAN vs servername)
        headers: {
          Authorization: `Bearer ${this.config.secret}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (upstream) => {
        if (upstream.statusCode !== 200) {
          const chunks: Buffer[] = [];
          upstream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          upstream.on("end", () => {
            if (settled) return;
            settled = true;
            reject(this.buildError(upstream.statusCode, Buffer.concat(chunks).toString("utf8")));
          });
          upstream.on("error", (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          });
          return;
        }
        res.writeHead(200, {
          "Content-Type": upstream.headers["content-type"] || "text/event-stream",
          "Cache-Control": "no-cache, no-store",
          "X-Accel-Buffering": "no",
        });
        upstream.on("data", (chunk) => {
          try { res.write(chunk); } catch {}
        });
        upstream.on("end", () => {
          if (settled) return;
          settled = true;
          try { res.end(); } catch {}
          resolve();
        });
        upstream.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
      request.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.setTimeout(600_000, () => request.destroy(new Error("Codex bridge timeout (10min)")));
      // Destroy the upstream when the browser disconnects — the codex agent
      // used to keep generating into a dead response for up to the full
      // 10-minute timeout per abandoned tab (claudeCode's stream already did
      // this; codex never did).
      res.once("close", () => {
        onClose?.();
        if (!settled) {
          settled = true;
          request.destroy();
          resolve();
        }
      });
      request.write(body);
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
            reject(new Error("Codex bridge returned invalid JSON"));
          }
        });
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(30_000, () => request.destroy(new Error("Codex bridge timeout")));
      if (payload) request.write(payload);
      request.end();
    });
  }

  private ensureConfigured() {
    if (!this.isConfigured()) throw new Error("Codex bridge unavailable");
  }

  private buildError(statusCode: number | undefined, raw: string) {
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error) return new Error(parsed.error);
    } catch {}
    return new Error(statusCode ? `Codex bridge error (${statusCode})` : "Codex bridge request failed");
  }
}
