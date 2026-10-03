import { readFileSync } from "node:fs";
import * as https from "node:https";

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  CodexAnswerRequest,
  CodexDoctorResponse,
  CodexFileSearchResponse,
  CodexForkRequest,
  CodexForkResponse,
  CodexMcpResponse,
  CodexOkResponse,
  CodexPatchRequest,
  CodexReviewRequest,
  CodexSendRequest,
  CodexSendResponse,
  CodexSessionMetadata,
  CodexSessionResponse,
  CodexSessionsResponse,
  CodexSettingsRequest,
  CodexSettingsResponse,
  CodexShellRequest,
  CodexSkillsResponse,
  CodexStatusResponse,
  CodexSteerRequest,
  CodexUploadRequest,
  CodexUploadResponse,
} from "@tracyhill-rp/contracts";
import {
  codexAnswerRequestSchema,
  codexDoctorResponseSchema,
  codexFileSearchResponseSchema,
  codexForkRequestSchema,
  codexForkResponseSchema,
  codexMcpResponseSchema,
  codexOkResponseSchema,
  codexPatchRequestSchema,
  codexReviewRequestSchema,
  codexSendRequestSchema,
  codexSendResponseSchema,
  codexSessionMetadataSchema,
  codexSessionResponseSchema,
  codexSessionsResponseSchema,
  codexSettingsRequestSchema,
  codexSettingsResponseSchema,
  codexShellRequestSchema,
  codexSkillsResponseSchema,
  codexStatusResponseSchema,
  codexSteerRequestSchema,
  codexUploadRequestSchema,
  codexUploadResponseSchema,
} from "@tracyhill-rp/contracts";

export type CodexBridgeConfig = { host: string; port: number; secret: string; servername: string; caPath?: string };

// An error built from a non-2xx sidecar response carries that response's status.
// The sidecar answers 404 for a session it no
// longer has; folding every failure into a plain Error left the routes able to
// say only 502/400, and the web's stream stop condition (401/403/404) never
// fired — a deleted session was retried forever. Transport failures (no
// response) carry no status. A plain property rather than a subclass so test
// doubles can throw `Object.assign(new Error(…), { upstreamStatus: 404 })`.
export type CodexBridgeError = Error & { upstreamStatus?: number };
export function codexUpstreamStatus(error: unknown): number | null {
  const status = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus;
  return typeof status === "number" ? status : null;
}

// Newest-N turn window for getSession. Root turns are what the transcript renders; descendant
// (subagent) threads are collapsed by default in the UI, so they get a much shallower slice —
// a fan-out session can carry 100+ descendants and their turns dominated the payload.
//
// A blank `CODEX_TURN_LIMIT=` (the natural edit of the commented .env.example line; env_file
// passes it verbatim) used to read as 0 through Number(""), so trimTurnWindow sliced `-0` =
// every turn while rootReturned = 0 marked every session truncated.
// Blank, unset, non-numeric, zero and negative all mean the default — the same
// trim-then-fallback rule as config/env.ts envNumber, plus positivity, kept as a pure helper so
// this domain module stays free of the config loader.
export function positiveLimit(raw: string | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
export const CODEX_TURN_LIMIT = positiveLimit(process.env.CODEX_TURN_LIMIT, 40);
export const CODEX_DESCENDANT_TURN_LIMIT = positiveLimit(process.env.CODEX_DESCENDANT_TURN_LIMIT, 4);

type LooseThread = { turns?: unknown[] } & Record<string, unknown>;

/**
 * Bound the turns a session response carries. Applied to the raw JSON before Zod parsing so an
 * un-upgraded sidecar's full-history payload never costs a 100k-turn schema walk, and so the
 * browser receives a bounded document either way. Newest turns are kept (the tail is what a
 * reader wants); `turnWindow` reports what was withheld so the UI can say so honestly.
 */
export function trimTurnWindow(raw: unknown, limit = CODEX_TURN_LIMIT, descendantLimit = CODEX_DESCENDANT_TURN_LIMIT): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const body = raw as { thread?: LooseThread; descendants?: LooseThread[]; turnWindow?: unknown };
  if (body.turnWindow) return raw; // sidecar already windowed it
  const rootTurns = Array.isArray(body.thread?.turns) ? body.thread!.turns! : [];
  const descendants = Array.isArray(body.descendants) ? body.descendants : [];
  const descendantTotal = descendants.reduce((sum, thread) => sum + (Array.isArray(thread?.turns) ? thread.turns!.length : 0), 0);
  const trimmedDescendants = descendants.map((thread) => {
    const turns = Array.isArray(thread?.turns) ? thread.turns! : [];
    return turns.length > descendantLimit ? { ...thread, turns: turns.slice(-descendantLimit) } : thread;
  });
  const descendantReturned = trimmedDescendants.reduce((sum, thread) => sum + (Array.isArray(thread?.turns) ? thread.turns!.length : 0), 0);
  const rootReturned = Math.min(rootTurns.length, limit);
  return {
    ...body,
    thread: body.thread ? { ...body.thread, turns: rootTurns.slice(-limit) } : body.thread,
    descendants: trimmedDescendants,
    turnWindow: {
      limit, descendantLimit,
      rootTotal: rootTurns.length, rootReturned,
      descendantTotal, descendantReturned,
      truncated: rootReturned < rootTurns.length || descendantReturned < descendantTotal,
    },
  };
}

