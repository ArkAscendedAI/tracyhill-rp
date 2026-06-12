import { createLogger } from "@tracyhill-rp/logging";

import { HttpError } from "../../lib/httpError";

import type { ErrorRequestHandler } from "express";
import type pino from "pino";

const fallbackLogger = createLogger("error-handler");

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
    logger.error({ err: error, path: req.path }, "error after headers sent");
    try { res.end(); } catch { /* socket already torn down */ }
    return;
  }
  if (error instanceof HttpError) {
    logger.warn({ statusCode: error.statusCode, path: req.path, msg: error.message }, "request rejected");
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error({ err: error, path: req.path }, "unhandled request error");
  res.status(500).json({ error: "internal server error" });
};
