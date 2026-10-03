import { readFileSync } from "node:fs";
import * as https from "node:https";

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  KimiServingInfoResponse,
  KimiServingMode,
  KimiServingProbeResponse,
  KimiServingSetResponse,
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
  kimiServingInfoResponseSchema,
  kimiServingProbeResponseSchema,
  kimiServingSetResponseSchema,
  claudeCodeMemoryWriteRequestSchema,
  claudeCodeMemoryWriteResponseSchema,
  claudeCodeMessagesResponseSchema,
  claudeCodeModeRequestSchema,
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
  claudeCodeUploadRequestSchema,
  claudeCodeUploadResponseSchema,
} from "@tracyhill-rp/contracts";

export type ClaudeCodeBridgeConfig = {
  host: string;
  port: number;
  secret: string;
  servername: string;
  caPath?: string;
  // Download name of a session export, `<prefix>-<first 8 of the id>.md`
  // (default "claude-code"; the Kimi bridge passes "kimi-code").
  exportFilePrefix?: string;
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
  // v2 control surface
  setMode(sessionId: string, payload: ClaudeCodeModeRequest): Promise<ClaudeCodeOkResponse>;
  approvePlan(sessionId: string): Promise<ClaudeCodeOkResponse>;
  rejectPlan(sessionId: string, payload: ClaudeCodeRejectPlanRequest): Promise<ClaudeCodeOkResponse>;
  context(sessionId: string): Promise<ClaudeCodeContextResponse>;
  compact(sessionId: string): Promise<ClaudeCodeOkResponse>;
  fork(sessionId: string, payload: ClaudeCodeForkRequest): Promise<ClaudeCodeForkResponse>;
  commands(sessionId?: string): Promise<ClaudeCodeCommandsResponse>;
  // Kimi-only serving control (the Claude/Codex agents don't implement these
  // routes; they're mounted only for the Kimi panel).
  servingInfo(): Promise<KimiServingInfoResponse>;
  servingProbe(mode: KimiServingMode): Promise<KimiServingProbeResponse>;
  setServing(sessionId: string, mode: KimiServingMode): Promise<KimiServingSetResponse>;
  isConfigured(): boolean;
  // Boot-time TLS diagnostics (optional so test mocks need not implement it) —
  // see ClaudeCodeBridgeService.configWarning.
  configWarning?(): string | null;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-store",
  "X-Accel-Buffering": "no",
} as const;

// Frames the agent service emits as end-of-stream markers: `done` closes a
// turn (live or replayed) and `stream_end` closes an idle session's replay. A
// 200 stream that ends without either is an upstream failure, never a clean
// close. Matched at line starts only; `data:` lines are single-line JSON so a
// literal newline before "event:" can only be a frame boundary.
const TERMINAL_FRAME_AT_START = /^event: (?:done|stream_end)\r?\n/;
const TERMINAL_FRAME_AFTER_NEWLINE = /\nevent: (?:done|stream_end)\r?\n/;
const TERMINAL_CARRY_CHARS = 32;

export function writeSseErrorFrame(res: ServerResponse, message: string, upstreamStatus: number | null) {
  if (!res.headersSent) res.writeHead(200, SSE_HEADERS);
  // `type` is explicit even though the web parser defaults it from the SSE
  // event name — Android keys on the JSON body alone.
  res.write(`event: error\ndata: ${JSON.stringify({ type: "error", message, upstreamStatus, source: "bridge-proxy" })}\n\n`);
  res.end();
}

export type ClaudeCodeSseRelay = {
  attach(upstream: IncomingMessage): void;
  fail(error: Error, upstreamStatus?: number): void;
  browserClosed(): void;
  terminalSeen(): boolean;
  readonly done: Promise<void>;
};

/**
 * Byte-transparent SSE relay for the panel stream, split out so the failure
 * paths are unit-testable against a fake upstream. A mid-stream upstream
 * error, the proxy's own inactivity timeout, and a clean
 * upstream close WITHOUT a terminal frame all used to end the browser's stream
 * with a bare `res.end()` — the web hook keys end-of-turn on `done`, so the
 * panel sat at "Working…" forever with no reconnect (the 2026-09-02 SDK-upgrade
 * restart did exactly this). Every one of those now emits an `event: error`
 * frame (message + upstream status where known) before ending, mirroring what
 * the non-200 branch always did.
 */