export interface CodexBridge {
  isConfigured(): boolean;
  getStatus(): Promise<CodexStatusResponse>;
  upload(payload: CodexUploadRequest): Promise<CodexUploadResponse>;
  listSessions(): Promise<CodexSessionsResponse>;
  getSession(sessionId: string): Promise<CodexSessionResponse>;
  send(payload: CodexSendRequest): Promise<CodexSendResponse>;
  steer(sessionId: string, payload: CodexSteerRequest): Promise<CodexOkResponse>;
  updateSettings(sessionId: string, payload: CodexSettingsRequest): Promise<CodexSettingsResponse>;
  patchSession(sessionId: string, payload: CodexPatchRequest): Promise<CodexSessionMetadata>;
  interrupt(sessionId: string): Promise<CodexOkResponse>;
  deleteSession(sessionId: string): Promise<CodexOkResponse>;
  compact(sessionId: string): Promise<CodexOkResponse>;
  fork(sessionId: string, payload: CodexForkRequest): Promise<CodexForkResponse>;
  review(sessionId: string, payload: CodexReviewRequest): Promise<CodexSendResponse>;
  shell(sessionId: string, payload: CodexShellRequest): Promise<CodexOkResponse>;
  answer(sessionId: string, payload: CodexAnswerRequest): Promise<CodexOkResponse>;
  archive(sessionId: string): Promise<CodexOkResponse>;
  unarchive(sessionId: string): Promise<CodexOkResponse>;
  searchFiles(workspaceId: string, query: string): Promise<CodexFileSearchResponse>;
  listSkills(sessionId?: string): Promise<CodexSkillsResponse>;
  listMcp(sessionId?: string): Promise<CodexMcpResponse>;
  doctor(sessionId?: string): Promise<CodexDoctorResponse>;
  stream(sessionId: string, after: number, res: ServerResponse): Promise<void>;
  exportSession(sessionId: string, res: ServerResponse): Promise<void>;
  // Boot-time TLS diagnostics (optional so test mocks need not implement it).
  configWarning?(): string | null;
}

export class CodexBridgeService implements CodexBridge {
  private readonly ca?: Buffer;
  private readonly caError: string | null = null;
  private readonly prefix = "/v2";

  constructor(private readonly config: CodexBridgeConfig) {
    // An unreadable CA used to throw here and take the whole API down at boot
    // for an admin-only panel; record it and fail each request with the real
    // reason instead (see configWarning / ensureConfigured).
    if (config.caPath) {
      try { this.ca = readFileSync(config.caPath); }
      catch (error) { this.caError = `CA file unreadable (${config.caPath}): ${error instanceof Error ? error.message : String(error)}`; }
    }
  }

  isConfigured() { return Boolean(this.config.host && this.config.port && this.config.secret); }

  // isConfigured() ignores the CA, but
  // with CODEX_CA_PATH unset or unreadable every TLS handshake to the
  // self-signed sidecar fails at request time with no boot signal. createApp
  // records this as a warn system_event.
  configWarning(): string | null {
    if (!this.isConfigured()) return null; // the unconfigured case has its own boot event
    if (this.caError) return this.caError;
    if (!this.config.caPath) return `CA path is unset — TLS handshakes to the self-signed sidecar at ${this.config.host}:${this.config.port} will fail unless its certificate is in the system trust store`;
    return null;
  }

