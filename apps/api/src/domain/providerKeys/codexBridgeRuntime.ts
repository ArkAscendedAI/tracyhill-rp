import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";

import { readSseEvents, stripCacheSentinels, type ChatRuntime, foldEffortToLadder } from "@tracyhill-rp/provider-runtime";
import { getChatModel } from "@tracyhill-rp/model-catalog";


const CODEX_BRIDGE_SUFFIX = "-codex-bridge";
// Dead-stream backstop ABOVE the shared reader's 10-min per-read inactivity
// gate — NOT the working-call governor. It must clear the campaign audit's
// 120-min max-effort per-call deadline so long calls abort via withDeadline
// (classified resumable, checkpoint preserved) instead of a raw request
// destroy — the 2026-07-13 "EPIPE at the 35-min ceiling" failure class.
const CODEX_STREAM_TIMEOUT_MS = 130 * 60_000;

/**
 * The App Server effort for a composer/worker call. An explicit session effort
 * folds onto the model's ladder exactly like the direct Responses path
 * (`foldEffortToLadder`: an exact rung passes, a level above the top folds
 * DOWN to the nearest rung, a level below the floor folds UP to the floor).
 * It used to fold any out-of-ladder value UP to the catalog default — the
 * model's max — so a stale "none"/"minimal" PATCH ran at max on the bridge
 * while the same value ran at low/none on the direct twin. A null
 * effort keeps the catalog default (= the model's max under the max-defaults
 * rule; the hidden "medium" worker tier that once lived here is GONE since
 * 2026-07-14).
 */
export function resolveCodexBridgeEffort(model: { effortOptions?: readonly string[]; defaultEffort?: string }, effort: string | null | undefined): string {
  if (effort && model.effortOptions?.length) return foldEffortToLadder(effort as Parameters<typeof foldEffortToLadder>[0], model.effortOptions);
  return model.defaultEffort ?? "high";
}

// Where the `/v2/composer/messages` contract is served: since 2026-09-25 the
// subscription runner on the private Compose network (plain http, the user's id
// selects the sign-in), or an https sidecar with a pinned CA as before.
export type CodexBridgeConnection = {
  url: string;
  secret: string;
  userId?: string;
  caPath?: string;
  servername?: string;
};