export function createClaudeCodeSseRelay(res: ServerResponse): ClaudeCodeSseRelay {
  let settled = false;
  let browserGone = false;
  let terminal = false;
  let carryAtStreamStart = true;
  let carry = "";
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveDone();
  };
  const fail = (error: Error, upstreamStatus?: number) => {
    if (settled) return;
    if (!browserGone) try { writeSseErrorFrame(res, error.message || "Claude Code bridge stream failed", upstreamStatus ?? null); } catch {}
    finish();
  };
  const trackTerminal = (chunk: Buffer) => {
    if (terminal) return;
    const text = carry + chunk.toString("utf8");
    if (TERMINAL_FRAME_AFTER_NEWLINE.test(text) || (carryAtStreamStart && TERMINAL_FRAME_AT_START.test(text))) terminal = true;
    carryAtStreamStart = carryAtStreamStart && text.length <= TERMINAL_CARRY_CHARS;
    carry = text.slice(-TERMINAL_CARRY_CHARS);
  };
  const attach = (upstream: IncomingMessage) => {
    if (settled) { upstream.resume(); return; }
    if (upstream.statusCode !== 200) {
      const chunks: Buffer[] = [];
      upstream.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      upstream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let message = `Claude Code error (${upstream.statusCode})`;
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {}
        fail(new Error(message), upstream.statusCode);
      });
      upstream.on("error", (error: Error) => fail(error, upstream.statusCode));
      return;
    }
    if (!browserGone) try { res.writeHead(200, SSE_HEADERS); } catch {}
    upstream.on("data", (chunk: Buffer) => {
      if (settled || browserGone) return;
      trackTerminal(chunk);
      let ok = true;
      try { ok = res.write(chunk); } catch { return; }
      // Backpressure to the browser (parity with the Codex proxy): a
      // WAN client slower than the LAN upstream throttles the pipe instead of
      // accumulating the replay in API memory.
      if (!ok) {
        upstream.pause();
        res.once("drain", () => { if (!browserGone && !settled) upstream.resume(); });
      }
    });
    upstream.on("end", () => {
      if (settled) return;
      if (!terminal) { fail(new Error("Claude Code bridge closed the stream without a done frame"), 200); return; }
      if (!browserGone) try { res.end(); } catch {}
      finish();
    });
    upstream.on("error", (error: Error) => fail(error, 200));
    upstream.on("aborted", () => fail(new Error("Claude Code bridge connection aborted"), 200));
    upstream.on("close", () => { if (!settled) fail(new Error("Claude Code bridge connection closed"), 200); });
  };
  return {
    attach,
    fail,
    browserClosed: () => { browserGone = true; finish(); },
    terminalSeen: () => terminal,
    done,
  };
}

export class ClaudeCodeBridgeService implements ClaudeCodeBridge {
  private readonly ca?: Buffer;
  private readonly caError: string | null = null;

  constructor(private readonly config: ClaudeCodeBridgeConfig) {
    // An unreadable CA used to throw here and take the whole API down at boot
    // for an admin-only panel. Record it instead: configWarning() surfaces it
    // as a boot system_event and ensureConfigured() fails every request with
    // the real reason rather than a bare "self-signed certificate" TLS error.
    if (config.caPath) {
      try { this.ca = readFileSync(config.caPath); }
      catch (error) { this.caError = `CA file unreadable (${config.caPath}): ${error instanceof Error ? error.message : String(error)}`; }
    }
  }