  async getStatus() { return codexStatusResponseSchema.parse(await this.jsonRequest("GET", "/status")); }
  async upload(payload: CodexUploadRequest) {
    return codexUploadResponseSchema.parse(await this.jsonRequest("POST", "/upload", codexUploadRequestSchema.parse(payload)));
  }
  async listSessions() { return codexSessionsResponseSchema.parse(await this.jsonRequest("GET", "/sessions")); }
  async getSession(sessionId: string) {
    const query = `?turnLimit=${CODEX_TURN_LIMIT}&descendantTurnLimit=${CODEX_DESCENDANT_TURN_LIMIT}`;
    // Timeout is raised above the 30s default because a sidecar that predates turnLimit still
    // serializes the whole thread; trimTurnWindow then bounds what reaches the browser. Once the
    // sidecar is restarted with turnLimit support the response is small and this never binds.
    const raw = await this.jsonRequest("GET", `/sessions/${encodeURIComponent(sessionId)}${query}`, undefined, 120_000);
    return codexSessionResponseSchema.parse(trimTurnWindow(raw));
  }
  async send(payload: CodexSendRequest) {
    return codexSendResponseSchema.parse(await this.jsonRequest("POST", "/sessions", codexSendRequestSchema.parse(payload), 120_000));
  }
  async steer(sessionId: string, payload: CodexSteerRequest) {
    return codexOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/steer`, codexSteerRequestSchema.parse(payload)));
  }
  async updateSettings(sessionId: string, payload: CodexSettingsRequest) {
    return codexSettingsResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/settings`, codexSettingsRequestSchema.parse(payload)));
  }
  async patchSession(sessionId: string, payload: CodexPatchRequest) {
    return codexSessionMetadataSchema.parse(await this.jsonRequest("PATCH", `/sessions/${encodeURIComponent(sessionId)}`, codexPatchRequestSchema.parse(payload)));
  }
  async interrupt(sessionId: string) {
    return codexOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/interrupt`));
  }
  async deleteSession(sessionId: string) {
    return codexOkResponseSchema.parse(await this.jsonRequest("DELETE", `/sessions/${encodeURIComponent(sessionId)}`));
  }
  async compact(sessionId: string) {
    return codexOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/compact`, undefined, 120_000));
  }
  async fork(sessionId: string, payload: CodexForkRequest) {
    return codexForkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/fork`, codexForkRequestSchema.parse(payload), 120_000));
  }
  async review(sessionId: string, payload: CodexReviewRequest) {
    return codexSendResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/review`, codexReviewRequestSchema.parse(payload), 120_000));
  }
  async shell(sessionId: string, payload: CodexShellRequest) {
    return codexOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/shell`, codexShellRequestSchema.parse(payload), 120_000));
  }
  async answer(sessionId: string, payload: CodexAnswerRequest) {
    return codexOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/answer`, codexAnswerRequestSchema.parse(payload)));
  }
  async archive(sessionId: string) {
    return codexOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/archive`));
  }
  async unarchive(sessionId: string) {
    return codexOkResponseSchema.parse(await this.jsonRequest("POST", `/sessions/${encodeURIComponent(sessionId)}/unarchive`));
  }
  async searchFiles(workspaceId: string, query: string) {
    return codexFileSearchResponseSchema.parse(await this.jsonRequest("GET", `/fs/search?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`));
  }
  async listSkills(sessionId?: string) {
    return codexSkillsResponseSchema.parse(await this.jsonRequest("GET", `/skills${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`));
  }
  async listMcp(sessionId?: string) {
    return codexMcpResponseSchema.parse(await this.jsonRequest("GET", `/mcp${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, undefined, 120_000));
  }
  async doctor(sessionId?: string) {
    return codexDoctorResponseSchema.parse(await this.jsonRequest("GET", `/doctor${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, undefined, 120_000));
  }

  async stream(sessionId: string, after: number, res: ServerResponse) {
    await this.proxyUpstream(`/sessions/${encodeURIComponent(sessionId)}/stream?after=${after}`, res, {
      buildHeaders: () => ({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      }),
      // The sidecar writes a keepalive comment every 10s on a healthy stream,
      // so a socket idle this long is genuinely dead — destroy it and let the
      // client reconnect instead of hanging (the old exec bridge bounded this
      // at 600s; the rebuild had dropped the bound entirely).
      idleTimeoutMs: 120_000,
      timeoutMessage: "Codex event stream idle timeout",
    });
  }

  async exportSession(sessionId: string, res: ServerResponse) {
    await this.proxyUpstream(`/sessions/${encodeURIComponent(sessionId)}/export`, res, {
      buildHeaders: (upstream) => ({
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": String(upstream.headers["content-disposition"] ?? `attachment; filename="codex-${sessionId.slice(0, 8)}.md"`),
      }),
      idleTimeoutMs: 60_000,
      timeoutMessage: "Codex export timeout",
    });
  }

  // One scaffold for both response-proxying surfaces — settled/browserGone
  // flags, non-200 error collection, header proxying, and the idle timeout
  // live here once so the two paths cannot drift (stream() had shipped
  // without the timeout exportSession() had).
  private proxyUpstream(
    path: string,
    res: ServerResponse,
    opts: { buildHeaders: (upstream: IncomingMessage) => Record<string, string>; idleTimeoutMs: number; timeoutMessage: string },
  ) {
    this.ensureConfigured();
    return new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      let browserGone = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolvePromise();
      };
      const request = this.request("GET", path, (upstream) => {
        if (upstream.statusCode !== 200) {
          const chunks: Buffer[] = [];
          upstream.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          upstream.on("end", () => finish(this.buildError(upstream.statusCode, Buffer.concat(chunks).toString("utf8"))));
          upstream.on("error", (error: Error) => finish(error));
          return;
        }
        res.writeHead(200, opts.buildHeaders(upstream));
        // Backpressure to the browser: a WAN client slower than the LAN
        // upstream must throttle the pipe, not accumulate the delta in API
        // memory.
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
          if (!browserGone) try { res.end(); } catch {}
          finish();
        });
        upstream.on("error", (error: Error) => finish(error));
      });
      res.once("close", () => {
        browserGone = true;
        if (!settled) { settled = true; request.destroy(); resolvePromise(); }
      });
      request.on("error", (error) => finish(error));
      request.setTimeout(opts.idleTimeoutMs, () => request.destroy(new Error(opts.timeoutMessage)));
      request.end();
    });
  }

  private async jsonRequest(method: string, path: string, body?: unknown, timeout = 30_000) {
    this.ensureConfigured();
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise<unknown>((resolvePromise, reject) => {
      const request = this.request(method, path, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) { reject(this.buildError(response.statusCode, raw)); return; }
          try { resolvePromise(raw ? JSON.parse(raw) : {}); }
          catch { reject(new Error("Codex bridge returned invalid JSON")); }
        });
        response.on("error", reject);
      }, payload);
      request.on("error", reject);
      request.setTimeout(timeout, () => request.destroy(new Error("Codex bridge timeout")));
      if (payload) request.write(payload);
      request.end();
    });
  }

  private request(method: string, path: string, handler: (response: IncomingMessage) => void, payload?: string | null) {
    return https.request({
      // The API can pause its event loop during synchronous retrieval. A pooled
      // bridge socket may expire before Node processes its close notification;
      // reuse then resets a panel RPC. Fresh sockets avoid ambiguous retries
      // of mutating actions while retaining the pinned CA and hostname checks.
      agent: false,
      hostname: this.config.host,
      port: this.config.port,
      path: `${this.prefix}${path}`,
      method,
      ca: this.ca,
      servername: this.config.servername,
      headers: {
        Authorization: `Bearer ${this.config.secret}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, handler);
  }

  private ensureConfigured() {
    if (!this.isConfigured()) throw new Error("Codex bridge unavailable");
    if (this.caError) throw new Error(`Codex bridge unavailable: ${this.caError}`);
  }

  private buildError(statusCode: number | undefined, raw: string): CodexBridgeError {
    let message = statusCode ? `Codex bridge error (${statusCode})` : "Codex bridge request failed";
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {}
    const error: CodexBridgeError = new Error(message);
    if (statusCode) error.upstreamStatus = statusCode;
    return error;
  }
}
