import pino from "pino";

export type LogBindings = Record<string, string | number | boolean | null | undefined>;

export const requestIdHeader = "x-request-id";

const redactions = [
  "req.headers.authorization",
  "req.headers.cookie",
  "password",
  "passwordHash",
  "session.secret",
  "session.cookie",
];

export function createLogger(name: string, bindings?: LogBindings) {
  return pino({
    name,
    redact: redactions,
    level: process.env.LOG_LEVEL ?? "info",
    base: bindings ?? undefined,
  });
}

export function childLogger(logger: pino.Logger, bindings: LogBindings) {
  return logger.child(bindings);
}