  // isConfigured() ignores the CA, but
  // with CLAUDE_CODE_CA_PATH / KIMI_CODE_CA_PATH unset (`ca: undefined`) or
  // unreadable, every TLS handshake to the self-signed agent fails at request
  // time with no boot signal. createApp records this as a warn system_event.
  configWarning(): string | null {
    if (!this.isConfigured()) return null; // the unconfigured case has its own boot event
    if (this.caError) return this.caError;
    if (!this.config.caPath) return `CA path is unset — TLS handshakes to the self-signed agent at ${this.config.host}:${this.config.port} will fail unless its certificate is in the system trust store`;
    return null;
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

  async fork(sessionId: string, payload: ClaudeCodeForkRequest) {
    return claudeCodeForkResponseSchema.parse(
      await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/fork`, claudeCodeForkRequestSchema.parse(payload)),
    );
  }

  async commands(sessionId?: string) {
    const path = sessionId ? `/sessions/${encodeURIComponent(sessionId)}/commands` : "/commands";
    return claudeCodeCommandsResponseSchema.parse(await this.jsonRequest("GET", path));
  }

  async servingInfo() {
    return kimiServingInfoResponseSchema.parse(await this.jsonRequest("GET", "/serving"));
  }

  async servingProbe(mode: KimiServingMode) {
    return kimiServingProbeResponseSchema.parse(await this.jsonRequest("POST", "/serving/probe", { mode }));
  }

  async setServing(sessionId: string, mode: KimiServingMode) {
    return kimiServingSetResponseSchema.parse(
      await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/serving`, { mode }),
    );
  }

  isConfigured() {
    return Boolean(this.config.host && this.config.port && this.config.secret);
  }

  async exportSession(sessionId: string, res: ServerResponse) {
    this.ensureConfigured();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let browserGone = false;
      const request = https.request({
        agent: false, // fresh socket per call; see jsonRequest
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
        // The API names the download for the panel it serves: both agent
        // services label every export
        // `claude-code-<id8>.md`, so forwarding their header saved Kimi
        // exports under the Claude name.
        const id8 = sessionId.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, "");
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${this.config.exportFilePrefix ?? "claude-code"}-${id8}.md"`,
        });
        upstream.on("data", (chunk: Buffer) => {
          if (browserGone) return;
          let ok = true;
          try { ok = res.write(chunk); } catch { return; }
          if (!ok) {
            upstream.pause();
            res.once("drain", () => { if (!browserGone) upstream.resume(); });
          }
        });
        upstream.on("end", () => {
          if (settled) return;
          settled = true;
          if (!browserGone) try { res.end(); } catch {}
          resolve();
        });
        upstream.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
      });
      // Browser disconnect stops the upstream export instead of letting it
      // flow into a dead response.
      res.once("close", () => {
        browserGone = true;
        if (!settled) { settled = true; try { request.destroy(); } catch {} resolve(); }
      });
      request.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
      request.setTimeout(60_000, () => request.destroy(new Error("export timeout")));
      request.end();
    });
  }

  async stream(sessionId: string, after: number, res: ServerResponse) {
    this.ensureConfigured();
    const relay = createClaudeCodeSseRelay(res);
    const request = https.request({
      agent: false, // fresh socket per call; see jsonRequest
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
    }, (upstream) => relay.attach(upstream));
    res.once("close", () => {
      relay.browserClosed();
      try { request.destroy(); } catch {}
    });
    request.on("error", (error) => relay.fail(error));
    // Socket-inactivity bound: the agent writes a transport-only `keepalive`
    // every 10s on a healthy stream (runQuery.js), so ten idle minutes is a
    // dead upstream — retune the bound from that number, not 15s. The relay is
    // failed BEFORE the destroy so the browser sees this message rather than
    // the generic abort the destroy raises afterwards.
    request.setTimeout(600_000, () => {
      relay.fail(new Error("Claude Code bridge timeout (10min)"));
      request.destroy();
    });
    request.end();
    await relay.done;
  }

  private async jsonRequest(method: string, path: string, body?: unknown) {
    this.ensureConfigured();
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise<unknown>((resolve, reject) => {
      const request = https.request({
        // Never reuse a pooled keep-alive socket (the treatment the Codex
        // bridge already had): the API
        // can block its event loop past the agent's 5 s idle lease, the agent
        // closes the pooled socket meanwhile, and the queued panel RPC then
        // fails with ECONNRESET on a healthy agent. These routes deliberately
        // never retry mutating calls, so a send/mode/answer surfaced as a
        // misleading transport error. A fresh connection per call keeps the
        // pinned CA and servername checks.
        agent: false,
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
    if (this.caError) throw new Error(`Claude Code bridge unavailable: ${this.caError}`);
  }

  private buildError(statusCode: number | undefined, raw: string) {
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error) return new Error(parsed.error);
    } catch {}
    return new Error(statusCode ? `Claude Code bridge error (${statusCode})` : "Claude Code bridge request failed");
  }
}
