import type { RequestHandler } from "express";
import type { Logger } from "pino";

import { childLogger, requestIdHeader } from "@tracyhill-rp/logging";

import { createId } from "../../lib/ids";

export function createRequestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId = req.header(requestIdHeader) ?? createId();
    const startedAt = Date.now();
    res.setHeader(requestIdHeader, requestId);
    const reqLogger = childLogger(logger, { requestId, method: req.method, path: req.path });
    (req as typeof req & { logger?: typeof reqLogger }).logger = reqLogger;
    reqLogger.info("request started");
    res.on("finish", () => {
      reqLogger.info({ statusCode: res.statusCode, durationMs: Date.now() - startedAt }, "request completed");
    });
    next();
  };
}
