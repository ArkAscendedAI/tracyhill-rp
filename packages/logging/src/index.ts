import pino from "pino";

export type LogBindings = Record<string, string | number | boolean | null | undefined>;

export const requestIdHeader = "x-request-id";

// Credential-shaped fields at the top level AND one level down (`*.x`): every
// logger.warn({ err, details }, …) call site passes objects it did not build —
// system-event `details`, provider error payloads, request summaries — so the
// list has to cover apiKey/token/secret/authorization, not just passwords.
// pino/fast-redact paths: `*` matches one level.
const SENSITIVE_KEYS = ["password", "passwordHash", "apiKey", "api_key", "token", "accessToken", "refreshToken", "secret", "authorization"];

const redactions = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "session.secret",
  "session.cookie",
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  ...SENSITIVE_KEYS.map((key) => `*.*.${key}`),
];

// `destination` is for tests (capture the serialized line); production always
// writes to stdout, which is what the container log driver reads.
export function createLogger(name: string, bindings?: LogBindings, destination?: pino.DestinationStream) {
  const options: pino.LoggerOptions = {
    name,
    redact: redactions,
    // An empty or blank LOG_LEVEL is unset: `??` kept
    // "", pino threw "default level: must be included in custom levels" and
    // both processes died at boot outside Docker (compose masks it with
    // `${LOG_LEVEL:-info}`). ENVIRONMENT.md promises empty means unset.
    level: process.env.LOG_LEVEL?.trim() || "info",
    base: bindings ?? undefined,
  };
  return destination ? pino(options, destination) : pino(options);
}

export function childLogger(logger: pino.Logger, bindings: LogBindings) {
  return logger.child(bindings);
}
