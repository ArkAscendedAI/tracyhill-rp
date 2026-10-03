import { createLogger } from "@tracyhill-rp/logging";

import { HttpError } from "../../lib/httpError";
import { loggedPath } from "./requestLogger";

import type { ErrorRequestHandler } from "express";
import type pino from "pino";

const fallbackLogger = createLogger("error-handler");

// body-parser / raw-body errors (`entity.too.large` 413, `entity.parse.failed`
// 400, `encoding.unsupported` 415, ...) are plain Errors carrying `status`,
// `type` and `expose: true`. They are the CLIENT's fault and must be answered
// with their own status, not collapsed into a 500.
type ClientFaultError = { status: number; type?: string; expose?: boolean };

function asClientFault(error: unknown): ClientFaultError | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<ClientFaultError>;
  if (typeof candidate.status !== "number" || candidate.status < 400 || candidate.status >= 500) return null;
  if (candidate.expose !== true && typeof candidate.type !== "string") return null;
  return candidate as ClientFaultError;
}

const CLIENT_FAULT_MESSAGES: Record<number, string> = {
  400: "malformed request body",
  413: "request body too large",
  415: "unsupported request encoding",
};

// pino's err serializer copies every enumerable own property — for a parse
// failure that includes `body`, i.e. the raw request payload. On /api/auth/*
// that is a password. Log errors WITHOUT that field, always.
function redactErrorBody(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("body" in error)) return error;
  const { body: _body, ...rest } = error as Record<string, unknown> & { body?: unknown };
  const source = error as Partial<Error>;
  const redacted = new Error(typeof source.message === "string" ? source.message : "request error");
  Object.assign(redacted, rest, { stack: source.stack, name: source.name ?? "Error" });
  return redacted;
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  // Prefer the request-scoped child logger so errors correlate with the
  // request-start/finish lines via requestId (console.error lost that, and
  // 4xx HttpErrors were never logged at all — ownership/validation failures
  // were invisible server-side).
  const logger = ((req as unknown as { logger?: pino.Logger }).logger) ?? fallbackLogger;

  // If the response has already started (e.g., SSE stream that threw mid-flight),
  // we cannot set status/headers. Just end the connection -- the stream handler
  // is responsible for emitting its own response.error SSE frame if needed.
  if (res.headersSent) {
    logger.error({ err: redactErrorBody(error), path: loggedPath(req.path) }, "error after headers sent");
    try { res.end(); } catch { /* socket already torn down */ }
    return;
  }
  if (error instanceof HttpError) {
    logger.warn({ statusCode: error.statusCode, path: loggedPath(req.path), msg: error.message }, "request rejected");
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  const clientFault = asClientFault(error);
  if (clientFault) {
    logger.warn({ statusCode: clientFault.status, path: loggedPath(req.path), type: clientFault.type ?? null }, "request rejected");
    res.status(clientFault.status).json({ error: CLIENT_FAULT_MESSAGES[clientFault.status] ?? "invalid request" });
    return;
  }
  logger.error({ err: redactErrorBody(error), path: loggedPath(req.path) }, "unhandled request error");
  res.status(500).json({ error: "internal server error" });
};