export function createCodexBridgeChatRuntime(connection: CodexBridgeConnection | null | undefined): ChatRuntime | null {
  const rawUrl = connection?.url?.trim() ?? "";
  const secret = connection?.secret?.trim() ?? "";
  if (!rawUrl || !secret) return null;
  let target: URL;
  try { target = new URL(rawUrl); } catch { return null; }
  const isHttps = target.protocol === "https:";
  if (!isHttps && target.protocol !== "http:") return null;
  const config = {
    isHttps,
    hostname: target.hostname,
    port: target.port ? Number.parseInt(target.port, 10) : (isHttps ? 443 : 80),
    basePath: target.pathname.replace(/\/$/, ""),
    secret,
    userId: connection?.userId?.trim() || undefined,
    caPath: connection?.caPath?.trim() || undefined,
    servername: connection?.servername?.trim() || undefined,
  };
  let ca: Buffer | undefined;
  let caLoaded = false;

  return {
    async streamChat(input, callbacks) {
      const model = getChatModel(input.modelId);
      if (model?.provider !== "codex-bridge" || !input.modelId.endsWith(CODEX_BRIDGE_SUFFIX)) throw new Error("unsupported CodexBridge model");
      const wireModel = input.modelId.slice(0, -CODEX_BRIDGE_SUFFIX.length);
      // Explicit effort wins; the fallback is the catalog default (= the
      // model's max under the max-defaults rule). The short-lived hidden
      // "medium" worker tier that used to live here is GONE
      // (2026-07-14): it silently regressed the audit's refute judgment, and
      // reasoning depth must be visible and dialable, never tiered in a
      // runtime. Workers now pass explicit effort resolved from the Engine
      // panel's workerEffort dial (workerEffortFor, model-catalog); chat
      // requests always carried explicit effort from the ladder UI. The
      // deadline problem that motivated the tier is solved where it belonged:
      // the audit's own lane + 120-min per-call deadline.
      const effort = resolveCodexBridgeEffort(model, input.effort);
      // OpenAI fast mode on the bridge (session dial `openaiFastModeEnabled`,
      // 2026-09-09): the caller's speed:"fast" becomes the App Server service
      // tier the catalog records for this model (`priority` — "Fast" in the
      // live model list). Models without a tier (Spark) never send one; the
      // sidecar applies the tier only when the App Server still advertises it
      // and reports the APPLIED speed in the done event's usage, so a message
      // or run is stamped fast only when the provider actually ran fast.
      const serviceTier = input.speed === "fast" && model.fastServiceTier ? model.fastServiceTier : null;
      const payload = JSON.stringify({
        model: wireModel,
        systemPrompt: input.systemPrompt ? stripCacheSentinels(input.systemPrompt) : null,
        messages: input.messages,
        requestId: input.requestId,
        maxOutputTokens: input.maxOutputTokens ?? model.maxOutputTokens,
        effort,
        ...(serviceTier ? { serviceTier } : {}),
      });
      if (!caLoaded) {
        ca = config.caPath ? readFileSync(config.caPath) : undefined;
        caLoaded = true;
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let completed = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(totalTimeout);
          input.signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const request = (config.isHttps ? https : http).request({
          hostname: config.hostname,
          port: config.port,
          path: `${config.basePath}/v2/composer/messages`,
          method: "POST",
          // Synchronous context retrieval can delay socket I/O past the bridge's
          // keep-alive timeout. Use a fresh connection so an expired pooled
          // socket cannot drop this generation before response headers arrive.
          agent: false,
          ...(config.isHttps ? { ca, servername: config.servername } : {}),
          headers: {
            Authorization: `Bearer ${config.secret}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "X-Client-Request-Id": input.requestId,
            ...(config.userId ? { "X-RP-User-Id": config.userId } : {}),
          },
        }, async (response) => {
          try {
            if (response.statusCode !== 200) {
              const raw = await readBoundedResponse(response);
              finish(buildBridgeError(response.statusCode, raw));
              return;
            }
            // Shared reader (provider-runtime): buffer-level CRLF normalization
            // + the 10-min per-read inactivity gate, so a silently stalled
            // sidecar surfaces in minutes instead of riding the 35-min ceiling.
            for await (const event of readSseEvents(Readable.toWeb(response) as ReadableStream<Uint8Array>)) {
              if (event.name === "start") callbacks.onStart();
              else if (event.name === "text_delta") {
                const data = parseEvent<{ delta?: string }>(event.data);
                if (data.delta) callbacks.onDelta(data.delta);
              } else if (event.name === "thinking_delta") {
                const data = parseEvent<{ delta?: string }>(event.data);
                if (data.delta) callbacks.onThinkingDelta(data.delta);
              } else if (event.name === "done") {
                const data = parseEvent<Parameters<typeof callbacks.onComplete>[0]>(event.data);
                callbacks.onComplete(data);
                completed = true;
              } else if (event.name === "error") {
                const data = parseEvent<{ error?: string }>(event.data);
                throw new Error(data.error || "CodexBridge generation failed");
              }
            }
            finish(completed ? undefined : new Error("CodexBridge stream closed before completion"));
          } catch (error) {
            finish(error instanceof Error ? error : new Error("CodexBridge stream failed"));
          }
        });
        const onAbort = () => request.destroy(abortError());
        const totalTimeout = setTimeout(() => request.destroy(new Error("CodexBridge request timed out")), CODEX_STREAM_TIMEOUT_MS);
        request.on("error", (error) => finish(input.signal?.aborted ? abortError() : error));
        if (input.signal?.aborted) { onAbort(); return; }
        input.signal?.addEventListener("abort", onAbort, { once: true });
        request.end(payload);
      });
    },
  };
}

function parseEvent<T>(raw: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error("CodexBridge returned an invalid stream event"); }
}

async function readBoundedResponse(response: NodeJS.ReadableStream, maxBytes = 16_384) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - size;
    if (remaining <= 0) break;
    chunks.push(bytes.subarray(0, remaining));
    size += Math.min(bytes.length, remaining);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildBridgeError(statusCode: number | undefined, raw: string) {
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed.error) return new Error(parsed.error);
  } catch {}
  return new Error(statusCode ? `CodexBridge request failed (${statusCode})` : "CodexBridge request failed");
}

function abortError() {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}
