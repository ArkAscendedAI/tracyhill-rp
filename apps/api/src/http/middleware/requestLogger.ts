import type { RequestHandler } from "express";
import type { Logger } from "pino";

import { childLogger, requestIdHeader } from "@tracyhill-rp/logging";

import { createId } from "../../lib/ids";

// An invite link carries its secret token in the path (the web page /invite/<token> and the API's
// /api/auth/invites/<token>). Logs keep the route and drop the token, so whoever reads the logs cannot redeem an open
// invite.
const TOKEN_IN_PATH = /^(\/invite\/|\/api\/auth\/invites\/)[^/]+/;

/** A request path as the logs record it: secret tokens replaced. */
export function loggedPath(path: string): string {
  return path.replace(TOKEN_IN_PATH, "$1[token]");
}

// A client's x-request-id is kept when it is a short plain token (the web and Android clients send UUIDs). Anything
// else is replaced by a fresh id, so the logs and the audit rows never carry text a client made up.
const PLAIN_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function createRequestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const supplied = req.header(requestIdHeader);
    const requestId = supplied !== undefined && PLAIN_REQUEST_ID.test(supplied) ? supplied : createId();
    // Later readers of the header (the chat Stop key, the audit context) see the id the log carries.
    req.headers[requestIdHeader] = requestId;
    const startedAt = Date.now();
    res.setHeader(requestIdHeader, requestId);
    const reqLogger = childLogger(logger, { requestId, method: req.method, path: loggedPath(req.path) });
    (req as typeof req & { logger?: typeof reqLogger }).logger = reqLogger;
    reqLogger.info("request started");
    res.on("finish", () => {
      reqLogger.info({ statusCode: res.statusCode, durationMs: Date.now() - startedAt }, "request completed");
    });
    next();
  };
}
